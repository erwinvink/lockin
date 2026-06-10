"""lockin Garmin sidecar — internal-only FastAPI service.

All garminconnect (network/auth) touching lives in this file; the mapping in
garmin_mapping.py stays pure. The Node proxy calls this over localhost:

    GET  /status
    GET  /wellness?days=N      (default 7, max 30, most recent first)
    GET  /activities?days=N    (default 14, max 60, most recent first)
    POST /workouts/push        {"workouts": [...]}
    POST /workouts/delete      {"workoutIds": [...]}

One-time interactive login (saves tokens to GARMIN_TOKENS_DIR):

    python main.py login
"""

import logging
import os
import sys
import threading
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query
from pydantic import BaseModel

from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)
from garmin_mapping import build_workout, running_activity, wellness_day

logger = logging.getLogger("garmin_sidecar")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

_BASE_DIR = Path(__file__).resolve().parent


def _load_env_file() -> None:
    """Load KEY=VALUE pairs from GarminService/.env without overriding the
    real environment. Tiny on purpose — avoids a python-dotenv dependency."""
    env_path = _BASE_DIR / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value


_load_env_file()

GARMIN_EMAIL = os.environ.get("GARMIN_EMAIL", "")
GARMIN_PASSWORD = os.environ.get("GARMIN_PASSWORD", "")
PORT = int(os.environ.get("PORT", "8788"))


def _tokens_dir() -> str:
    raw = os.environ.get("GARMIN_TOKENS_DIR", "./tokens")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = _BASE_DIR / path
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


# ---------------------------------------------------------------------------
# Lazy singleton Garmin client
# ---------------------------------------------------------------------------

_client: Garmin | None = None
_client_lock = threading.Lock()
last_error: str | None = None

# garminconnect serializes nothing internally: any API call may trigger a
# token refresh that mutates client state and rewrites the token file. One
# lock around every library call keeps concurrent requests (the proxy fires
# /wellness and /activities in parallel) from corrupting the token dump.
_io_lock = threading.Lock()

# After a failed login, skip re-attempts for this long: requests during the
# cooldown get the logged-out degraded state immediately (fast /status, no
# hammering Garmin SSO). Cleared by the next successful login.
_LOGIN_COOLDOWN_SECONDS = 60.0
_login_failed_at: float | None = None


def _get_client(prompt_mfa: Any = None) -> Garmin | None:
    """Login lazily: token-dir resume first, email/password fallback (which
    writes fresh tokens to the dir). Auth failures land in last_error and are
    reported via /status instead of crashing the service. A failed login
    starts a cooldown during which no new attempt is made."""
    global _client, last_error, _login_failed_at
    with _client_lock:
        if _client is not None:
            return _client
        if (
            _login_failed_at is not None
            and time.monotonic() - _login_failed_at < _LOGIN_COOLDOWN_SECONDS
        ):
            return None  # cooling down — degraded state, don't hit SSO again
        try:
            client = Garmin(
                email=GARMIN_EMAIL or None,
                password=GARMIN_PASSWORD or None,
                prompt_mfa=prompt_mfa,
                # Library default is 3 retries with 15s timeouts — enough to
                # occupy a worker thread for minutes when Garmin is down.
                retry_attempts=1,
            )
            client.login(tokenstore=_tokens_dir())
            _client = client
            last_error = None
            _login_failed_at = None
            logger.info("Garmin login OK")
        except Exception as exc:  # noqa: BLE001 — sidecar must stay up
            last_error = f"{type(exc).__name__}: {exc}"
            logger.warning("Garmin login failed: %s", last_error)
            _client = None
            _login_failed_at = time.monotonic()
        return _client


def _drop_client_on_auth_error(exc: Exception) -> None:
    """Expired/revoked tokens: forget the client so the next request retries
    the full login order (tokens, then credentials). Undecorated library
    paths surface raw errors formatted "API Error {status} - ...", so match
    the anchored prefix — a stray "401" elsewhere in a message (an id, a
    detail string) must not force a re-login."""
    global _client, last_error
    text = str(exc)
    if isinstance(exc, GarminConnectAuthenticationError) or text.startswith("API Error 401"):
        with _client_lock:
            _client = None
            last_error = f"{type(exc).__name__}: {exc}"


def _safe(label: str, fn: Any, *args: Any, default: Any = None) -> Any:
    """Run one garminconnect call (serialized via _io_lock); any failure
    (e.g. no training readiness on older watches) degrades to `default`
    instead of a 500."""
    try:
        with _io_lock:
            return fn(*args)
    except Exception as exc:  # noqa: BLE001
        logger.info("%s failed (%s): %s", label, type(exc).__name__, exc)
        _drop_client_on_auth_error(exc)
        return default


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

app = FastAPI(title="lockin Garmin sidecar", docs_url=None, redoc_url=None)


class PushBody(BaseModel):
    workouts: list[dict[str, Any]] = []


class DeleteBody(BaseModel):
    workoutIds: list[Any] = []


@app.get("/status")
def status() -> dict[str, Any]:
    client = _get_client()
    return {"ok": True, "loggedIn": client is not None, "lastError": last_error}


@app.get("/wellness")
def wellness(days: int = Query(default=7)) -> list[dict[str, Any]]:
    """One wellness_day dict per date, MOST RECENT FIRST (today at index 0).
    Returns [] when not logged in; per-metric failures degrade to defaults.

    Throttling bends the contract: on the first 429 (or after 2 consecutive
    connection-class failures) we stop calling Garmin and return only the
    complete rows fetched so far — remaining days are OMITTED, never filled
    with fake zeros. Consumers must treat missing days as no-data."""
    days = max(1, min(days, 30))
    client = _get_client()
    if client is None:
        return []

    stop = False  # set on first 429 or repeated connection failures
    conn_failures = 0  # consecutive GarminConnectConnectionError count

    def fetch(label: str, fn: Any, *args: Any, default: Any = None) -> Any:
        """_safe plus batch-level circuit breaking: once stopped, no further
        Garmin calls happen for this request."""
        nonlocal stop, conn_failures
        if stop:
            return default
        try:
            with _io_lock:
                result = fn(*args)
        except GarminConnectTooManyRequestsError as exc:
            stop = True
            logger.warning("%s throttled — truncating wellness batch: %s", label, exc)
            return default
        except GarminConnectConnectionError as exc:
            conn_failures += 1
            logger.info("%s failed (%s): %s", label, type(exc).__name__, exc)
            if conn_failures >= 2:
                stop = True
                logger.warning(
                    "%d consecutive connection failures — truncating wellness batch",
                    conn_failures,
                )
            _drop_client_on_auth_error(exc)
            return default
        except Exception as exc:  # noqa: BLE001
            logger.info("%s failed (%s): %s", label, type(exc).__name__, exc)
            _drop_client_on_auth_error(exc)
            return default
        conn_failures = 0
        return result

    today = date.today()
    dates = [today - timedelta(days=offset) for offset in range(days)]
    start_iso, end_iso = dates[-1].isoformat(), dates[0].isoformat()

    # Body battery covers the whole range in one call; mapping filters by date.
    body_battery = fetch(
        "get_body_battery", client.get_body_battery, start_iso, end_iso, default=None
    )

    out: list[dict[str, Any]] = []
    for d in dates:
        if stop:
            break
        iso = d.isoformat()
        row = wellness_day(
            iso,
            fetch("get_sleep_data", client.get_sleep_data, iso, default=None),
            fetch("get_hrv_data", client.get_hrv_data, iso, default=None),
            body_battery,
            fetch("get_training_readiness", client.get_training_readiness, iso, default=None),
            fetch("get_rhr_day", client.get_rhr_day, iso, default=None),
        )
        if stop:
            break  # the row that tripped the breaker is partial — omit it
        out.append(row)
    return out


@app.get("/activities")
def activities(days: int = Query(default=14)) -> list[dict[str, Any]]:
    """Running activities (running/trail_running/ultra/... only), most recent
    first (Garmin's default sort). Returns [] when not logged in."""
    days = max(1, min(days, 60))
    client = _get_client()
    if client is None:
        return []

    today = date.today()
    start_iso = (today - timedelta(days=days)).isoformat()
    raw = _safe(
        "get_activities_by_date",
        client.get_activities_by_date,
        start_iso,
        today.isoformat(),
        default=[],
    )
    if not isinstance(raw, list):
        return []
    return [mapped for item in raw if (mapped := running_activity(item)) is not None]


@app.post("/workouts/push")
def push_workouts(body: PushBody) -> list[dict[str, Any]]:
    """Per workout: build JSON -> create on Garmin -> schedule on its date.
    One failing item never aborts the batch."""
    client = _get_client()
    results: list[dict[str, Any]] = []
    for payload in body.workouts:
        session_id = str(payload.get("sessionId", ""))
        result: dict[str, Any] = {
            "sessionId": session_id,
            "garminWorkoutId": None,
            "scheduled": False,
            "error": None,
        }
        if client is None:
            result["error"] = last_error or "not logged in"
            results.append(result)
            continue
        try:
            workout_json = build_workout(payload)
            with _io_lock:
                created = client.upload_workout(workout_json)
            workout_id = (created or {}).get("workoutId") if isinstance(created, dict) else None
            if workout_id is None:
                result["error"] = "Garmin did not return a workoutId"
                results.append(result)
                continue
            result["garminWorkoutId"] = str(workout_id)

            date_str = str(payload.get("date", "") or "")
            if not date_str:
                result["error"] = "missing date; workout created but not scheduled"
            else:
                with _io_lock:
                    client.schedule_workout(workout_id, date_str)
                result["scheduled"] = True
        except Exception as exc:  # noqa: BLE001
            _drop_client_on_auth_error(exc)
            result["error"] = f"{type(exc).__name__}: {exc}"
        results.append(result)
    return results


@app.post("/workouts/delete")
def delete_workouts(body: DeleteBody) -> list[dict[str, Any]]:
    """Per-id delete; ids that are already gone count as deleted. One failing
    id never aborts the batch."""
    client = _get_client()
    results: list[dict[str, Any]] = []
    for raw_id in body.workoutIds:
        workout_id = str(raw_id)
        result: dict[str, Any] = {"workoutId": workout_id, "deleted": False, "error": None}
        if client is None:
            result["error"] = last_error or "not logged in"
            results.append(result)
            continue
        try:
            with _io_lock:
                client.delete_workout(workout_id)
            result["deleted"] = True
        except Exception as exc:  # noqa: BLE001
            # delete_workout bypasses the library's error-translation
            # decorator, so a missing workout surfaces as the raw
            # "API Error 404[ - detail]" message. Anchor the match: a 404
            # mentioned elsewhere (e.g. "API Error 500 - upstream 404")
            # must not count as already-deleted.
            text = str(exc)
            if text.startswith("API Error 404") or "not found" in text.lower():
                result["deleted"] = True  # already gone — that's the goal state
            else:
                _drop_client_on_auth_error(exc)
                result["error"] = f"{type(exc).__name__}: {exc}"
        results.append(result)
    return results


# ---------------------------------------------------------------------------
# CLI: one-time interactive login + dev server
# ---------------------------------------------------------------------------


def _cli_login() -> int:
    """Interactive login that saves tokens to GARMIN_TOKENS_DIR. Prompts for
    credentials when missing from the env and for an MFA code if Garmin asks."""
    global GARMIN_EMAIL, GARMIN_PASSWORD
    import getpass

    if not GARMIN_EMAIL:
        GARMIN_EMAIL = input("Garmin email: ").strip()
    if not GARMIN_PASSWORD:
        GARMIN_PASSWORD = getpass.getpass("Garmin password: ")

    client = _get_client(prompt_mfa=lambda: input("MFA code: ").strip())
    if client is None:
        print(f"Login failed: {last_error}")
        return 1
    print(f"Login OK — tokens saved to {_tokens_dir()}")
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["login"]:
        raise SystemExit(_cli_login())
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
