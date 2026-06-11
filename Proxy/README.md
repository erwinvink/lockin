# OpenAI coach proxy

This proxy keeps the OpenAI API key out of the iOS app.

```bash
npm install
cp .env.example .env
npm run dev
```

Put the real `OPENAI_API_KEY` in `.env`. Keep `.env` local or on your server only; commit `.env.example`, not `.env`. `GARMIN_SERVICE_URL` points at the internal Garmin sidecar (`GarminService/`), defaulting to `http://127.0.0.1:8788`.

When the athlete has a race goal, the app calls `POST /generate-week`: the proxy plans the running week first with `src/coach/skills/running-coach-planner`, validates it, then plans the strength week around the accepted runs with `src/coach/skills/fitness-coach-planner` and cross-checks the combined week. The coach context for `/generate-week` and `/coach-verdict` is enriched with Garmin wellness and activities when the sidecar is reachable.

The legacy strength-only route `POST https://lockin.elevenfactor.com/generate-week-plan` still accepts local training data and the selected model ID. The proxy loads `src/coach/skills/fitness-coach-planner`, builds a deterministic coaching context, calls OpenAI with the skill instructions and references, and runs technical validation on the structured JSON before the app accepts it. This route intentionally skips Garmin enrichment.

Garmin passthrough routes (all proxied to the sidecar, never exposing it publicly):

- `GET /garmin/status` — sidecar reachability plus Garmin login state (`{ok, loggedIn, lastError}`).
- `GET /garmin/snapshot?sinceDays=N` — status, wellness days, and running activities in one response (default 7).
- `POST /garmin/push-workouts` — body `{workouts: [...]}`; pushes planned runs to the watch as scheduled structured workouts.
- `POST /garmin/delete-workouts` — body `{workoutIds: [...]}`; deletes previously pushed workouts.

Push/delete contract: the app-facing response shape is `{results: [...], error?}` and is canonical — the sidecar returns bare result arrays today, and `src/garmin/garmin-client.ts` normalizes both shapes so neither side breaks the other.

Check `GET https://lockin.elevenfactor.com/health` to confirm the proxy is running and has an API key. The app's AI Coach context tab stores the selected model ID and can refresh available text model IDs through `GET https://lockin.elevenfactor.com/models`.

The request includes baseline numbers, target goals, sessions per week, equipment, target date, recent SwiftData logs, and planned/completed sessions. Each log marks whether pull-ups, push-ups, and plank were actually tested so the model does not treat an unlogged exercise as a zero.
