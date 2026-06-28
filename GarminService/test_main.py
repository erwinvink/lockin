"""Tests for main.py's degraded-mode branches — no network, no tokens.

A minimal fake stands in for the garminconnect client (monkeypatched module
state), covering the subtle paths:

- first 429 mid-batch truncates /wellness (later days OMITTED, never zeros)
- 2 consecutive connection-class failures truncate /wellness; isolated
  failures keep degrading per-metric
- anchored "API Error 404" matching in /workouts/delete
- login cooldown: a failed login is not retried within the cooldown window
"""

import time
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

client = TestClient(main.app)


class _NoNetworkGarmin:
    """Fails loudly if a test ever reaches the real login path."""

    def __init__(self, **_kwargs: object) -> None:
        raise AssertionError("test tried to construct a real Garmin client")


@pytest.fixture(autouse=True)
def _fresh_state(monkeypatch):
    """Each test starts logged out, without cooldown, and offline-guarded."""
    monkeypatch.setattr(main, "_client", None)
    monkeypatch.setattr(main, "_login_failed_at", None)
    monkeypatch.setattr(main, "last_error", None)
    main._clients.clear()
    main.last_errors.clear()
    main._login_failed_ats.clear()
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


def _raise(exc: Exception):
    def _fn(*_args):
        raise exc

    return _fn


# ---------------------------------------------------------------------------
# Per-user connection
# ---------------------------------------------------------------------------


def test_connect_saves_tokens_under_the_lockin_user(monkeypatch, tmp_path):
    calls = []

    class LoginGarmin:
        def __init__(self, email=None, password=None, **_kwargs):
            self.email = email
            self.password = password

        def login(self, tokenstore=None):
            calls.append((self.email, self.password, tokenstore))
            Path(tokenstore, "oauth.json").write_text("{}", encoding="utf8")

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
    assert calls[0][0:2] == ("runner@example.com", "secret")
    assert str(tmp_path / "users" / "user-1") == calls[0][2]


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
