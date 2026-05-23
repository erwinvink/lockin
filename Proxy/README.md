# Local OpenAI proxy

This proxy keeps the OpenAI API key out of the iOS app.

```bash
npm install
cp .env.example .env
npm run dev
```

Put the real `OPENAI_API_KEY` in `.env`. Keep `.env` local or on your server only; commit `.env.example`, not `.env`.

The app calls `POST http://127.0.0.1:8787/generate-week-plan` with local training data. The proxy loads `src/coach/skills/fitness-coach-planner`, builds a deterministic coaching context, calls OpenAI with the skill instructions and references, and validates the structured JSON before the app accepts it.

Check `GET http://127.0.0.1:8787/health` to confirm the proxy is running, has an API key, and which model it will call. The default model is `gpt-5-mini`; override it with `OPENAI_MODEL` in `.env` when needed.

The request includes baseline numbers, target goals, sessions per week, equipment, target date, recent SwiftData logs, and planned/completed sessions. Each log marks whether pull-ups, push-ups, and plank were actually tested so the model does not treat an unlogged exercise as a zero.
