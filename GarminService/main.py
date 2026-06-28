"""lockin Garmin sidecar — internal-only FastAPI service.

All garminconnect (network/auth) touching lives in this file; the mapping in
garmin_mapping.py stays pure. The Node proxy calls this over localhost:

    GET  /status
    GET  /wellness?days=N      (default 7, max 30, most recent first)
    GET  /activities?days=N    (default 14, max 90, most recent first)
    POST /workouts/push        {"workouts": [...]}
    POST /workouts/delete      {"workoutIds": [...]}

One-time interactive login (saves tokens to GARMIN_TOKENS_DIR):

    python main.py login
"""

import json
import logging
import os
import re
import shutil
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
GARMIN_DEFAULT_USER_ID = os.environ.get("GARMIN_DEFAULT_USER_ID", "default")
PORT = int(os.environ.get("PORT", "8788"))


def _tokens_base_dir() -> Path:
    raw = os.environ.get("GARMIN_TOKENS_DIR", "./tokens")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = _BASE_DIR / path
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:
        pass
    return path


def _tokens_dir(user_id: str | None = None) -> str:
    path = _tokens_base_dir() if not user_id else _tokens_base_dir() / "users" / _clean_user_id(user_id)
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:
        pass
    return str(path)


def _clean_user_id(value: str | None) -> str:
    raw = (value or "").strip() or GARMIN_DEFAULT_USER_ID
    return re.sub(r"[^A-Za-z0-9_.-]", "_", raw)[:120] or GARMIN_DEFAULT_USER_ID


def _is_default_user(user_id: str) -> bool:
    return user_id == _clean_user_id("") or user_id == _clean_user_id(GARMIN_DEFAULT_USER_ID)


def _token_files_exist(user_id: str | None = None) -> bool:
    path = Path(_tokens_dir(user_id))
    return any(item.is_file() and item.name != "lockin-connection.json" for item in path.rglob("*"))


def _metadata_path(user_id: str) -> Path:
    return Path(_tokens_dir(user_id)) / "lockin-connection.json"


def _write_metadata(user_id: str, email: str) -> None:
    _metadata_path(user_id).write_text(
        json.dumps({"email": email, "connectedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}),
        encoding="utf8",
    )


def _read_metadata(user_id: str) -> dict[str, Any]:
    try:
        return json.loads(_metadata_path(user_id).read_text(encoding="utf8"))
    except Exception:  # noqa: BLE001
        return {}


# ---------------------------------------------------------------------------
# Lazy singleton Garmin client
# ---------------------------------------------------------------------------

_client: Garmin | None = None
_clients: dict[str, Garmin] = {}
_client_lock = threading.Lock()
last_error: str | None = None
last_errors: dict[str, str | None] = {}

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
_login_failed_ats: dict[str, float | None] = {}


class MFARequiredError(Exception):
    pass


def _is_mfa_required_text(value: str | None) -> bool:
    text = (value or "").lower()
    if not text:
        return False
    return (
        ("mfa" in text or "multi-factor" in text or "two-factor" in text or "2fa" in text)
        and ("required" in text or "code" in text)
    )


def _is_mfa_required_error(exc: Exception) -> bool:
    return isinstance(exc, MFARequiredError) or _is_mfa_required_text(f"{type(exc).__name__}: {exc}")


def _cached_client(user_id: str) -> Garmin | None:
    if _is_default_user(user_id):
        return _client
    return _clients.get(user_id)


def _set_cached_client(user_id: str, client: Garmin | None) -> None:
    global _client
    if _is_default_user(user_id):
        _client = client
    elif client is None:
        _clients.pop(user_id, None)
    else:
        _clients[user_id] = client


def _last_error(user_id: str) -> str | None:
    return last_error if _is_default_user(user_id) else last_errors.get(user_id)


def _set_last_error(user_id: str, value: str | None) -> None:
    global last_error
    if _is_default_user(user_id):
        last_error = value
    else:
        last_errors[user_id] = value


def _get_login_failed_at(user_id: str) -> float | None:
    return _login_failed_at if _is_default_user(user_id) else _login_failed_ats.get(user_id)


def _set_login_failed_at(user_id: str, value: float | None) -> None:
    global _login_failed_at
    if _is_default_user(user_id):
        _login_failed_at = value
    else:
        _login_failed_ats[user_id] = value


def _status_payload(user_id: str, logged_in: bool, state: str | None = None) -> dict[str, Any]:
    meta = _read_metadata(user_id)
    return {
        "ok": True,
        "userId": user_id,
        "loggedIn": logged_in,
        "state": state or ("connected" if logged_in else "not_connected"),
        "connectedEmail": meta.get("email") if isinstance(meta.get("email"), str) else None,
        "lastError": _last_error(user_id),
    }


def _get_client(
    user_id_input: str | None = None,
    *,
    email: str | None = None,
    password: str | None = None,
    prompt_mfa: Any = None,
    force_credentials: bool = False,
) -> Garmin | None:
    """Login lazily: token-dir resume first, email/password fallback (which
    writes fresh tokens to the dir). Auth failures land in last_error and are
    reported via /status instead of crashing the service. A failed login
    starts a cooldown during which no new attempt is made."""
    user_id = _clean_user_id(user_id_input)
    with _client_lock:
        cached = _cached_client(user_id)
        if cached is not None:
            return cached
        if (
            not force_credentials
            and _get_login_failed_at(user_id) is not None
            and time.monotonic() - (_get_login_failed_at(user_id) or 0) < _LOGIN_COOLDOWN_SECONDS
        ):
            return None  # cooling down — degraded state, don't hit SSO again
        login_email = (email or "").strip()
        login_password = password or ""
        if not login_email and _is_default_user(user_id):
            login_email = GARMIN_EMAIL
        if not login_password and _is_default_user(user_id):
            login_password = GARMIN_PASSWORD
        if not force_credentials and not _token_files_exist(None if _is_default_user(user_id) else user_id) and not (login_email and login_password):
            _set_last_error(user_id, None)
            return None
        try:
            client = Garmin(
                email=login_email or None,
                password=login_password or None,
                prompt_mfa=prompt_mfa,
                # Library default is 3 retries with 15s timeouts — enough to
                # occupy a worker thread for minutes when Garmin is down.
                retry_attempts=1,
            )
            client.login(tokenstore=_tokens_dir(None if _is_default_user(user_id) else user_id))
            _set_cached_client(user_id, client)
            _set_last_error(user_id, None)
            _set_login_failed_at(user_id, None)
            if login_email:
                _write_metadata(user_id, login_email)
            logger.info("Garmin login OK for %s", user_id)
        except Exception as exc:  # noqa: BLE001 — sidecar must stay up
            is_mfa_required = _is_mfa_required_error(exc)
            _set_last_error(user_id, f"{type(exc).__name__}: {exc}")
            logger.warning("Garmin login failed for %s: %s", user_id, _last_error(user_id))
            _set_cached_client(user_id, None)
            if not is_mfa_required:
                _set_login_failed_at(user_id, time.monotonic())
        return _cached_client(user_id)


def _drop_client_on_auth_error(exc: Exception, user_id_input: str | None = None) -> None:
    """Expired/revoked tokens: forget the client so the next request retries
    the full login order (tokens, then credentials). Undecorated library
    paths surface raw errors formatted "API Error {status} - ...", so match
    the anchored prefix — a stray "401" elsewhere in a message (an id, a
    detail string) must not force a re-login."""
    user_id = _clean_user_id(user_id_input)
    text = str(exc)
    if isinstance(exc, GarminConnectAuthenticationError) or text.startswith("API Error 401"):
        with _client_lock:
            _set_cached_client(user_id, None)
            _set_last_error(user_id, f"{type(exc).__name__}: {exc}")


def _safe(label: str, fn: Any, *args: Any, default: Any = None, user_id: str | None = None) -> Any:
    """Run one garminconnect call (serialized via _io_lock); any failure
    (e.g. no training readiness on older watches) degrades to `default`
    instead of a 500."""
    try:
        with _io_lock:
            return fn(*args)
    except Exception as exc:  # noqa: BLE001
        logger.info("%s failed (%s): %s", label, type(exc).__name__, exc)
        _drop_client_on_auth_error(exc, user_id)
        return default


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

app = FastAPI(title="lockin Garmin sidecar", docs_url=None, redoc_url=None)


class PushBody(BaseModel):
    userId: str = ""
    workouts: list[dict[str, Any]] = []


class DeleteBody(BaseModel):
    userId: str = ""
    workoutIds: list[Any] = []


class ConnectBody(BaseModel):
    userId: str = ""
    email: str = ""
    password: str = ""
    mfaCode: str | None = None


class DisconnectBody(BaseModel):
    userId: str = ""


@app.get("/status")
def status(userId: str = Query(default="")) -> dict[str, Any]:
    user_id = _clean_user_id(userId)
    client = _get_client(user_id)
    return _status_payload(user_id, client is not None)


@app.post("/connect")
def connect(body: ConnectBody) -> dict[str, Any]:
    user_id = _clean_user_id(body.userId)
    email = body.email.strip()
    if not email or not body.password:
        _set_last_error(user_id, "Garmin email and password are required.")
        return _status_payload(user_id, False, "credentials_required")

    def prompt_mfa() -> str:
        code = (body.mfaCode or "").strip()
        if not code:
            raise MFARequiredError("MFA code required")
        return code

    client = _get_client(
        user_id,
        email=email,
        password=body.password,
        prompt_mfa=prompt_mfa,
        force_credentials=True,
    )
    if client is not None:
        return _status_payload(user_id, True, "connected")

    if _is_mfa_required_text(_last_error(user_id)):
        _set_last_error(user_id, "Garmin needs the MFA code for this login.")
        return _status_payload(user_id, False, "mfa_required")
    return _status_payload(user_id, False, "not_connected")


@app.post("/disconnect")
def disconnect(body: DisconnectBody) -> dict[str, Any]:
    user_id = _clean_user_id(body.userId)
    with _client_lock:
        _set_cached_client(user_id, None)
        _set_last_error(user_id, None)
        _set_login_failed_at(user_id, None)
    if not _is_default_user(user_id):
        shutil.rmtree(_tokens_dir(user_id), ignore_errors=True)
    return _status_payload(user_id, False, "not_connected")


@app.get("/wellness")
def wellness(days: int = Query(default=7), userId: str = Query(default="")) -> list[dict[str, Any]]:
    """One wellness_day dict per date, MOST RECENT FIRST (today at index 0).
    Returns [] when not logged in; per-metric failures degrade to defaults.

    Throttling bends the contract: on the first 429 (or after 2 consecutive
    connection-class failures) we stop calling Garmin and return only the
    complete rows fetched so far — remaining days are OMITTED, never filled
    with fake zeros. Consumers must treat missing days as no-data."""
    user_id = _clean_user_id(userId)
    days = max(1, min(days, 30))
    client = _get_client(user_id)
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
            _drop_client_on_auth_error(exc, user_id)
            return default
        except Exception as exc:  # noqa: BLE001
            logger.info("%s failed (%s): %s", label, type(exc).__name__, exc)
            _drop_client_on_auth_error(exc, user_id)
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
def activities(days: int = Query(default=14), userId: str = Query(default="")) -> list[dict[str, Any]]:
    """Running activities (running/trail_running/ultra/... only), most recent
    first (Garmin's default sort). Returns [] when not logged in."""
    user_id = _clean_user_id(userId)
    days = max(1, min(days, 90))
    client = _get_client(user_id)
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
        user_id=user_id,
    )
    if not isinstance(raw, list):
        return []
    return [mapped for item in raw if (mapped := running_activity(item)) is not None]


@app.post("/workouts/push")
def push_workouts(body: PushBody) -> list[dict[str, Any]]:
    """Per workout: build JSON -> create on Garmin -> schedule on its date.
    One failing item never aborts the batch."""
    user_id = _clean_user_id(body.userId)
    client = _get_client(user_id)
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
            result["error"] = _last_error(user_id) or "not logged in"
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
            _drop_client_on_auth_error(exc, user_id)
            result["error"] = f"{type(exc).__name__}: {exc}"
        results.append(result)
    return results


@app.post("/workouts/delete")
def delete_workouts(body: DeleteBody) -> list[dict[str, Any]]:
    """Per-id delete; ids that are already gone count as deleted. One failing
    id never aborts the batch."""
    user_id = _clean_user_id(body.userId)
    client = _get_client(user_id)
    results: list[dict[str, Any]] = []
    for raw_id in body.workoutIds:
        workout_id = str(raw_id)
        result: dict[str, Any] = {"workoutId": workout_id, "deleted": False, "error": None}
        if client is None:
            result["error"] = _last_error(user_id) or "not logged in"
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
                _drop_client_on_auth_error(exc, user_id)
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

    # Bind dual-stack (IPv6 + IPv4), not 0.0.0.0 which is IPv4-only. Container
    # platforms (e.g. Coolify) resolve this sidecar's service name to an IPv6
    # address, so the Node proxy connects over IPv6; an IPv4-only socket
    # silently refuses those connections. "::" with the Linux default
    # IPV6_V6ONLY=0 accepts both families.
    uvicorn.run(app, host="::", port=PORT)
