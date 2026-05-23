# OpenAI coach proxy

This proxy keeps the OpenAI API key out of the iOS app.

```bash
npm install
cp .env.example .env
npm run dev
```

Put the real `OPENAI_API_KEY` in `.env`. Keep `.env` local or on your server only; commit `.env.example`, not `.env`.

The app calls `POST https://lockin.elevenfactor.com/generate-week-plan` with local training data and the selected model ID. The proxy loads `src/coach/skills/fitness-coach-planner`, builds a deterministic coaching context, calls OpenAI with the skill instructions and references, and validates the structured JSON before the app accepts it.

Check `GET https://lockin.elevenfactor.com/health` to confirm the proxy is running and has an API key. The app's AI Coach context tab stores the selected model ID and can refresh available text model IDs through `GET https://lockin.elevenfactor.com/models`.

The request includes baseline numbers, target goals, sessions per week, equipment, target date, recent SwiftData logs, and planned/completed sessions. Each log marks whether pull-ups, push-ups, and plank were actually tested so the model does not treat an unlogged exercise as a zero.
