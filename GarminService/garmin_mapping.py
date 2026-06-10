"""Pure mapping layer between Garmin Connect JSON and the lockin sidecar API.

No network calls and no garminconnect import — every function takes plain
dicts/lists (as returned by garminconnect==0.3.5) and returns plain dicts with
the camelCase keys the Node proxy expects. Every input may be None, partial,
or outright garbage; mapping never raises and degrades to 0/"" defaults.
"""

from typing import Any

# Garmin Connect structured-workout constants (see garminconnect.workout).
_SPORT_RUNNING = {"sportTypeId": 1, "sportTypeKey": "running", "displayOrder": 1}
_STEP_WARMUP = {"stepTypeId": 1, "stepTypeKey": "warmup", "displayOrder": 1}
_STEP_COOLDOWN = {"stepTypeId": 2, "stepTypeKey": "cooldown", "displayOrder": 2}
_STEP_INTERVAL = {"stepTypeId": 3, "stepTypeKey": "interval", "displayOrder": 3}
_COND_DISTANCE = {
    "conditionTypeId": 1,
    "conditionTypeKey": "distance",
    "displayOrder": 1,
    "displayable": True,
}
_COND_TIME = {
    "conditionTypeId": 2,
    "conditionTypeKey": "time",
    "displayOrder": 2,
    "displayable": True,
}
_TARGET_NONE = {"workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target", "displayOrder": 1}
_TARGET_HR = {"workoutTargetTypeId": 4, "workoutTargetTypeKey": "heart.rate.zone", "displayOrder": 4}
_TARGET_SPEED = {"workoutTargetTypeId": 5, "workoutTargetTypeKey": "speed.zone", "displayOrder": 5}

# Session kinds that get a warmup + main + cooldown structure on the watch.
_HARD_KINDS = {"long", "tempo", "intervals", "hills"}

_WARMUP_SECONDS = 600.0
_COOLDOWN_SECONDS = 300.0
_DEFAULT_SEC_PER_KM = 360.0  # 6:00/km duration estimate fallback


# ---------------------------------------------------------------------------
# Defensive accessors
# ---------------------------------------------------------------------------


def _dig(obj: Any, *path: Any) -> Any:
    """Walk dict keys / list indices, returning None on any miss."""
    cur = obj
    for key in path:
        if isinstance(cur, dict):
            cur = cur.get(key)
        elif isinstance(cur, (list, tuple)) and isinstance(key, int):
            cur = cur[key] if -len(cur) <= key < len(cur) else None
        else:
            return None
    return cur


def _num(value: Any) -> float | None:
    """Numeric value or None. Bools and non-numeric strings are rejected."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _int(value: Any, default: int = 0) -> int:
    n = _num(value)
    return default if n is None else int(round(n))


def _str(value: Any, default: str = "") -> str:
    return value if isinstance(value, str) else default


# ---------------------------------------------------------------------------
# Wellness
# ---------------------------------------------------------------------------


def _body_battery_for_date(body_battery_json: Any, date_iso: str) -> int:
    """Peak body battery level for the given day (0 when unknown).

    get_body_battery returns a list of per-day dicts each carrying a
    bodyBatteryValuesArray of [timestamp, status, level, version] readings.
    """
    if isinstance(body_battery_json, dict):
        entries: list[Any] = [body_battery_json]
    elif isinstance(body_battery_json, list):
        entries = body_battery_json
    else:
        return 0

    levels: list[int] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        entry_date = entry.get("date")
        if isinstance(entry_date, str) and entry_date != date_iso:
            continue
        readings = entry.get("bodyBatteryValuesArray")
        if not isinstance(readings, list):
            continue
        for reading in readings:
            if isinstance(reading, (list, tuple)) and len(reading) >= 3:
                level = _num(reading[2])
                if level is not None:
                    levels.append(int(round(level)))
    return max(levels) if levels else 0


def _readiness_score(readiness_json: Any) -> int:
    """Score from get_training_readiness (list) or the morning variant (dict)."""
    if isinstance(readiness_json, dict):
        return _int(readiness_json.get("score"))
    if isinstance(readiness_json, list):
        for entry in readiness_json:
            if isinstance(entry, dict):
                score = _num(entry.get("score"))
                if score is not None:
                    return int(round(score))
    return 0


def _resting_hr(rhr_json: Any, sleep_json: Any) -> int:
    """RHR from userstats metricsMap, falling back to the sleep payload."""
    value = _dig(
        rhr_json, "allMetrics", "metricsMap", "WELLNESS_RESTING_HEART_RATE", 0, "value"
    )
    rhr = _int(value)
    if rhr:
        return rhr
    return _int(_dig(sleep_json, "restingHeartRate"))


def wellness_day(
    date_iso: str,
    sleep_json: Any,
    hrv_json: Any,
    body_battery_json: Any,
    readiness_json: Any,
    rhr_json: Any,
) -> dict[str, Any]:
    """Collapse one day of Garmin wellness responses into a flat snapshot.

    Every input may be None or partial (older watches lack readiness/HRV);
    missing pieces become 0 / "" and this function never raises.
    """
    return {
        "date": date_iso,
        "sleepScore": _int(_dig(sleep_json, "dailySleepDTO", "sleepScores", "overall", "value")),
        "sleepSeconds": _int(_dig(sleep_json, "dailySleepDTO", "sleepTimeSeconds")),
        "hrvStatus": _str(_dig(hrv_json, "hrvSummary", "status")),
        "hrvMs": _int(_dig(hrv_json, "hrvSummary", "lastNightAvg")),
        "bodyBattery": _body_battery_for_date(body_battery_json, date_iso),
        "trainingReadiness": _readiness_score(readiness_json),
        "restingHr": _resting_hr(rhr_json, sleep_json),
    }


# ---------------------------------------------------------------------------
# Activities
# ---------------------------------------------------------------------------

_RUN_TYPE_MARKERS = ("running", "ultra")


def running_activity(activity_json: Any) -> dict[str, Any] | None:
    """Map one activitylist-service item; None for non-running activities.

    Accepts any typeKey containing "running" or "ultra" (running,
    trail_running, ultra_run, treadmill_running, ...).
    """
    if not isinstance(activity_json, dict):
        return None
    activity_id = activity_json.get("activityId")
    if activity_id is None:
        return None
    type_key = _str(_dig(activity_json, "activityType", "typeKey")).lower()
    if not any(marker in type_key for marker in _RUN_TYPE_MARKERS):
        return None

    distance_m = _num(activity_json.get("distance")) or 0.0
    distance_km = round(distance_m / 1000.0, 2)
    moving = _num(activity_json.get("movingDuration"))
    if moving is None:
        moving = _num(activity_json.get("duration")) or 0.0
    moving_seconds = int(round(moving))

    avg_speed = _num(activity_json.get("averageSpeed")) or 0.0  # m/s
    if avg_speed > 0:
        pace = int(round(1000.0 / avg_speed))
    elif distance_km > 0 and moving_seconds > 0:
        pace = int(round(moving_seconds / distance_km))
    else:
        pace = 0

    start_time = _str(activity_json.get("startTimeLocal")) or _str(
        activity_json.get("startTimeGMT")
    )

    return {
        "garminActivityId": str(activity_id),
        "startTime": start_time,
        "activityType": type_key,
        "distanceKm": distance_km,
        "movingSeconds": moving_seconds,
        "elevationGainM": _int(activity_json.get("elevationGain")),
        "averageHr": _int(activity_json.get("averageHR")),
        "averagePaceSecPerKm": pace,
        "name": _str(activity_json.get("activityName")),
    }


# ---------------------------------------------------------------------------
# Workout builder
# ---------------------------------------------------------------------------


def _step(order: int, step_type: dict, end_condition: dict, end_value: float,
          target: dict | None = None) -> dict[str, Any]:
    step: dict[str, Any] = {
        "type": "ExecutableStepDTO",
        "stepOrder": order,
        "stepType": dict(step_type),
        "endCondition": dict(end_condition),
        "endConditionValue": float(end_value),
        "targetType": dict(_TARGET_NONE),
    }
    if target:
        target_type = target.get("type")
        low = _num(target.get("low"))
        high = _num(target.get("high"))
        if target_type == "pace" and low and high and low > 0 and high > 0:
            # Inputs are sec-per-km with low = FASTER pace. Garmin speed.zone
            # wants m/s where targetValueOne = LOW speed, targetValueTwo =
            # HIGH speed; the faster pace bound becomes the higher speed bound.
            fast_sec, slow_sec = min(low, high), max(low, high)
            step["targetType"] = dict(_TARGET_SPEED)
            step["targetValueOne"] = round(1000.0 / slow_sec, 4)
            step["targetValueTwo"] = round(1000.0 / fast_sec, 4)
        elif target_type == "hr" and low is not None and high is not None:
            step["targetType"] = dict(_TARGET_HR)
            step["targetValueOne"] = float(min(low, high))
            step["targetValueTwo"] = float(max(low, high))
    return step


def build_workout(payload: Any) -> dict[str, Any]:
    """Build Garmin structured-workout JSON from a coach session payload.

    Payload: {"sessionId","title","date","kind","distanceKm","durationMinutes",
    "target":{"type","low","high"},"notes"}. Hard kinds (long/tempo/intervals/
    hills) get a 10 min easy warmup + main step + 5 min easy cooldown; easy/
    recovery become a single steady step. The schedule date is NOT part of the
    workout JSON — scheduling is a separate Garmin call.
    """
    payload = payload if isinstance(payload, dict) else {}
    kind = _str(payload.get("kind")).lower()
    hard = kind in _HARD_KINDS
    distance_km = _num(payload.get("distanceKm")) or 0.0
    duration_minutes = _num(payload.get("durationMinutes")) or 0.0
    target = payload.get("target") if isinstance(payload.get("target"), dict) else None

    # Main-step end condition: distance when known, otherwise time. The time
    # fallback subtracts warmup/cooldown for hard kinds (floor 10 min) so the
    # full workout still lands near durationMinutes.
    if distance_km > 0:
        main_condition, main_value = _COND_DISTANCE, round(distance_km * 1000.0, 1)
    else:
        total = duration_minutes * 60.0 if duration_minutes > 0 else 1800.0
        if hard:
            main_value = max(total - _WARMUP_SECONDS - _COOLDOWN_SECONDS, 600.0)
        else:
            main_value = total
        main_condition = _COND_TIME

    if hard:
        steps = [
            _step(1, _STEP_WARMUP, _COND_TIME, _WARMUP_SECONDS),
            _step(2, _STEP_INTERVAL, main_condition, main_value, target),
            _step(3, _STEP_COOLDOWN, _COND_TIME, _COOLDOWN_SECONDS),
        ]
    else:
        steps = [_step(1, _STEP_INTERVAL, main_condition, main_value, target)]

    if duration_minutes > 0:
        estimated = int(round(duration_minutes * 60.0))
    elif distance_km > 0:
        sec_per_km = _DEFAULT_SEC_PER_KM
        if target and _str(target.get("type")) == "pace":
            low = _num(target.get("low"))
            high = _num(target.get("high"))
            if low and high and low > 0 and high > 0:
                sec_per_km = (low + high) / 2.0
        estimated = int(round(distance_km * sec_per_km))
        if hard:
            estimated += int(_WARMUP_SECONDS + _COOLDOWN_SECONDS)
    else:
        estimated = int(sum(s["endConditionValue"] for s in steps if s["endCondition"].get("conditionTypeKey") == "time"))

    title = _str(payload.get("title"))
    workout: dict[str, Any] = {
        "workoutName": title or (f"{kind} run" if kind else "Run"),
        "sportType": dict(_SPORT_RUNNING),
        "estimatedDurationInSecs": estimated,
        "workoutSegments": [
            {
                "segmentOrder": 1,
                "sportType": dict(_SPORT_RUNNING),
                "workoutSteps": steps,
            }
        ],
    }
    notes = _str(payload.get("notes"))
    if notes:
        workout["description"] = notes
    return workout
