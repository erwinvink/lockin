# Lockin

Lockin is a native iPhone training app for turning personal fitness goals into
daily, trackable work.

The current app started from a strict calisthenics mission: move from a measured
starting point toward unbroken goals like 50 pull-ups, 100 push-ups, and a
5-minute plank. It has since grown into a broader training journal direction:
strength work, ultra-running preparation, coach feedback, progress tracking, and
eventually richer check-ins and journal context.

It is not a generic workout list. The product idea is closer to an intelligent
training notebook: capture the work, keep the standards visible, make the next
session clear, and let a coach layer adapt plans from actual history.

## What The App Does

- Sets up a personal athlete profile with baseline strength numbers, goal
  targets, equipment, weekly training shape, strict-form agreement, and injury
  notes.
- Creates and tracks strength sessions for pull-ups, push-ups, plank, accessory
  work, recovery, deloads, and mixed sessions.
- Tracks ultra-running profile inputs such as target race date, weekly running
  volume, long-run distance, easy pace, heart-rate zones, terrain, run/walk
  strategy, and injury notes.
- Shows a daily Today view with due sessions, workout prescriptions, run
  prescriptions, rank, XP, and recent readiness signals.
- Lets the athlete log strength sessions and runs with effort, pain, fatigue,
  notes, and running-specific data like distance, elevation, heart rate, pacing,
  carbs, fluid, sodium, and GI issues.
- Keeps progress visible through ranks, XP, consistency, penalties, strength
  metrics, and ultra-running progress summaries.
- Provides an AI Coach screen that can generate a validated strength training
  week, produce a short coach read after recent logs, and generate local
  ultra-running weeks.

## Product Direction

Lockin is being shaped as a serious personal training system for endurance-minded
athletes, not just a gym tracker.

The current strength app is the base. The ultra-running domain is already present
in the iOS models and UI. The roadmap points toward separate coach domains for
strength, running, and later journaling/check-ins, with a synthesis coach that can
reason across all of them.

The important product boundary: the iPhone app should stay calm, fast, and
manual-first. More complex coach logic, private instructions, schema validation,
and context assembly should live on the server/proxy side where they can be
tested and versioned.

## Main Screens

- `Today`: the command center for the current training day.
- `Progress`: strength and running progress snapshots.
- `Coach`: AI week generation, coach verdicts, ultra-week generation, and model
  settings.
- `Log`: calendar/history view for planned, completed, missed, and deloaded work.
- `Profile`: athlete settings, strength targets, ultra-running profile, and reset
  controls.

## Architecture

The repo has two main parts:

```text
FitnessApp/      Native SwiftUI iOS app
FitnessAppTests/ Unit tests for engine, validation, persistence reset, etc.
FitnessAppUITests/
Proxy/           Node/TypeScript OpenAI coach proxy
ROADMAP.md       Longer product and architecture roadmap
```

The iOS app uses:

- SwiftUI for the UI.
- SwiftData for local persistence.
- An optional CloudKit-backed model container when launched with
  `EnableCloudKit` or `ENABLE_CLOUDKIT=1`.
- A local fallback store if CloudKit container creation fails.
- No OpenAI API key in the app.

The proxy uses:

- Node.js and TypeScript.
- OpenAI Responses API calls.
- A bundled `fitness-coach-planner` skill.
- Server-side context building from recent logs, monthly history, planned
  sessions, readiness, and risk flags.
- JSON-schema output from the model.
- Technical validation before a generated week is accepted.

## AI Coach Boundary

The iOS app calls the hosted coach proxy:

```text
https://lockin.elevenfactor.com
```

Current proxy routes:

- `GET /health`: confirms the proxy is running and whether an API key is set.
- `GET /models`: returns available text model IDs for the app picker.
- `POST /generate-week-plan`: generates a schema-valid strength week.
- `POST /coach-verdict`: generates a short coach read from the latest context.

The app sends baseline numbers, goals, equipment, target date, planned sessions,
recent logs, and selected model ID. The proxy keeps the OpenAI key and coach
instructions server-side.

## Run The iOS App

Open `FitnessApp.xcodeproj` in Xcode, select the `FitnessApp` scheme, and run on
an iOS simulator or a signed physical device.

Command-line build example:

```bash
xcodebuild \
  -project FitnessApp.xcodeproj \
  -scheme FitnessApp \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  build
```

To enable CloudKit explicitly:

```bash
ENABLE_CLOUDKIT=1 xcodebuild \
  -project FitnessApp.xcodeproj \
  -scheme FitnessApp \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  build
```

## Run The Proxy Locally

```bash
cd Proxy
npm install
cp .env.example .env
npm run dev
```

Set the real OpenAI key in `Proxy/.env` or in the hosted server environment:

```text
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5-mini
PORT=8787
```

Do not commit `.env`. The app should never contain the OpenAI API key.

## Test

iOS tests:

```bash
xcodebuild \
  -project FitnessApp.xcodeproj \
  -scheme FitnessApp \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  test
```

Proxy tests and typecheck:

```bash
cd Proxy
npm test
npm run typecheck
```

## Current Status

The current app is a personal-device-first training system with local SwiftData
storage and a hosted AI coach proxy. It already contains strength and
ultra-running domains. Server-side persistence, accounts, HealthKit, Apple Watch,
full journaling, and multi-coach orchestration are roadmap items, not finished
product surfaces yet.
