"""Tests for main.py's degraded-mode branches — no network, no tokens.

A minimal fake stands in for the garminconnect client (monkeypatched module
state), covering the subtle paths:

- first 429 mid-batch truncates /wellness (later days OMITTED, never zeros)
- 2 consecutive connection-class failures truncate /wellness; isolated
  failures keep degrading per-metric
- anchored "API Error 404" matching in /workouts/delete
- login cooldown: a failed login is not retried within the cooldown window
- per-metric "no data" (404) vs "fetch failed" -> unavailableMetrics
- idempotent /workouts/push via lockin:<sessionId> description tags
- two-request MFA connect that resumes the pending login
"""

import time
from types import SimpleNamespace
from datetime import date, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from garminconnect import (
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)

import main
from garmin_mapping import workout_fingerprint, workout_tag

client = TestClient(main.app)


class _NoNetworkGarmin:
    """Fails loudly if a test ever reaches the real login path."""

    def __init__(self, **_kwargs: object) -> None:
        raise AssertionError("test tried to construct a real Garmin client")


@pytest.fixture(autouse=True)
def _fresh_state(monkeypatch, tmp_path):
    """Each test starts logged out, without cooldown, and offline-guarded.
    Tokens live in a per-test temp dir, so real tokens are never read or
    written, and no default credentials leak in from the environment."""
    monkeypatch.setenv("GARMIN_TOKENS_DIR", str(tmp_path / "tokens"))
    monkeypatch.setattr(main, "GARMIN_EMAIL", "")
    monkeypatch.setattr(main, "GARMIN_PASSWORD", "")
    monkeypatch.setattr(main, "_client", None)
    monkeypatch.setattr(main, "_login_failed_at", None)
    monkeypatch.setattr(main, "last_error", None)
    main._clients.clear()
    main.last_errors.clear()
    main._login_failed_ats.clear()
    main._pending_mfa.clear()
    monkeypatch.setattr(main, "Garmin", _NoNetworkGarmin)


class FakeGarmin:
    """Records every call; per-method behavior injected as callables that
    return a value or raise. Methods without a behavior return None (the
    sidecar treats that as a missing metric)."""

    def __init__(self, **behaviors):
        self.behaviors = behaviors
        self.calls: list[tuple] = []

    def _do(self, name, *args):
        self.calls.append((name, *args))
        fn = self.behaviors.get(name)
        return fn(*args) if fn else None

    def get_body_battery(self, start, end):
        return self._do("get_body_battery", start, end)

    def get_sleep_data(self, iso):
        return self._do("get_sleep_data", iso)

    def get_hrv_data(self, iso):
        return self._do("get_hrv_data", iso)

    def get_training_readiness(self, iso):
        return self._do("get_training_readiness", iso)

    def get_rhr_day(self, iso):
        return self._do("get_rhr_day", iso)

    def delete_workout(self, workout_id):
        return self._do("delete_workout", workout_id)

    def get_workouts(self, start=0, limit=100):
        return self._do("get_workouts", start, limit)

    def upload_workout(self, workout_json):
        return self._do("upload_workout", workout_json)

    def schedule_workout(self, workout_id, date_str):
        return self._do("schedule_workout", workout_id, date_str)

    def get_scheduled_workouts(self, year, month):
        return self._do("get_scheduled_workouts", year, month)


def _raise(exc: Exception):
    def _fn(*_args):
        raise exc

    return _fn


# ---------------------------------------------------------------------------
# Per-user connection
# ---------------------------------------------------------------------------


def test_connect_saves_tokens_under_the_lockin_user(monkeypatch, tmp_path):
    calls = []

    class Inner:
        def dump(self, path):
            Path(path, "garmin_tokens.json").write_text("{}", encoding="utf8")

    class LoginGarmin:
        def __init__(self, email=None, password=None, **_kwargs):
            self.email = email
            self.password = password
            self.client = Inner()

        def login(self, tokenstore=None):
            calls.append((self.email, self.password, tokenstore))
            return None, None

    monkeypatch.setenv("GARMIN_TOKENS_DIR", str(tmp_path))
    monkeypatch.setattr(main, "Garmin", LoginGarmin)

    resp = client.post(
        "/connect",
        json={"userId": "user-1", "email": "runner@example.com", "password": "secret"},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["loggedIn"] is True
    assert body["state"] == "connected"
    assert body["userId"] == "user-1"
    assert body["connectedEmail"] == "runner@example.com"
    # A fresh credential login (no tokenstore), then tokens saved under the
    # Lockin user and resumed from there.
    assert calls[0] == ("runner@example.com", "secret", None)
    assert calls[1] == (None, None, str(tmp_path / "users" / "user-1"))
    assert (tmp_path / "users" / "user-1" / "garmin_tokens.json").is_file()


def test_connect_reports_mfa_required_without_starting_cooldown(monkeypatch, tmp_path):
    class MFAGarmin:
        def __init__(self, prompt_mfa=None, **_kwargs):
            self.prompt_mfa = prompt_mfa

        def login(self, tokenstore=None):
            self.prompt_mfa()

    monkeypatch.setenv("GARMIN_TOKENS_DIR", str(tmp_path))
    monkeypatch.setattr(main, "Garmin", MFAGarmin)

    body = client.post(
        "/connect",
        json={"userId": "user-1", "email": "runner@example.com", "password": "secret"},
    ).json()

    assert body["loggedIn"] is False
    assert body["state"] == "mfa_required"
    assert body["lastError"] == "Garmin needs the MFA code for this login."
    assert main._login_failed_ats.get("user-1") is None


def test_connect_treats_library_mfa_message_as_mfa_required(monkeypatch, tmp_path):
    class LibraryMFAGarmin:
        def __init__(self, **_kwargs):
            pass

        def login(self, tokenstore=None):
            raise GarminConnectConnectionError("Login failed: MFA code required")

    monkeypatch.setenv("GARMIN_TOKENS_DIR", str(tmp_path))
    monkeypatch.setattr(main, "Garmin", LibraryMFAGarmin)

    body = client.post(
        "/connect",
        json={"userId": "user-1", "email": "runner@example.com", "password": "secret"},
    ).json()

    assert body["loggedIn"] is False
    assert body["state"] == "mfa_required"
    assert body["lastError"] == "Garmin needs the MFA code for this login."
    assert main._login_failed_ats.get("user-1") is None


def _mfa_garmin_class(instances):
    """garminconnect 0.3.5 shape: a credential login with return_on_mfa=True
    returns ("needs_mfa", state) and keeps the MFA session on the object;
    resume_login(state, code) completes it; client.dump(path) saves tokens; a
    login without credentials resumes from the saved tokens."""

    class Inner:
        def __init__(self):
            self.dumped = []
            # garminconnect's widget flow keeps the credential POST response
            # (whose prepared request body carries the password) for resume.
            self._widget_last_resp = SimpleNamespace(
                text="csrf", request=SimpleNamespace(body="username=runner&password=secret")
            )

        def dump(self, path):
            self.dumped.append(path)
            Path(path, "garmin_tokens.json").write_text("{}", encoding="utf8")

    class MFAGarmin:
        def __init__(self, email=None, password=None, return_on_mfa=False, **_kwargs):
            self.email = email
            self.password = password
            self.return_on_mfa = return_on_mfa
            self.client = Inner()
            self.resumed = []
            instances.append(self)

        def login(self, tokenstore=None):
            if self.email:
                assert self.return_on_mfa is True
                return "needs_mfa", {"login": len(instances)}
            assert Path(tokenstore, "garmin_tokens.json").is_file()
            return None, None

        def resume_login(self, state, code):
            if code != "123456":
                raise GarminConnectAuthenticationError("MFA code rejected")
            self.resumed.append((state, code))
            return None, None

    return MFAGarmin


def test_connect_mfa_resumes_the_pending_login_instead_of_starting_a_new_one(monkeypatch, tmp_path):
    instances = []
    monkeypatch.setenv("GARMIN_TOKENS_DIR", str(tmp_path))
    monkeypatch.setattr(main, "Garmin", _mfa_garmin_class(instances))
    login = {"userId": "user-1", "email": "runner@example.com", "password": "secret"}

    first = client.post("/connect", json=login).json()
    assert first["state"] == "mfa_required"

    wrong = client.post("/connect", json={**login, "mfaCode": "000000"}).json()
    assert wrong["state"] == "mfa_required"

    second = client.post("/connect", json={**login, "mfaCode": "123456"}).json()

    assert second["state"] == "connected"
    assert second["loggedIn"] is True
    credential_logins = [g for g in instances if g.email]
    assert len(credential_logins) == 1  # one SSO login, so the emailed code still matches
    assert credential_logins[0].resumed == [({"login": 1}, "123456")]
    assert credential_logins[0].client.dumped == [str(tmp_path / "users" / "user-1")]
    assert "user-1" not in main._pending_mfa
    assert client.get("/status", params={"userId": "user-1"}).json()["loggedIn"] is True


def test_a_pending_mfa_login_does_not_keep_the_password(monkeypatch, tmp_path):
    instances = []
    monkeypatch.setenv("GARMIN_TOKENS_DIR", str(tmp_path))
    monkeypatch.setattr(main, "Garmin", _mfa_garmin_class(instances))

    client.post("/connect", json={"userId": "user-1", "email": "runner@example.com", "password": "secret"})

    pending = main._pending_mfa["user-1"]
    assert pending.client.password is None
    assert pending.client.client._widget_last_resp.request.body is None
    assert "secret" not in repr(pending._asdict())


def test_expired_pending_mfa_logins_are_purged_on_status_and_connect(monkeypatch, tmp_path):
    instances = []
    monkeypatch.setenv("GARMIN_TOKENS_DIR", str(tmp_path))
    monkeypatch.setattr(main, "Garmin", _mfa_garmin_class(instances))
    login = {"email": "runner@example.com", "password": "secret"}
    client.post("/connect", json={"userId": "user-1", **login})
    client.post("/connect", json={"userId": "user-2", **login})
    expired = time.monotonic() - main._MFA_PENDING_SECONDS - 1
    main._pending_mfa["user-1"] = main._pending_mfa["user-1"]._replace(started_at=expired)

    client.get("/status", params={"userId": "someone-else"})

    assert "user-1" not in main._pending_mfa
    assert "user-2" in main._pending_mfa

    main._pending_mfa["user-2"] = main._pending_mfa["user-2"]._replace(started_at=expired)
    client.post("/connect", json={"userId": "user-3", **login})

    assert "user-2" not in main._pending_mfa


def test_connect_mfa_code_without_a_pending_login_starts_one_and_tries_the_code(monkeypatch, tmp_path):
    # Expired or lost pending state (e.g. sidecar restart): an authenticator
    # (TOTP) code is still valid against a fresh login.
    instances = []
    monkeypatch.setenv("GARMIN_TOKENS_DIR", str(tmp_path))
    monkeypatch.setattr(main, "Garmin", _mfa_garmin_class(instances))
    login = {"userId": "user-1", "email": "runner@example.com", "password": "secret"}

    client.post("/connect", json=login)
    main._pending_mfa["user-1"] = main._pending_mfa["user-1"]._replace(
        started_at=time.monotonic() - main._MFA_PENDING_SECONDS - 1
    )

    body = client.post("/connect", json={**login, "mfaCode": "123456"}).json()

    assert body["state"] == "connected"
    assert len([g for g in instances if g.email]) == 2


# ---------------------------------------------------------------------------
# userId validation (path traversal into the token dir)
# ---------------------------------------------------------------------------

APP_USER_ID = "8B059341-1C2D-4E5F-8A9B-0123456789AB"


@pytest.mark.parametrize("bad_user_id", ["..", ".", "a/b", "../x", "a.b", "..\\x", "x" * 121])
def test_user_ids_that_could_escape_the_token_dir_are_rejected(bad_user_id):
    root_token = Path(main._tokens_dir(), "garmin_tokens.json")
    root_token.write_text("{}", encoding="utf8")
    other_token = Path(main._tokens_dir("other-user"), "garmin_tokens.json")
    other_token.write_text("{}", encoding="utf8")

    responses = [
        client.get("/status", params={"userId": bad_user_id}),
        client.get("/wellness", params={"userId": bad_user_id}),
        client.get("/activities", params={"userId": bad_user_id}),
        client.post("/disconnect", json={"userId": bad_user_id}),
        client.post("/connect", json={"userId": bad_user_id, "email": "a@b.c", "password": "x"}),
        client.post("/workouts/push", json={"userId": bad_user_id, "workouts": []}),
        client.post("/workouts/delete", json={"userId": bad_user_id, "workoutIds": ["1"]}),
    ]

    assert [r.status_code for r in responses] == [400] * len(responses)
    assert root_token.is_file()
    assert other_token.is_file()


def test_token_dir_never_resolves_outside_users():
    for bad in ("..", ".", "../x", "a/../../b"):
        with pytest.raises(main.InvalidUserIdError):
            main._tokens_dir(bad)


def test_an_app_uuid_user_id_is_accepted_and_disconnect_only_removes_its_own_tokens():
    root_token = Path(main._tokens_dir(), "garmin_tokens.json")
    root_token.write_text("{}", encoding="utf8")
    other_token = Path(main._tokens_dir("other-user"), "garmin_tokens.json")
    other_token.write_text("{}", encoding="utf8")
    own_dir = Path(main._tokens_dir(APP_USER_ID))
    Path(own_dir, "garmin_tokens.json").write_text("{}", encoding="utf8")

    assert client.get("/status", params={"userId": APP_USER_ID}).status_code == 200
    body = client.post("/disconnect", json={"userId": APP_USER_ID}).json()

    assert body["state"] == "not_connected"
    assert not own_dir.exists()
    assert root_token.is_file()
    assert other_token.is_file()


def _library_like_garmin(instances, *, stored_tokens_valid, password="right"):
    """Mirrors garminconnect 0.3.5 Garmin.login(tokenstore): stored tokens are
    loaded first and, if they load, credentials are never checked; with
    return_on_mfa=True a rejected token is NOT followed by a credential
    login. Without a tokenstore it is a plain credential (SSO) login."""

    class Inner:
        def dump(self, path):
            Path(path, "garmin_tokens.json").write_text('{"fresh": true}', encoding="utf8")

    class LibGarmin:
        def __init__(self, email=None, password=None, return_on_mfa=False, **_kwargs):
            self.email = email
            self.password = password
            self.return_on_mfa = return_on_mfa
            self.client = Inner()
            self.sso_logins = 0
            instances.append(self)

        def login(self, tokenstore=None):
            token_file = Path(tokenstore, "garmin_tokens.json") if tokenstore else None
            if token_file is not None and token_file.is_file():
                if "fresh" in token_file.read_text(encoding="utf8") or stored_tokens_valid:
                    return None, None
                if self.return_on_mfa:
                    raise GarminConnectAuthenticationError("Failed to retrieve social profile")
            if not self.email:
                raise GarminConnectAuthenticationError("Username and password are required")
            self.sso_logins += 1
            if self.password != password:
                raise GarminConnectAuthenticationError("Authentication failed (401 Unauthorized)")
            return None, None

    return LibGarmin


def test_connect_with_stale_tokens_logs_in_with_the_new_password(monkeypatch, tmp_path):
    instances = []
    monkeypatch.setenv("GARMIN_TOKENS_DIR", str(tmp_path))
    monkeypatch.setattr(main, "Garmin", _library_like_garmin(instances, stored_tokens_valid=False))
    Path(main._tokens_dir("user-1"), "garmin_tokens.json").write_text('{"stale": true}', encoding="utf8")

    body = client.post(
        "/connect", json={"userId": "user-1", "email": "runner@example.com", "password": "right"}
    ).json()

    assert body["state"] == "connected"
    assert [g.sso_logins for g in instances if g.email] == [1]
    assert "fresh" in Path(tmp_path, "users", "user-1", "garmin_tokens.json").read_text(encoding="utf8")


def test_connect_checks_the_password_even_when_valid_tokens_exist(monkeypatch, tmp_path):
    instances = []
    monkeypatch.setenv("GARMIN_TOKENS_DIR", str(tmp_path))
    monkeypatch.setattr(main, "Garmin", _library_like_garmin(instances, stored_tokens_valid=True))
    Path(main._tokens_dir("user-1"), "garmin_tokens.json").write_text('{"valid": true}', encoding="utf8")

    body = client.post(
        "/connect", json={"userId": "user-1", "email": "runner@example.com", "password": "wrong"}
    ).json()

    assert body["loggedIn"] is False
    assert body["state"] == "not_connected"


def test_connect_checks_the_password_even_when_already_connected(monkeypatch, tmp_path):
    instances = []
    monkeypatch.setenv("GARMIN_TOKENS_DIR", str(tmp_path))
    monkeypatch.setattr(main, "Garmin", _library_like_garmin(instances, stored_tokens_valid=True))
    existing = FakeGarmin()
    main._clients["user-1"] = existing

    body = client.post(
        "/connect", json={"userId": "user-1", "email": "runner@example.com", "password": "wrong"}
    ).json()

    assert body["state"] == "not_connected"
    # A typo must not drop the connection that already works.
    assert main._clients["user-1"] is existing


def test_user_scoped_wellness_uses_the_user_client(monkeypatch):
    today = date.today()
    default_fake = FakeGarmin(get_sleep_data=lambda _iso: None)
    user_fake = FakeGarmin(get_sleep_data=lambda _iso: None)
    monkeypatch.setattr(main, "_client", default_fake)
    main._clients["user-1"] = user_fake

    rows = client.get("/wellness", params={"userId": "user-1", "days": 1}).json()

    assert rows[0]["date"] == today.isoformat()
    assert default_fake.calls == []
    assert any(call[0] == "get_sleep_data" for call in user_fake.calls)


# ---------------------------------------------------------------------------
# /wellness truncation
# ---------------------------------------------------------------------------


def test_wellness_429_truncates_to_rows_fetched_so_far(monkeypatch):
    today = date.today()
    day2 = (today - timedelta(days=1)).isoformat()

    def sleep_data(iso):
        if iso == day2:
            raise GarminConnectTooManyRequestsError("Rate limit exceeded: API Error 429")
        return None

    fake = FakeGarmin(get_sleep_data=sleep_data)
    monkeypatch.setattr(main, "_client", fake)

    resp = client.get("/wellness", params={"days": 5})
    assert resp.status_code == 200
    rows = resp.json()

    # Only day 1 (today) comes back; days 2-5 are omitted — no fake zeros.
    assert [r["date"] for r in rows] == [today.isoformat()]

    # The 429 was the LAST Garmin call: day 2 stopped mid-row and days 3-5
    # were never attempted (1 range call + 4 day-1 metrics + failing sleep).
    assert fake.calls[-1] == ("get_sleep_data", day2)
    assert len(fake.calls) == 6


def test_wellness_bails_after_two_consecutive_connection_failures(monkeypatch):
    boom = _raise(GarminConnectConnectionError("API Error 503 - Garmin is down"))
    fake = FakeGarmin(get_sleep_data=boom, get_hrv_data=boom)
    monkeypatch.setattr(main, "_client", fake)

    rows = client.get("/wellness", params={"days": 3}).json()

    # Day 1 tripped the breaker mid-row, so even it is omitted.
    assert rows == []
    assert [c[0] for c in fake.calls] == [
        "get_body_battery",
        "get_sleep_data",
        "get_hrv_data",
    ]


def test_wellness_isolated_failures_degrade_without_truncating(monkeypatch):
    # One connection-class failure per day (readiness 404 on older watches):
    # successes in between reset the consecutive counter, so every requested
    # day still comes back, with only the failing metric defaulted.
    fake = FakeGarmin(
        get_training_readiness=_raise(
            GarminConnectConnectionError("API call client error (404): API Error 404")
        )
    )
    monkeypatch.setattr(main, "_client", fake)

    today = date.today()
    rows = client.get("/wellness", params={"days": 3}).json()

    assert [r["date"] for r in rows] == [
        (today - timedelta(days=offset)).isoformat() for offset in range(3)
    ]
    assert all(r["trainingReadiness"] == 0 for r in rows)


# ---------------------------------------------------------------------------
# /wellness: "no data" vs "fetch failed" per metric (S2)
# ---------------------------------------------------------------------------


def test_wellness_404_means_no_data_not_unavailable(monkeypatch):
    # A watch without readiness/RHR answers 404 for every day. That is
    # legitimately "no data": no unavailableMetrics, and two 404s in a row
    # must not trip the connection breaker.
    not_found = _raise(GarminConnectConnectionError("API call client error (404): API Error 404"))
    fake = FakeGarmin(get_training_readiness=not_found, get_rhr_day=not_found)
    monkeypatch.setattr(main, "_client", fake)

    rows = client.get("/wellness", params={"days": 3}).json()

    assert len(rows) == 3
    assert all("unavailableMetrics" not in r for r in rows)
    assert all(r["trainingReadiness"] == 0 for r in rows)


def test_wellness_single_failure_marks_only_that_metric_unavailable(monkeypatch):
    today = date.today().isoformat()

    def sleep_data(iso):
        if iso == today:
            raise GarminConnectConnectionError("API Error 503 - Garmin is down")
        return {"dailySleepDTO": {"sleepTimeSeconds": 25000, "sleepScores": {"overall": {"value": 82}}}}

    fake = FakeGarmin(get_sleep_data=sleep_data)
    monkeypatch.setattr(main, "_client", fake)

    rows = client.get("/wellness", params={"days": 2}).json()

    assert [r["date"] for r in rows][0] == today
    # The failed metric keeps its 0 placeholder (old decoders need ints) but
    # is flagged so consumers never store it as a real value.
    assert rows[0]["sleepScore"] == 0
    assert rows[0]["unavailableMetrics"] == ["sleepScore", "sleepSeconds", "restingHr"]
    assert rows[1]["sleepScore"] == 82
    assert "unavailableMetrics" not in rows[1]


def test_wellness_unexpected_errors_and_range_failures_are_unavailable(monkeypatch):
    fake = FakeGarmin(
        get_body_battery=_raise(GarminConnectConnectionError("Connection error: read timed out")),
        get_hrv_data=_raise(ValueError("unexpected payload")),
        get_rhr_day=_raise(GarminConnectConnectionError("API Error 500")),
        get_sleep_data=lambda _iso: {"restingHeartRate": 51},
    )
    monkeypatch.setattr(main, "_client", fake)

    rows = client.get("/wellness", params={"days": 1}).json()

    assert len(rows) == 1
    # RHR still comes through via the sleep payload, so it is not flagged.
    assert rows[0]["restingHr"] == 51
    assert rows[0]["unavailableMetrics"] == ["hrvStatus", "hrvMs", "bodyBattery"]


# ---------------------------------------------------------------------------
# /workouts/delete anchored error matching
# ---------------------------------------------------------------------------


def test_delete_error_matching_is_anchored(monkeypatch):
    def delete_workout(workout_id):
        if workout_id == "1":
            raise GarminConnectConnectionError("API Error 404")
        raise GarminConnectConnectionError("API Error 500 - upstream 404")

    fake = FakeGarmin(delete_workout=delete_workout)
    monkeypatch.setattr(main, "_client", fake)

    resp = client.post("/workouts/delete", json={"workoutIds": ["1", "2"]})
    assert resp.status_code == 200
    one, two = resp.json()

    # A real 404 means already gone — that's the goal state.
    assert one == {"workoutId": "1", "deleted": True, "error": None}

    # A 500 that merely *mentions* 404 must not count as deleted.
    assert two["workoutId"] == "2"
    assert two["deleted"] is False
    assert two["error"] is not None and "API Error 500" in two["error"]


# ---------------------------------------------------------------------------
# /workouts/push idempotency (S11)
# ---------------------------------------------------------------------------

PUSH_WORKOUT = {
    "sessionId": "sess-1",
    "title": "Tempo run",
    "date": "2026-06-16",
    "kind": "tempo",
    "distanceKm": 8,
    "durationMinutes": 45,
    "target": {"type": "hr", "low": 150, "high": 162},
    "notes": "Z3",
}


def _tagged(workout_id, session_id="sess-1", payload=PUSH_WORKOUT, description="Z3"):
    tag = workout_tag(session_id, workout_fingerprint(payload))
    return {"workoutId": workout_id, "workoutName": "Tempo run", "description": f"{description}\n\n{tag}"}


def test_push_tags_each_created_workout_with_its_session(monkeypatch):
    fake = FakeGarmin(
        get_workouts=lambda _start, _limit: [],
        upload_workout=lambda _json: {"workoutId": 501},
    )
    monkeypatch.setattr(main, "_client", fake)

    (result,) = client.post("/workouts/push", json={"workouts": [PUSH_WORKOUT]}).json()

    assert result == {"sessionId": "sess-1", "garminWorkoutId": "501", "scheduled": True, "error": None}
    uploaded = next(call[1] for call in fake.calls if call[0] == "upload_workout")
    assert "lockin:sess-1:" in uploaded["description"]
    assert uploaded["description"].startswith("Z3")
    assert ("schedule_workout", 501, "2026-06-16") in fake.calls


def test_push_reuses_a_scheduled_workout_left_by_a_timed_out_push(monkeypatch):
    fake = FakeGarmin(
        get_workouts=lambda _start, _limit: [{"workoutId": 9, "workoutName": "Other", "description": None}, _tagged(77)],
        get_scheduled_workouts=lambda _year, _month: {
            "calendarItems": [{"itemType": "workout", "workoutId": 77, "date": "2026-06-16"}]
        },
    )
    monkeypatch.setattr(main, "_client", fake)

    (result,) = client.post("/workouts/push", json={"workouts": [PUSH_WORKOUT]}).json()

    assert result == {"sessionId": "sess-1", "garminWorkoutId": "77", "scheduled": True, "error": None}
    assert not any(call[0] in ("upload_workout", "schedule_workout") for call in fake.calls)
    assert ("get_scheduled_workouts", 2026, 6) in fake.calls


def test_push_schedules_a_reused_workout_that_is_not_on_the_calendar(monkeypatch):
    fake = FakeGarmin(
        get_workouts=lambda _start, _limit: [_tagged(77)],
        get_scheduled_workouts=lambda _year, _month: {"calendarItems": []},
    )
    monkeypatch.setattr(main, "_client", fake)

    (result,) = client.post("/workouts/push", json={"workouts": [PUSH_WORKOUT]}).json()

    assert result["garminWorkoutId"] == "77"
    assert result["scheduled"] is True
    assert not any(call[0] == "upload_workout" for call in fake.calls)
    assert ("schedule_workout", 77, "2026-06-16") in fake.calls


def test_push_replaces_an_orphan_with_outdated_content(monkeypatch):
    outdated = dict(PUSH_WORKOUT, distanceKm=12)
    fake = FakeGarmin(
        get_workouts=lambda _start, _limit: [_tagged(66, payload=outdated)],
        upload_workout=lambda _json: {"workoutId": 502},
    )
    monkeypatch.setattr(main, "_client", fake)

    (result,) = client.post("/workouts/push", json={"workouts": [PUSH_WORKOUT]}).json()

    assert result["garminWorkoutId"] == "502"
    assert ("delete_workout", "66") in fake.calls
    assert any(call[0] == "upload_workout" for call in fake.calls)


def test_push_still_creates_when_the_workout_list_fails(monkeypatch):
    fake = FakeGarmin(
        get_workouts=_raise(GarminConnectConnectionError("API Error 503")),
        upload_workout=lambda _json: {"workoutId": 503},
    )
    monkeypatch.setattr(main, "_client", fake)

    (result,) = client.post("/workouts/push", json={"workouts": [PUSH_WORKOUT]}).json()

    assert result["garminWorkoutId"] == "503"
    assert result["scheduled"] is True


# ---------------------------------------------------------------------------
# Login cooldown
# ---------------------------------------------------------------------------


def test_login_cooldown_blocks_immediate_retry(monkeypatch):
    login_calls = {"n": 0}

    class FailingGarmin:
        def __init__(self, **_kwargs):
            pass

        def login(self, tokenstore=None):
            login_calls["n"] += 1
            raise GarminConnectAuthenticationError("bad credentials")

    monkeypatch.setattr(main, "Garmin", FailingGarmin)
    # A (dummy) saved token makes the default user eligible for a login
    # attempt without any real tokens or credentials.
    Path(main._tokens_dir(), "garmin_tokens.json").write_text("{}", encoding="utf8")

    first = client.get("/status").json()
    assert first["loggedIn"] is False
    assert first["lastError"] is not None
    assert login_calls["n"] == 1

    # Immediate second request: cooldown short-circuits, no second SSO hit.
    second = client.get("/status").json()
    assert second["loggedIn"] is False
    assert second["lastError"] is not None
    assert login_calls["n"] == 1

    # Once the cooldown has elapsed, login is attempted again.
    monkeypatch.setattr(
        main, "_login_failed_at", time.monotonic() - main._LOGIN_COOLDOWN_SECONDS - 1
    )
    client.get("/status")
    assert login_calls["n"] == 2
