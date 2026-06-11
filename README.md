# lockin

lockin is a native iOS training app for strict calisthenics goals. It starts from the athlete's current numbers, builds an exact weekly plan, tracks completed and missed sessions, and uses a hosted AI coach proxy to generate future workouts without putting an OpenAI API key in the mobile app. Alongside the strength goals it can coach toward an ultrarunning race goal, with two-way Garmin sync through a small server-side sidecar.

The app is currently iOS only. This repository should be treated as the reference implementation for an Android client: copy the product behavior and API contract, not the SwiftUI code.

## What the app does

lockin is built around measurable bodyweight goals:

- Pull-ups
- Push-ups
- Plank

The default goal profile is 50 pull-ups, 100 push-ups, and a 5 minute plank, but the user can change their targets during onboarding.

Core app flow:

- Onboard with name, current maxes, target maxes, target date, available equipment, training days, strict-form agreement, and pain/injury notes.
- Generate an AI week from the hosted coach proxy.
- Show today's due workout with sets, reps, holds, rest, planned effort, RPE target, and estimated duration.
- Let the athlete check off work, log actual performance, RPE, pain, fatigue, and notes.
- Track streak, best streak, missed trainings, and latest measured progress against goals.
- Keep a Log screen for open future sessions and completed/missed history.
- Keep a Coach screen for generating a week, refreshing a coach verdict, checking proxy health, and choosing the model.
- Keep a Profile screen for training-day changes, reminders, and full local reset.

### Running goal and ultra coach

lockin also coaches ultrarunning alongside the strength work. The athlete can set a race goal — name, race date, distance in km, and elevation gain in meters — plus preferred running days and a long-run day. With a race goal set, the Coach screen plans the week as one coordinated whole: the runs are planned first (long run, quality work, easy volume), then the strength sessions are scheduled around them so hard days do not collide.

With a Garmin account connected on the server, the sync is two-way:

- Pull: daily wellness (sleep, HRV, body battery, training readiness, resting HR) and completed running activities, which are auto-matched to planned runs as pending logs the athlete confirms.
- Push: planned runs go to the watch as structured Garmin workouts scheduled on their calendar date, with pace or heart-rate targets when the plan sets them.

## Current platforms

- `FitnessApp/` is the iOS app, written in SwiftUI and SwiftData.
- `FitnessAppTests/` and `FitnessAppUITests/` cover the current iOS behavior.
- `Proxy/` is a small Node/TypeScript server used by the mobile app for AI coach calls.
- `GarminService/` is an internal-only Python/FastAPI sidecar the proxy uses for Garmin Connect.
- There is no Android app in this repo yet.

## Architecture

```text
iOS app
  SwiftUI screens
  SwiftData local storage
  optional private CloudKit container
  no OpenAI API key
        |
        | HTTPS JSON
        v
Hosted coach proxy
  Node + TypeScript
  OPENAI_API_KEY in server env only
  validates AI output before returning it
        |                    |
        v                    | internal network only
OpenAI Responses API         v
                    Garmin sidecar (GarminService/)
                      Python + FastAPI
                      python-garminconnect 0.3.5
                      Garmin session tokens on a
                      persistent volume
                             |
                             v
                      Garmin Connect
```

Important boundaries:

- Training data is stored locally on the device with SwiftData. The hosted proxy is not a user-data database.
- CloudKit is configured as a private iCloud option/fallback path for iOS storage, not as a shared backend for Android.
- The OpenAI API key must only exist in the proxy environment.
- The mobile app should call the hosted proxy over HTTPS.
- The Garmin sidecar is never exposed publicly; only the proxy reaches it. The only server-side state in the whole system is the Garmin session tokens on the sidecar's token volume.
- The current app does not have account login or multi-device server sync.

## Android handoff

For Android, build a native client that mirrors the iOS product contract:

- Use local persistence for profile, sessions, prescriptions, logs, rank state, coach plans, and coach verdicts.
- Send the same coach request shape to the proxy when generating a week or verdict.
- Never store an OpenAI API key in the Android app.
- Keep today locked during week refreshes: new AI sessions should be future sessions only.
- Preserve selected training days; the AI plan should schedule only on those selected future days.
- Keep planned effort separate from logged effort:
  - planned effort comes from the generated session or exercise plan
  - actual RPE comes from the athlete's completed log

The most useful iOS source files for the Android builder:

- `FitnessApp/AppModels.swift` - local data model names and fields
- `FitnessApp/CoachClient.swift` - coach request/response structs and endpoint rules
- `FitnessApp/TrainingPlanStore.swift` - persistence behavior for generated plans
- `FitnessApp/TrainingEngine.swift` - local scoring, streak, deload, and fallback planning logic
- `FitnessApp/TodayView.swift` - today's workout and logging flow
- `FitnessApp/CalendarView.swift` - open sessions and history flow
- `FitnessApp/ProgressView.swift` - progress/streak display
- `FitnessApp/CoachView.swift` - proxy/model/AI generation flow
- `Proxy/src/server.ts` - HTTP routes exposed by the coach proxy
- `Proxy/src/coach/skills/fitness-coach-planner/references/weekly-plan.schema.json` - generated weekly-plan schema

## Coach proxy API

Current hosted base:

```text
https://lockin.elevenfactor.com
```

Routes:

- `GET /health` checks whether the proxy is running and whether `OPENAI_API_KEY` is present.
- `GET /models` returns available text model IDs plus the default model.
- `POST /generate-week` returns a coordinated running + strength week. Requires a running race goal in the request; the coach context is enriched with Garmin wellness and activities when the sidecar is reachable.
- `POST /generate-week-plan` is the legacy strength-only route and intentionally skips Garmin enrichment.
- `POST /coach-verdict` returns a short coach read on the athlete's current state.
- `GET /garmin/status` reports sidecar reachability and Garmin login state.
- `GET /garmin/snapshot?sinceDays=N` returns Garmin status, wellness days, and running activities in one response (default 7 days).
- `POST /garmin/push-workouts` pushes planned runs to the watch as scheduled structured workouts.
- `POST /garmin/delete-workouts` deletes previously pushed workouts from Garmin.

The iOS default generation endpoint is:

```text
https://lockin.elevenfactor.com/generate-week-plan
```

The client request includes:

- selected model ID
- baseline pull-ups, push-ups, and plank
- goal pull-ups, push-ups, and plank
- profile notes
- week start
- selected training days and day offsets
- equipment
- target date
- recent performance logs
- planned/completed/missed sessions

## Run the iOS app

Open `FitnessApp.xcodeproj` in Xcode and run the `FitnessApp` scheme on an iPhone simulator or physical iPhone.

Command-line build:

```bash
xcodebuild \
  -project FitnessApp.xcodeproj \
  -scheme FitnessApp \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  build
```

Command-line tests:

```bash
xcodebuild test \
  -project FitnessApp.xcodeproj \
  -scheme FitnessApp \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

## Run the backend locally

One command starts the full local backend — the coach proxy and the Garmin sidecar, always together:

```bash
./scripts/dev.sh
```

It installs missing dependencies on first run, reports whether the local Garmin login is connected (one-time fix: `cd GarminService && .venv/bin/python main.py login`), and stops both servers on Ctrl-C.

The proxy endpoint is configuration, not app state: it is never stored on the device and never shown or editable in the app. Debug builds (anything run from Xcode) talk to `http://127.0.0.1:8787`; Release/TestFlight builds compile the local path out and stay pinned to `https://lockin.elevenfactor.com`. The only override is the `COACH_PROXY_ENDPOINT` environment variable in the Xcode scheme (Product → Scheme → Edit Scheme → Run → Arguments → Environment Variables) — set it to the Mac's LAN IP (for example `http://192.168.1.20:8787`) when running on a physical iPhone.

Put the real key in `Proxy/.env`:

```text
OPENAI_API_KEY=sk-your-key-here
PORT=8787
```

Useful proxy checks:

```bash
npm run typecheck
npm test
curl http://localhost:8787/health
```

## Deploy

There are three deployable pieces: the iOS app, the coach proxy, and the Garmin sidecar.

### iOS

1. Open `FitnessApp.xcodeproj` in Xcode.
2. Select the `FitnessApp` scheme.
3. Configure the signing team, bundle identifier, and iCloud capability as needed for the Apple Developer account.
4. Test on a simulator and a real device.
5. Use Xcode's Archive flow to distribute through TestFlight or the App Store.

The iOS app should point at the hosted proxy:

```text
https://lockin.elevenfactor.com/generate-week-plan
```

### Coach proxy

The proxy is a Node/TypeScript app in `Proxy/`.

Server requirements:

- Node.js runtime
- `npm install`
- `npm start`
- `OPENAI_API_KEY` set in server environment variables
- optional `PORT`, defaulting to `8787`
- HTTPS domain pointing at the running app

Coolify-style setup:

- App/root directory: `Proxy`
- Install command: `npm install`
- Start command: `npm start`
- Environment variables:
  - `OPENAI_API_KEY`
  - `PORT=8787` if the host does not inject its own port
- Health check: `GET /health`
- Public domain: `https://lockin.elevenfactor.com`

After deployment, verify:

```bash
curl https://lockin.elevenfactor.com/health
```

Expected result is JSON with `ok: true` and `hasApiKey: true`.

### Garmin sidecar (GarminService)

The sidecar is a Python/FastAPI app in `GarminService/`. Deploy it as a second Coolify app from this repo, next to the proxy:

- App/root directory: `GarminService`
- Internal port `8788`, and NO public domain — only the proxy reaches it over the internal network.
- Mount a persistent volume at `GARMIN_TOKENS_DIR` so Garmin session tokens survive redeploys.
- Environment variables:
  - `GARMIN_EMAIL` and `GARMIN_PASSWORD` as secrets
  - `GARMIN_TOKENS_DIR` pointing at the mounted volume
  - `TZ=Europe/Amsterdam` so the sidecar's calendar-day math matches the athlete's day
- One-time login: Garmin may ask for MFA, which a headless service cannot answer. Run `python main.py login` once inside the container (or generate tokens locally and copy them to the volume).
- Then set `GARMIN_SERVICE_URL` on the proxy app (the sidecar's internal URL) and redeploy the proxy.

Verify through the proxy:

```bash
curl https://lockin.elevenfactor.com/garmin/status
```

Expected result is JSON with `ok: true` and `loggedIn: true`.

### Garmin sync notes

Accepted contracts and residual risks of the Garmin integration:

- A missing wellness day means "no data", never zeros. The sidecar omits days it could not fetch completely, and consumers must not fabricate zero-filled days.
- When Garmin throttles or repeatedly fails mid-fetch, the wellness window is truncated to the complete days fetched so far; the remaining days are simply absent.
- Pushing runs to the watch is recorded locally after the push succeeds. If that local save fails AND the app terminates before any later save, the watch can hold a scheduled workout the app does not know about; the next push can then schedule a duplicate, which has to be removed in Garmin Connect manually.
- A manual "Sync now" from Settings records the sync timestamp and therefore resets the 30-minute background sync throttle.

## Repo map

```text
FitnessApp/          iOS SwiftUI app
FitnessAppTests/     iOS unit tests
FitnessAppUITests/   iOS UI tests
Proxy/               hosted OpenAI coach proxy
GarminService/       internal-only Garmin Connect sidecar (Python/FastAPI)
docs/plans/          design and implementation plans
Design/              design handoff and reference material, when present locally
```

## Notes for contributors

- Keep secrets out of the mobile clients and out of git.
- Treat the proxy JSON contract as shared mobile infrastructure.
- Keep iOS-specific persistence details out of the Android architecture unless they map cleanly to Android local storage.
- If server-side sync is added later, it should be a separate authenticated API. Do not make mobile clients talk directly to a server-side SQLite database.
