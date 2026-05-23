# lockin

Native iPhone-first SwiftUI app for training from a measured starting point toward strict unbroken calisthenics goals:

- 50 pull-ups
- 100 push-ups
- 5:00 plank

The app is built as a production-style personal coach: baseline and target inputs, exact weekly sessions, adaptive deloads, score penalties, app-specific ranks with real-world benchmark anchors, strict reminders, SwiftData persistence, CloudKit-ready model configuration, and a local OpenAI proxy boundary with a bundled coach skill.

## Run

Open `FitnessApp.xcodeproj` in Xcode, or build from the command line:

```bash
xcodebuild \
  -project FitnessApp.xcodeproj \
  -scheme FitnessApp \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  build
```

## Local AI proxy

The iOS app never stores an OpenAI API key. Start the local proxy when using AI coaching:

```bash
cd Proxy
npm install
cp .env.example .env
npm run dev
```

The app defaults to `http://127.0.0.1:8787`. The proxy loads the `fitness-coach-planner` skill bundle, summarizes recent and monthly training history, asks OpenAI for schema-valid JSON, and rejects unsafe plans before the app accepts them.

Put the real OpenAI API key in `Proxy/.env`, which is ignored by git. Do not put the key in the iOS app or commit it to the repo.
