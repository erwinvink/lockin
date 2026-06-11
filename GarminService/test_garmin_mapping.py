"""Tests for the pure Garmin mapping layer.

Fixtures mirror real Garmin Connect API response shapes as returned by
garminconnect==0.3.5 (cyberjunky/python-garminconnect):

- get_sleep_data       -> wellness-service dailySleep dict
- get_hrv_data         -> hrv-service dict (hrvSummary)
- get_body_battery     -> list of per-day dicts with bodyBatteryValuesArray
- get_training_readiness -> list of per-device dicts with "score"
- get_rhr_day          -> userstats-service dict (allMetrics.metricsMap)
- get_activities_by_date -> activitylist-service dicts

No network and no garminconnect import here or in garmin_mapping.
"""

import pytest

from garmin_mapping import build_workout, running_activity, wellness_day

# ---------------------------------------------------------------------------
# Wellness fixtures
# ---------------------------------------------------------------------------

SLEEP_JSON = {
    "dailySleepDTO": {
        "id": 1765244700000,
        "userProfilePK": 12345678,
        "calendarDate": "2026-06-09",
        "sleepTimeSeconds": 27360,
        "napTimeSeconds": 0,
        "sleepScores": {
            "totalDuration": {"qualifierKey": "GOOD"},
            "overall": {"value": 82, "qualifierKey": "GOOD"},
        },
    },
    "restingHeartRate": 49,
}

HRV_JSON = {
    "userProfilePk": 12345678,
    "hrvSummary": {
        "calendarDate": "2026-06-09",
        "weeklyAvg": 58,
        "lastNightAvg": 62,
        "lastNight5MinHigh": 71,
        "status": "BALANCED",
        "feedbackPhrase": "HRV_BALANCED_2",
    },
    "hrvReadings": [],
}

# Real production shape (verified live 2026-06-11): readings are
# [timestamp, level] PAIRS, self-described by bodyBatteryValueDescriptorDTOList.
BODY_BATTERY_JSON = [
    {
        "date": "2026-06-08",
        "charged": 41,
        "drained": 70,
        "bodyBatteryValuesArray": [
            [1765157100000, 55],
            [1765178700000, 30],
        ],
        "bodyBatteryValueDescriptorDTOList": [
            {"bodyBatteryValueDescriptorIndex": 0, "bodyBatteryValueDescriptorKey": "timestamp"},
            {"bodyBatteryValueDescriptorIndex": 1, "bodyBatteryValueDescriptorKey": "bodyBatteryLevel"},
        ],
    },
    {
        "date": "2026-06-09",
        "charged": 55,
        "drained": 12,
        "bodyBatteryValuesArray": [
            [1765243500000, 64],
            [1765250700000, 71],
            [1765247100000, 75],
        ],
        "bodyBatteryValueDescriptorDTOList": [
            {"bodyBatteryValueDescriptorIndex": 0, "bodyBatteryValueDescriptorKey": "timestamp"},
            {"bodyBatteryValueDescriptorIndex": 1, "bodyBatteryValueDescriptorKey": "bodyBatteryLevel"},
        ],
    },
]

# Older library docs showed 4-element readings with the level at index 2 and
# no descriptor list; the mapping must still understand that legacy shape.
BODY_BATTERY_LEGACY_JSON = [
    {
        "date": "2026-06-09",
        "bodyBatteryValuesArray": [
            [1765243500000, "MEASURED", 64, 1.0],
            [1765250700000, "MEASURED", 42, 1.0],
        ],
    },
]

READINESS_JSON = [
    {
        "userProfilePK": 12345678,
        "calendarDate": "2026-06-09",
        "timestamp": "2026-06-09T05:31:00.0",
        "deviceId": 3999999999,
        "level": "HIGH",
        "score": 78,
        "sleepScore": 82,
        "recoveryTime": 14,
    }
]

RHR_JSON = {
    "userProfileId": 12345678,
    "statisticsStartDate": "2026-06-09",
    "statisticsEndDate": "2026-06-09",
    "allMetrics": {
        "metricsMap": {
            "WELLNESS_RESTING_HEART_RATE": [
                {"value": 47.0, "calendarDate": "2026-06-09"}
            ]
        }
    },
    "groupedMetrics": None,
}

EXPECTED_KEYS = {
    "date",
    "sleepScore",
    "sleepSeconds",
    "hrvStatus",
    "hrvMs",
    "bodyBattery",
    "trainingReadiness",
    "restingHr",
}


class TestWellnessDay:
    def test_full_inputs(self):
        out = wellness_day(
            "2026-06-09",
            SLEEP_JSON,
            HRV_JSON,
            BODY_BATTERY_JSON,
            READINESS_JSON,
            RHR_JSON,
        )
        assert set(out.keys()) == EXPECTED_KEYS
        assert out["date"] == "2026-06-09"
        assert out["sleepScore"] == 82
        assert out["sleepSeconds"] == 27360
        assert out["hrvStatus"] == "BALANCED"
        assert out["hrvMs"] == 62
        # latest sample by timestamp for the matching date only (matches the
        # current level the Garmin app shows; not the 2026-06-08 entry, and not
        # the day's peak of 75)
        assert out["bodyBattery"] == 71
        assert out["trainingReadiness"] == 78
        assert out["restingHr"] == 47

    def test_body_battery_understands_legacy_four_element_readings(self):
        out = wellness_day("2026-06-09", None, None, BODY_BATTERY_LEGACY_JSON, None, None)
        # No descriptor list: 4-element readings carry the level at index 2,
        # and the latest timestamp wins (42, not 64).
        assert out["bodyBattery"] == 42

    def test_all_none_inputs_never_raise(self):
        out = wellness_day("2026-06-09", None, None, None, None, None)
        assert out == {
            "date": "2026-06-09",
            "sleepScore": 0,
            "sleepSeconds": 0,
            "hrvStatus": "",
            "hrvMs": 0,
            "bodyBattery": 0,
            "trainingReadiness": 0,
            "restingHr": 0,
        }

    def test_partial_and_malformed_inputs_never_raise(self):
        out = wellness_day(
            "2026-06-09",
            {"dailySleepDTO": {"sleepTimeSeconds": None, "sleepScores": None}},
            {"hrvSummary": None},
            [{"date": "2026-06-09"}],  # no values array
            [],  # readiness list empty
            {"allMetrics": {"metricsMap": {}}},
        )
        assert out["sleepScore"] == 0
        assert out["sleepSeconds"] == 0
        assert out["hrvStatus"] == ""
        assert out["hrvMs"] == 0
        assert out["bodyBattery"] == 0
        assert out["trainingReadiness"] == 0
        assert out["restingHr"] == 0

    def test_garbage_types_never_raise(self):
        out = wellness_day("2026-06-09", "oops", 42, {"not": "a list"}, "x", [1, 2])
        assert set(out.keys()) == EXPECTED_KEYS
        assert out["date"] == "2026-06-09"
        assert out["sleepScore"] == 0
        assert out["restingHr"] == 0

    def test_morning_readiness_dict_form(self):
        # get_morning_training_readiness returns a single dict, not a list
        out = wellness_day(
            "2026-06-09", None, None, None, {"score": 64, "level": "MODERATE"}, None
        )
        assert out["trainingReadiness"] == 64

    def test_resting_hr_falls_back_to_sleep_payload(self):
        out = wellness_day("2026-06-09", SLEEP_JSON, None, None, None, None)
        assert out["restingHr"] == 49

    def test_values_coerced_to_int(self):
        rhr = {
            "allMetrics": {
                "metricsMap": {
                    "WELLNESS_RESTING_HEART_RATE": [{"value": 46.6}]
                }
            }
        }
        out = wellness_day("2026-06-09", None, None, None, None, rhr)
        assert out["restingHr"] == 47
        assert isinstance(out["restingHr"], int)


# ---------------------------------------------------------------------------
# Activity fixtures
# ---------------------------------------------------------------------------


def make_activity(**overrides):
    base = {
        "activityId": 19519498613,
        "activityName": "Utrecht Hardlopen",
        "startTimeLocal": "2026-06-08 07:01:33",
        "startTimeGMT": "2026-06-08 05:01:33",
        "activityType": {
            "typeId": 1,
            "typeKey": "running",
            "parentTypeId": 17,
            "sortOrder": 3,
        },
        "eventType": {"typeId": 9, "typeKey": "uncategorized"},
        "distance": 12030.0,
        "duration": 4500.0,
        "elapsedDuration": 4620.0,
        "movingDuration": 4480.0,
        "elevationGain": 156.0,
        "elevationLoss": 150.0,
        "averageSpeed": 2.672,
        "averageHR": 148.0,
        "maxHR": 167.0,
    }
    base.update(overrides)
    return base


class TestRunningActivity:
    def test_full_running_activity(self):
        out = running_activity(make_activity())
        assert out == {
            "garminActivityId": "19519498613",
            "startTime": "2026-06-08 07:01:33",
            "activityType": "running",
            "distanceKm": 12.03,
            "movingSeconds": 4480,
            "elevationGainM": 156,
            "elevationLossM": 150,
            "averageHr": 148,
            "averagePaceSecPerKm": 374,  # 1000 / 2.672 m/s
            "name": "Utrecht Hardlopen",
        }

    @pytest.mark.parametrize(
        "type_key", ["trail_running", "ultra_run", "treadmill_running", "track_running"]
    )
    def test_running_variants_accepted(self, type_key):
        out = running_activity(
            make_activity(activityType={"typeId": 6, "typeKey": type_key})
        )
        assert out is not None
        assert out["activityType"] == type_key

    @pytest.mark.parametrize(
        "type_key", ["cycling", "walking", "lap_swimming", "strength_training", "hiking"]
    )
    def test_non_running_returns_none(self, type_key):
        assert (
            running_activity(
                make_activity(activityType={"typeId": 2, "typeKey": type_key})
            )
            is None
        )

    def test_pace_computed_from_distance_and_moving_time(self):
        out = running_activity(make_activity(averageSpeed=None))
        # 4480 s / 12.03 km = 372.4 -> 372
        assert out["averagePaceSecPerKm"] == 372

    def test_zero_distance_no_division_error(self):
        out = running_activity(
            make_activity(distance=0, averageSpeed=0, movingDuration=600)
        )
        assert out["distanceKm"] == 0
        assert out["averagePaceSecPerKm"] == 0

    def test_duration_fallback_when_moving_missing(self):
        out = running_activity(make_activity(movingDuration=None))
        assert out["movingSeconds"] == 4500

    def test_missing_fields_default(self):
        out = running_activity(
            {
                "activityId": 7,
                "activityType": {"typeKey": "running"},
            }
        )
        assert out == {
            "garminActivityId": "7",
            "startTime": "",
            "activityType": "running",
            "distanceKm": 0,
            "movingSeconds": 0,
            "elevationGainM": 0,
            "elevationLossM": 0,
            "averageHr": 0,
            "averagePaceSecPerKm": 0,
            "name": "",
        }

    def test_none_and_malformed_return_none(self):
        assert running_activity(None) is None
        assert running_activity({}) is None
        assert running_activity({"activityType": "running"}) is None  # no id
        assert running_activity("garbage") is None


# ---------------------------------------------------------------------------
# Workout builder
# ---------------------------------------------------------------------------


def make_payload(**overrides):
    base = {
        "sessionId": "sess-123",
        "title": "Tempo wedstrijdtempo",
        "date": "2026-06-12",
        "kind": "tempo",
        "distanceKm": 10.0,
        "durationMinutes": 60,
        "target": {"type": "pace", "low": 330, "high": 360},
        "notes": "Rustig insturen, laatste 2k vlot",
    }
    base.update(overrides)
    return base


def steps_of(workout):
    return workout["workoutSegments"][0]["workoutSteps"]


class TestBuildWorkout:
    def test_top_level_structure(self):
        w = build_workout(make_payload())
        assert w["workoutName"] == "Tempo wedstrijdtempo"
        assert w["description"] == "Rustig insturen, laatste 2k vlot"
        assert w["sportType"] == {
            "sportTypeId": 1,
            "sportTypeKey": "running",
            "displayOrder": 1,
        }
        assert w["estimatedDurationInSecs"] == 3600
        seg = w["workoutSegments"][0]
        assert seg["segmentOrder"] == 1
        assert seg["sportType"]["sportTypeKey"] == "running"

    @pytest.mark.parametrize("kind", ["long", "tempo", "intervals", "hills"])
    def test_hard_kinds_get_warmup_main_cooldown(self, kind):
        w = build_workout(make_payload(kind=kind))
        steps = steps_of(w)
        assert len(steps) == 3
        warmup, main, cooldown = steps
        assert warmup["stepType"]["stepTypeKey"] == "warmup"
        assert warmup["endCondition"]["conditionTypeKey"] == "time"
        assert warmup["endConditionValue"] == 600.0
        assert warmup["targetType"]["workoutTargetTypeKey"] == "no.target"
        assert main["stepType"]["stepTypeKey"] == "interval"
        assert cooldown["stepType"]["stepTypeKey"] == "cooldown"
        assert cooldown["endCondition"]["conditionTypeKey"] == "time"
        assert cooldown["endConditionValue"] == 300.0
        assert [s["stepOrder"] for s in steps] == [1, 2, 3]
        assert all(s["type"] == "ExecutableStepDTO" for s in steps)

    @pytest.mark.parametrize("kind", ["easy", "recovery"])
    def test_easy_kinds_get_single_steady_step(self, kind):
        w = build_workout(make_payload(kind=kind, target=None))
        steps = steps_of(w)
        assert len(steps) == 1
        (step,) = steps
        assert step["stepType"]["stepTypeKey"] == "interval"
        assert step["endCondition"]["conditionTypeKey"] == "distance"
        assert step["endConditionValue"] == 10000.0
        assert step["targetType"]["workoutTargetTypeKey"] == "no.target"

    def test_main_step_distance_end_condition_in_meters(self):
        w = build_workout(make_payload(distanceKm=21.1))
        main = steps_of(w)[1]
        assert main["endCondition"] == {
            "conditionTypeId": 1,
            "conditionTypeKey": "distance",
            "displayOrder": 1,
            "displayable": True,
        }
        assert main["endConditionValue"] == 21100.0

    def test_pace_target_converted_to_speed_bounds(self):
        """PINNED: pace low/high are sec-per-km with low = FASTER.

        Garmin speed.zone wants m/s with targetValueOne = LOW speed and
        targetValueTwo = HIGH speed. The faster pace bound (330 s/km) becomes
        the HIGHER speed bound (1000/330 ~= 3.0303 m/s); the slower pace bound
        (360 s/km) becomes the LOWER speed bound (1000/360 ~= 2.7778 m/s).
        """
        w = build_workout(
            make_payload(target={"type": "pace", "low": 330, "high": 360})
        )
        main = steps_of(w)[1]
        assert main["targetType"] == {
            "workoutTargetTypeId": 5,
            "workoutTargetTypeKey": "speed.zone",
            "displayOrder": 5,
        }
        assert main["targetValueOne"] == pytest.approx(1000 / 360, abs=1e-4)
        assert main["targetValueTwo"] == pytest.approx(1000 / 330, abs=1e-4)
        assert main["targetValueOne"] < main["targetValueTwo"]

    def test_pace_target_single_value_makes_band(self):
        # low == high still yields a valid (low <= high) speed band
        w = build_workout(make_payload(target={"type": "pace", "low": 345, "high": 345}))
        main = steps_of(w)[1]
        assert main["targetValueOne"] == pytest.approx(1000 / 345, abs=1e-4)
        assert main["targetValueTwo"] == pytest.approx(1000 / 345, abs=1e-4)

    def test_hr_target_passed_through_as_bpm(self):
        w = build_workout(make_payload(target={"type": "hr", "low": 138, "high": 152}))
        main = steps_of(w)[1]
        assert main["targetType"] == {
            "workoutTargetTypeId": 4,
            "workoutTargetTypeKey": "heart.rate.zone",
            "displayOrder": 4,
        }
        assert main["targetValueOne"] == 138.0
        assert main["targetValueTwo"] == 152.0

    def test_no_target(self):
        w = build_workout(make_payload(target=None))
        main = steps_of(w)[1]
        assert main["targetType"]["workoutTargetTypeKey"] == "no.target"
        assert "targetValueOne" not in main
        assert "targetValueTwo" not in main

    def test_time_fallback_when_no_distance(self):
        w = build_workout(make_payload(distanceKm=None, durationMinutes=60))
        main = steps_of(w)[1]
        assert main["endCondition"]["conditionTypeKey"] == "time"
        # 60 min minus 10 warmup minus 5 cooldown
        assert main["endConditionValue"] == 2700.0

    def test_estimated_duration_from_distance_when_no_duration(self):
        # easy 10 km without duration or target -> 6:00/km default estimate
        w = build_workout(
            make_payload(kind="easy", durationMinutes=None, target=None)
        )
        assert w["estimatedDurationInSecs"] == 3600

    def test_defaults_for_missing_title_and_notes(self):
        w = build_workout(make_payload(title=None, notes=None))
        assert w["workoutName"] == "tempo run"
        assert "description" not in w or w["description"] in (None, "")
