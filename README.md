# lockin

lockin is a native iOS training app for strict calisthenics goals. It starts from the athlete's current numbers, builds an exact weekly plan, tracks completed and missed sessions, and uses a hosted AI coach proxy to generate future workouts without putting an OpenAI API key in the mobile app.

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

## Current platforms

- `FitnessApp/` is the iOS app, written in SwiftUI and SwiftData.
- `FitnessAppTests/` and `FitnessAppUITests/` cover the current iOS behavior.
- `Proxy/` is a small Node/TypeScript server used by the mobile app for AI coach calls.
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
        |
        v
OpenAI Responses API
```

Important boundaries:

- Training data is stored locally on the device with SwiftData. The hosted proxy is not a user-data database.
- CloudKit is configured as a private iCloud option/fallback path for iOS storage, not as a shared backend for Android.
- The OpenAI API key must only exist in the proxy environment.
- The mobile app should call the hosted proxy over HTTPS.
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
- `POST /generate-week-plan` returns a validated weekly training plan.
- `POST /coach-verdict` returns a short coach read on the athlete's current state.

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

## Run the proxy locally

```bash
cd Proxy
npm install
cp .env.example .env
npm run dev
```

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

There are two deployable pieces: the iOS app and the coach proxy.

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

## Repo map

```text
FitnessApp/          iOS SwiftUI app
FitnessAppTests/     iOS unit tests
FitnessAppUITests/   iOS UI tests
Proxy/               hosted OpenAI coach proxy
Design/              design handoff and reference material, when present locally
```

## Notes for contributors

- Keep secrets out of the mobile clients and out of git.
- Treat the proxy JSON contract as shared mobile infrastructure.
- Keep iOS-specific persistence details out of the Android architecture unless they map cleanly to Android local storage.
- If server-side sync is added later, it should be a separate authenticated API. Do not make mobile clients talk directly to a server-side SQLite database.
