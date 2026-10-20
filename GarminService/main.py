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
from typing import Any, NamedTuple

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)
from garmin_mapping import (
    build_workout,
    running_activity,
    tag_workout,
    tagged_session_fingerprints,
    unavailable_metrics,
    wellness_day,
    workout_fingerprint,
)

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


class InvalidUserIdError(ValueError):
    """A userId that is not a plain token-dir name (answered with HTTP 400)."""


# Letters, digits, "_" and "-" only: no "." or "/" can ever reach a path.
_USER_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,120}")


def _user_tokens_path(user_id: str | None) -> Path:
    """tokens/ for the default user, tokens/users/<id> otherwise. Refuses any
    id whose resolved path is not a direct child of users/, before anything
    is read, written or removed."""
    base = _tokens_base_dir()
    if not user_id:
        return base
    users = (base / "users").resolve()
    path = (users / _clean_user_id(user_id)).resolve()
    if path.parent != users or not path.is_relative_to(users):
        raise InvalidUserIdError("userId is not a valid Lockin user id")
    return path


def _tokens_dir(user_id: str | None = None) -> str:
    path = _user_tokens_path(user_id)
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:
        pass
    return str(path)


def _default_user_id() -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", GARMIN_DEFAULT_USER_ID.strip())[:120] or "default"


def _clean_user_id(value: str | None) -> str:
    """The validated userId; empty means the default (legacy/CLI) user."""
    raw = (value or "").strip()
    if not raw:
        return _default_user_id()
    if not _USER_ID_RE.fullmatch(raw):
        raise InvalidUserIdError("userId is not a valid Lockin user id")
    return raw


def _is_default_user(user_id: str) -> bool:
    return user_id == _default_user_id()


def _token_files_exist(user_id: str | None = None) -> bool:
    path = _user_tokens_path(user_id)
    return path.is_dir() and any(item.is_file() and item.name != "lockin-connection.json" for item in path.rglob("*"))


def _metadata_path(user_id: str) -> Path:
    return _user_tokens_path(user_id) / "lockin-connection.json"


def _write_metadata(user_id: str, email: str) -> None:
    _tokens_dir(user_id)
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


# Marker for "this Garmin call failed", as opposed to None ("Garmin has no
# data"). Only /wellness distinguishes the two.
_FETCH_FAILED = object()

_STATUS_CODE_RE = re.compile(r"(?:API Error|HTTP)\s*(\d{3})")


def _http_status_of(exc: Exception) -> int | None:
    for candidate in (getattr(exc, "status_code", None), getattr(getattr(exc, "response", None), "status_code", None)):
        if isinstance(candidate, int):
            return candidate
    match = _STATUS_CODE_RE.search(str(exc))
    return int(match.group(1)) if match else None


def _is_no_data_error(exc: Exception) -> bool:
    """Only 204/404 mean "Garmin has nothing for this day" (older watches
    without readiness, no sleep recorded). Every other failure is a failure."""
    return _http_status_of(exc) in (204, 404)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

app = FastAPI(title="lockin Garmin sidecar", docs_url=None, redoc_url=None)


@app.exception_handler(InvalidUserIdError)
def _invalid_user_id(_request: Any, exc: InvalidUserIdError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"error": str(exc)})


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
    with _client_lock:
        _purge_expired_mfa()
    client = _get_client(user_id)
    return _status_payload(user_id, client is not None)


class _PendingMFA(NamedTuple):
    """A credential login waiting for its MFA code. garminconnect keeps the
    MFA session on the client object, so the SAME object must be resumed:
    a new login would make Garmin email a new code and void the old one."""

    client: Any
    state: Any
    email: str
    started_at: float


# How long a login waits for its MFA code before /connect starts over.
_MFA_PENDING_SECONDS = 300.0
_pending_mfa: dict[str, _PendingMFA] = {}

_MFA_NEEDED_MESSAGE = "Garmin needs the MFA code for this login."


def _purge_expired_mfa() -> None:
    """Drop pending MFA logins past their window (they hold a live SSO
    session). Called on every /connect and /status."""
    now = time.monotonic()
    for user_id, pending in list(_pending_mfa.items()):
        if now - pending.started_at > _MFA_PENDING_SECONDS:
            _pending_mfa.pop(user_id, None)


def _forget_password(client: Any) -> None:
    """resume_login only needs the MFA session, not the password: drop the
    copies garminconnect 0.3.5 keeps (Garmin.password, and the widget flow's
    saved credential response, whose prepared request body has the form)."""
    if hasattr(client, "password"):
        client.password = None
    saved = getattr(getattr(client, "client", None), "_widget_last_resp", None)
    request = getattr(saved, "request", None)
    if request is not None and hasattr(request, "body"):
        request.body = None


def _connect_succeeded(user_id: str, client: Any, email: str) -> dict[str, Any]:
    """Persist the new session's tokens under the user, then resume from them
    the normal way (tokens + profile), exactly like every later request.
    Caller holds _client_lock."""
    tokenstore = _tokens_dir(None if _is_default_user(user_id) else user_id)
    inner = getattr(client, "client", None)
    if callable(getattr(inner, "dump", None)):
        # return_on_mfa logins and resume_login don't save tokens themselves.
        inner.dump(tokenstore)
    resumed = Garmin(retry_attempts=1)
    resumed.login(tokenstore=tokenstore)
    _pending_mfa.pop(user_id, None)
    _set_cached_client(user_id, resumed)
    _set_last_error(user_id, None)
    _set_login_failed_at(user_id, None)
    _write_metadata(user_id, email)
    logger.info("Garmin connect OK for %s", user_id)
    return _status_payload(user_id, True, "connected")


def _finish_connect(user_id: str, client: Any, email: str) -> dict[str, Any]:
    try:
        return _connect_succeeded(user_id, client, email)
    except Exception as exc:  # noqa: BLE001
        _pending_mfa.pop(user_id, None)
        return _connect_failed(user_id, exc, mfa_pending=False)


def _connect_failed(user_id: str, exc: Exception, *, mfa_pending: bool) -> dict[str, Any]:
    _set_last_error(user_id, f"{type(exc).__name__}: {exc}")
    logger.warning("Garmin connect failed for %s: %s", user_id, _last_error(user_id))
    if mfa_pending:
        _set_last_error(user_id, "Garmin did not accept that MFA code. Check the latest code and try again.")
        return _status_payload(user_id, False, "mfa_required")
    if _is_mfa_required_error(exc):
        _set_last_error(user_id, _MFA_NEEDED_MESSAGE)
        return _status_payload(user_id, False, "mfa_required")
    _set_login_failed_at(user_id, time.monotonic())
    return _status_payload(user_id, False, "not_connected")


@app.post("/connect")
def connect(body: ConnectBody) -> dict[str, Any]:
    """Two-request MFA flow (garminconnect 0.3.5): the first call logs in with
    return_on_mfa=True and, if Garmin asks for a code, keeps that login for a
    few minutes and answers mfa_required. The next call with mfaCode resumes
    the SAME login via resume_login(state, code). A code with no pending login
    (expired, sidecar restarted) starts one and tries the code right away,
    which works for authenticator-app codes.

    Always a fresh credential (SSO) login: no tokenstore is passed, because
    garminconnect 0.3.5 loads stored tokens first and then never checks the
    password (and, with return_on_mfa, never falls back to it when those
    tokens are rejected). A failed attempt leaves a working connection alone.
    Note: the library also reads the GARMINTOKENS env var as a tokenstore, so
    the sidecar must not set it."""
    user_id = _clean_user_id(body.userId)
    email = body.email.strip()
    if not email or not body.password:
        _set_last_error(user_id, "Garmin email and password are required.")
        return _status_payload(user_id, False, "credentials_required")
    code = (body.mfaCode or "").strip()

    with _client_lock:
        _purge_expired_mfa()
        pending = _pending_mfa.get(user_id)
        if pending is not None and pending.email != email:
            _pending_mfa.pop(user_id, None)
            pending = None

        if pending is None:
            def prompt_mfa() -> str:
                # Unused with return_on_mfa=True; kept as a safe fallback.
                raise MFARequiredError("MFA code required")

            client = Garmin(
                email=email,
                password=body.password,
                prompt_mfa=prompt_mfa,
                return_on_mfa=True,
                # Library default is 3 retries with 15s timeouts.
                retry_attempts=1,
            )
            try:
                result = client.login()
            except Exception as exc:  # noqa: BLE001 — sidecar must stay up
                return _connect_failed(user_id, exc, mfa_pending=False)
            status = result[0] if isinstance(result, tuple) and result else None
            if status != "needs_mfa":
                return _finish_connect(user_id, client, email)
            _forget_password(client)
            pending = _PendingMFA(client, result[1], email, time.monotonic())
            _pending_mfa[user_id] = pending
            if not code:
                _set_last_error(user_id, _MFA_NEEDED_MESSAGE)
                return _status_payload(user_id, False, "mfa_required")

        if not code:
            _set_last_error(user_id, _MFA_NEEDED_MESSAGE)
            return _status_payload(user_id, False, "mfa_required")
        try:
            pending.client.resume_login(pending.state, code)
        except Exception as exc:  # noqa: BLE001 — keep the login so the code can be retyped
            return _connect_failed(user_id, exc, mfa_pending=True)
        return _finish_connect(user_id, pending.client, email)


@app.post("/disconnect")
def disconnect(body: DisconnectBody) -> dict[str, Any]:
    user_id = _clean_user_id(body.userId)
    with _client_lock:
        _pending_mfa.pop(user_id, None)
        _set_cached_client(user_id, None)
        _set_last_error(user_id, None)
        _set_login_failed_at(user_id, None)
    if not _is_default_user(user_id):
        shutil.rmtree(_tokens_dir(user_id), ignore_errors=True)
    return _status_payload(user_id, False, "not_connected")


@app.get("/wellness")
def wellness(days: int = Query(default=7), userId: str = Query(default="")) -> list[dict[str, Any]]:
    """One wellness_day dict per date, MOST RECENT FIRST (today at index 0).
    Returns [] when not logged in. Per metric, "Garmin has no data" (204/404)
    degrades to 0/"" silently, while a FAILED call also keeps the 0/""
    placeholder but lists the field in the row's `unavailableMetrics`, so
    consumers never store it as a real value.

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

    def fetch(label: str, fn: Any, *args: Any) -> Any:
        """_safe plus batch-level circuit breaking: once stopped, no further
        Garmin calls happen for this request. Returns None when Garmin has no
        data (204/404) and _FETCH_FAILED when the call itself failed."""
        nonlocal stop, conn_failures
        if stop:
            return _FETCH_FAILED
        try:
            with _io_lock:
                result = fn(*args)
        except GarminConnectTooManyRequestsError as exc:
            stop = True
            logger.warning("%s throttled — truncating wellness batch: %s", label, exc)
            return _FETCH_FAILED
        except Exception as exc:  # noqa: BLE001
            if _is_no_data_error(exc):
                # e.g. no training readiness on older watches: a real answer.
                logger.info("%s has no data: %s", label, exc)
                conn_failures = 0
                return None
            logger.info("%s failed (%s): %s", label, type(exc).__name__, exc)
            if isinstance(exc, GarminConnectConnectionError):
                conn_failures += 1
                if conn_failures >= 2:
                    stop = True
                    logger.warning(
                        "%d consecutive connection failures — truncating wellness batch",
                        conn_failures,
                    )
            _drop_client_on_auth_error(exc, user_id)
            return _FETCH_FAILED
        conn_failures = 0
        return result

    today = date.today()
    dates = [today - timedelta(days=offset) for offset in range(days)]
    start_iso, end_iso = dates[-1].isoformat(), dates[0].isoformat()

    # Body battery covers the whole range in one call; mapping filters by date.
    body_battery = fetch("get_body_battery", client.get_body_battery, start_iso, end_iso)

    out: list[dict[str, Any]] = []
    for d in dates:
        if stop:
            break
        iso = d.isoformat()
        sources = {
            "sleep": fetch("get_sleep_data", client.get_sleep_data, iso),
            "hrv": fetch("get_hrv_data", client.get_hrv_data, iso),
            "body_battery": body_battery,
            "readiness": fetch("get_training_readiness", client.get_training_readiness, iso),
            "rhr": fetch("get_rhr_day", client.get_rhr_day, iso),
        }
        if stop:
            break  # the row that tripped the breaker is partial — omit it
        failed = {name for name, value in sources.items() if value is _FETCH_FAILED}
        values = {name: (None if value is _FETCH_FAILED else value) for name, value in sources.items()}
        row = wellness_day(
            iso,
            values["sleep"],
            values["hrv"],
            values["body_battery"],
            values["readiness"],
            values["rhr"],
        )
        unavailable = unavailable_metrics(row, failed)
        if unavailable:
            row["unavailableMetrics"] = unavailable
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


_push_locks: dict[str, threading.Lock] = {}
_push_locks_guard = threading.Lock()

# Workout-library pages scanned for tagged leftovers before creating.
_WORKOUT_LIST_PAGE = 100
_WORKOUT_LIST_MAX_PAGES = 5


def _push_lock(user_id: str) -> threading.Lock:
    """One push at a time per user: a retry that arrives while a timed-out
    push is still running waits for it, then finds its workouts by tag."""
    with _push_locks_guard:
        return _push_locks.setdefault(user_id, threading.Lock())


def _list_workouts(client: Garmin, user_id: str) -> list[Any] | None:
    """The user's workout library (first few pages), or None on failure."""
    listed: list[Any] = []
    try:
        for page in range(_WORKOUT_LIST_MAX_PAGES):
            with _io_lock:
                batch = client.get_workouts(page * _WORKOUT_LIST_PAGE, _WORKOUT_LIST_PAGE)
            if not isinstance(batch, list):
                break
            listed.extend(batch)
            if len(batch) < _WORKOUT_LIST_PAGE:
                break
    except Exception as exc:  # noqa: BLE001 — degrade to "create", never fail the push
        logger.warning("get_workouts failed (%s): %s — pushing without reuse check", type(exc).__name__, exc)
        _drop_client_on_auth_error(exc, user_id)
        return None
    return listed


def _is_scheduled_on(client: Garmin, workout_id: str, date_str: str) -> bool | None:
    """Whether the calendar already has this workout on date_str (None when
    the calendar can't be read)."""
    try:
        year, month = int(date_str[0:4]), int(date_str[5:7])
        with _io_lock:
            calendar = client.get_scheduled_workouts(year, month)
    except Exception as exc:  # noqa: BLE001
        logger.info("get_scheduled_workouts failed (%s): %s", type(exc).__name__, exc)
        return None
    items = calendar.get("calendarItems") if isinstance(calendar, dict) else None
    if not isinstance(items, list):
        return None
    return any(
        isinstance(item, dict) and str(item.get("workoutId")) == workout_id and item.get("date") == date_str
        for item in items
    )


def _garmin_id(workout_id: str) -> Any:
    return int(workout_id) if workout_id.isdigit() else workout_id


@app.post("/workouts/push")
def push_workouts(body: PushBody) -> list[dict[str, Any]]:
    """Per workout: build JSON -> create on Garmin -> schedule on its date.
    One failing item never aborts the batch.

    Idempotent: created workouts are tagged "lockin:<sessionId>:<fingerprint>"
    and an existing workout with the same tag is reused (and scheduled only if
    it isn't on the calendar yet) instead of creating a duplicate. A leftover
    with the same session but outdated content is deleted first."""
    user_id = _clean_user_id(body.userId)
    client = _get_client(user_id)
    results: list[dict[str, Any]] = []
    with _push_lock(user_id):
        library: list[Any] | None = None
        listed = False
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
                date_str = str(payload.get("date", "") or "")
                fingerprint = workout_fingerprint(payload)
                reused_id: str | None = None
                if session_id:
                    if not listed:
                        library = _list_workouts(client, user_id)
                        listed = True
                    for existing_id, existing_fingerprint in tagged_session_fingerprints(library or [], session_id):
                        if existing_fingerprint == fingerprint and reused_id is None:
                            reused_id = existing_id
                            continue
                        # Same session, outdated content (or a second copy):
                        # an orphan of an earlier push — remove it, best effort.
                        try:
                            with _io_lock:
                                client.delete_workout(existing_id)
                        except Exception as exc:  # noqa: BLE001
                            logger.info("delete of orphan %s failed: %s", existing_id, exc)

                if reused_id is not None:
                    workout_id: Any = _garmin_id(reused_id)
                    already_scheduled = bool(date_str) and _is_scheduled_on(client, reused_id, date_str) is True
                    logger.info("reusing tagged workout %s for session %s", reused_id, session_id)
                else:
                    workout_json = build_workout(payload)
                    if session_id:
                        workout_json = tag_workout(workout_json, session_id, fingerprint)
                    with _io_lock:
                        created = client.upload_workout(workout_json)
                    workout_id = (created or {}).get("workoutId") if isinstance(created, dict) else None
                    already_scheduled = False
                    if workout_id is None:
                        result["error"] = "Garmin did not return a workoutId"
                        results.append(result)
                        continue
                result["garminWorkoutId"] = str(workout_id)

                if not date_str:
                    result["error"] = "missing date; workout created but not scheduled"
                elif already_scheduled:
                    result["scheduled"] = True
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
