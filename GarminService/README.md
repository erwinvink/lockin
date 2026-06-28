# GarminService — lockin Garmin sidecar

Small internal-only FastAPI service that wraps Garmin Connect for the lockin
coach. The Node proxy (`Proxy/`) calls it over localhost; it is never exposed
publicly. All Garmin network/auth code lives in `main.py` (degraded-mode
branches covered by `test_main.py` with a fake client, no network);
`garmin_mapping.py` is pure (no network, no garminconnect import) and fully
covered by `test_garmin_mapping.py`.

## Setup

```bash
cd GarminService
python3 -m venv .venv            # Python 3.11+
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env             # optional: fill default/legacy Garmin credentials
```

Env vars (read from `.env` in this directory, real env wins):

| Var | Default | Meaning |
| --- | --- | --- |
| `GARMIN_EMAIL` | — | Garmin Connect account email |
| `GARMIN_PASSWORD` | — | Garmin Connect account password |
| `GARMIN_DEFAULT_USER_ID` | `default` | Legacy/default user id for routes without `userId` |
| `GARMIN_TOKENS_DIR` | `./tokens` | Where OAuth tokens are persisted (relative paths resolve against this directory) |
| `PORT` | `8788` | Listen port (used by `python main.py`) |

`GARMIN_EMAIL` and `GARMIN_PASSWORD` are now only for the legacy/default
server account and the CLI login. The in-app beta flow posts a user's Garmin
email/password to `POST /connect` once, saves Garmin session tokens under that
Lockin `userId`, and does not persist the password.

## One-time login

Garmin may require MFA on first login, which a headless server can't answer.
Run once interactively:

```bash
python main.py login
```

This logs in (prompting for an MFA code if Garmin asks, and for credentials
if they're not in `.env`) and saves tokens to `GARMIN_TOKENS_DIR`. After
that the service resumes from tokens — login order is always: token-dir
resume first, then email/password (which writes fresh tokens).

## Run

```bash
uvicorn main:app --port 8788
# or: python main.py   (binds 0.0.0.0:$PORT, for containers)
```

## API

- `POST /connect` body `{"userId","email","password","mfaCode"?}` → status
  with `state: "connected" | "mfa_required" | "not_connected"`. If MFA is
  required, call it again with the same credentials plus `mfaCode`.
- `POST /disconnect` body `{"userId"}` → drops the cached client and removes
  that user's token directory.
- `GET /status?userId=...` → `{"ok": true, "userId": str, "loggedIn": bool,
  "state": str, "connectedEmail": str|null, "lastError": str|null}`.
  Auth problems never crash the service; they show up here. After a failed
  login the sidecar waits 60s before trying again — requests during that
  cooldown return the logged-out degraded state immediately instead of
  hammering Garmin SSO.
- `GET /wellness?userId=...&days=N` (default 7, max 30, clamped) → list of
  `{"date","sleepScore","sleepSeconds","hrvStatus","hrvMs","bodyBattery",
  "trainingReadiness","restingHr"}` — one per calendar day, **most recent
  first**. Missing metrics (older watch, no data) degrade to `0`/`""`.
  Returns `[]` when not logged in. **The list may be shorter than `days`**:
  when Garmin throttles (first 429) or fails 2 connection-class calls in a
  row, the response is truncated to the complete rows fetched so far —
  remaining days are omitted, never zero-filled. Consumers must treat a
  missing day as "no data" and must not fabricate zeros for it.
- `GET /activities?userId=...&days=N` (default 14, max 60, clamped) → running activities
  only (typeKey containing `running`/`ultra`), most recent first:
  `{"garminActivityId","startTime","activityType","distanceKm",
  "movingSeconds","elevationGainM","averageHr","averagePaceSecPerKm","name"}`.
- `POST /workouts/push` body `{"userId","workouts":[{"sessionId","title","date","kind",
  "distanceKm","durationMinutes","target":{"type","low","high"},"notes"}]}` →
  per item `{"sessionId","garminWorkoutId","scheduled","error"}`. Creates a
  structured workout (hard kinds get warmup/main/cooldown; easy/recovery one
  steady step) and schedules it on `date`. Pace targets are sec/km in, m/s
  speed zones out. One failure never aborts the batch.
- `POST /workouts/delete` body `{"userId","workoutIds":[...]}` → per id
  `{"workoutId","deleted","error"}`. Already-deleted ids count as deleted.

## Coolify deployment

- Deploy as a **second app** from this repo (build context `GarminService/`),
  alongside the Node proxy.
- Internal port **8788**, **no public domain** — the proxy reaches it over the
  internal network only.
- Mount a **persistent volume** at `GARMIN_TOKENS_DIR` so tokens survive
  redeploys (otherwise every deploy needs a fresh interactive login).
- Set `GARMIN_EMAIL`/`GARMIN_PASSWORD` as secrets. For the first login with
  MFA, run `python main.py login` inside the container (or generate the
  tokens locally and copy them to the volume).

## Pinned library surface (garminconnect==0.3.5)

Verified by inspection on install (this is the rewritten 0.3.x line: no
`garth` dependency; HTTP via `curl_cffi`/`requests` behind `client.py`).
Method names change between versions — re-inspect before upgrading:

```python
Garmin(email=None, password=None, is_cn=False, prompt_mfa=None,
       return_on_mfa=False, retry_attempts=3, ...)
Garmin.login(tokenstore=None)          # token resume -> credentials -> dumps tokens
Garmin.get_sleep_data(cdate)           # dict: dailySleepDTO.sleepTimeSeconds, .sleepScores.overall.value
Garmin.get_hrv_data(cdate)             # dict|None: hrvSummary.lastNightAvg, .status
Garmin.get_body_battery(start, end)    # list[day]: bodyBatteryValuesArray [ts, status, level, ver]
Garmin.get_training_readiness(cdate)   # list[dict]: score
Garmin.get_rhr_day(cdate)              # dict: allMetrics.metricsMap.WELLNESS_RESTING_HEART_RATE[0].value
Garmin.get_activities_by_date(start, end, activitytype=None, sortorder=None)
Garmin.upload_workout(workout_json)    # POST workout-service/workout -> {workoutId, ...}
Garmin.schedule_workout(workout_id, "YYYY-MM-DD")
Garmin.delete_workout(workout_id)
# exceptions: GarminConnectAuthenticationError, GarminConnectConnectionError,
#             GarminConnectTooManyRequestsError, HTTPError
```

Structured-workout JSON constants follow `garminconnect.workout`:
sport running=1; steps warmup=1/cooldown=2/interval=3; end conditions
distance=1/time=2; targets no.target=1, heart.rate.zone=4, speed.zone=5
(`targetValueOne` = low bound, `targetValueTwo` = high bound — for pace the
faster sec/km bound becomes the *higher* m/s speed bound).

## Tests

```bash
.venv/bin/python -m pytest
```
