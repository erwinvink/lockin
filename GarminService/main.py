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
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query
from pydantic import BaseModel

from garminconnect import Garmin, GarminConnectAuthenticationError
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


def _get_client(prompt_mfa: Any = None) -> Garmin | None:
    """Login lazily: token-dir resume first, email/password fallback (which
    writes fresh tokens to the dir). Auth failures land in last_error and are
    reported via /status instead of crashing the service."""
    global _client, last_error
    with _client_lock:
        if _client is not None:
            return _client
        try:
            client = Garmin(
                email=GARMIN_EMAIL or None,
                password=GARMIN_PASSWORD or None,
                prompt_mfa=prompt_mfa,
            )
            client.login(tokenstore=_tokens_dir())
            _client = client
            last_error = None
            logger.info("Garmin login OK")
        except Exception as exc:  # noqa: BLE001 — sidecar must stay up
            last_error = f"{type(exc).__name__}: {exc}"
            logger.warning("Garmin login failed: %s", last_error)
            _client = None
        return _client


def _drop_client_on_auth_error(exc: Exception) -> None:
    """Expired/revoked tokens: forget the client so the next request retries
    the full login order (tokens, then credentials)."""
    global _client, last_error
    text = str(exc)
    if isinstance(exc, GarminConnectAuthenticationError) or "401" in text:
        with _client_lock:
            _client = None
            last_error = f"{type(exc).__name__}: {exc}"


def _safe(label: str, fn: Any, *args: Any, default: Any = None) -> Any:
    """Run one garminconnect call; any failure (e.g. no training readiness on
    older watches) degrades to `default` instead of a 500."""
    try:
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
    Returns [] when not logged in; per-metric failures degrade to defaults."""
    days = max(1, min(days, 30))
    client = _get_client()
    if client is None:
        return []

    today = date.today()
    dates = [today - timedelta(days=offset) for offset in range(days)]
    start_iso, end_iso = dates[-1].isoformat(), dates[0].isoformat()

    # Body battery covers the whole range in one call; mapping filters by date.
    body_battery = _safe(
        "get_body_battery", client.get_body_battery, start_iso, end_iso, default=None
    )

    out: list[dict[str, Any]] = []
    for d in dates:
        iso = d.isoformat()
        out.append(
            wellness_day(
                iso,
                _safe("get_sleep_data", client.get_sleep_data, iso, default=None),
                _safe("get_hrv_data", client.get_hrv_data, iso, default=None),
                body_battery,
                _safe("get_training_readiness", client.get_training_readiness, iso, default=None),
                _safe("get_rhr_day", client.get_rhr_day, iso, default=None),
            )
        )
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
            client.delete_workout(workout_id)
            result["deleted"] = True
        except Exception as exc:  # noqa: BLE001
            text = str(exc).lower()
            if "404" in text or "not found" in text:
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
