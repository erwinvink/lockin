# lockin

Native iPhone-first SwiftUI app for training from a measured starting point toward strict unbroken calisthenics goals:

- 50 pull-ups
- 100 push-ups
- 5:00 plank

The app is built as a production-style personal coach: baseline and target inputs, exact weekly sessions, adaptive deloads, score penalties, app-specific ranks with real-world benchmark anchors, strict reminders, SwiftData persistence, CloudKit-ready model configuration, and a hosted OpenAI proxy boundary with a bundled coach skill.

## Run

Open `FitnessApp.xcodeproj` in Xcode, or build from the command line:

```bash
xcodebuild \
  -project FitnessApp.xcodeproj \
  -scheme FitnessApp \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  build
```

## Hosted AI proxy

The iOS app never stores an OpenAI API key. It calls the hosted coach proxy:

```text
https://lockin.elevenfactor.com/generate-week-plan
```

The AI Coach context tab stores the selected model ID and loads available text model IDs from the proxy into a picker. The proxy loads the `fitness-coach-planner` skill bundle, summarizes recent and monthly training history, asks OpenAI for schema-valid JSON, and rejects technically invalid output before the app accepts it.

Put the real OpenAI API key in the server environment, for example Coolify's environment variables. Do not put the key in the iOS app or commit it to the repo.
