# OpenAI coach proxy

This proxy keeps the OpenAI API key out of the iOS app.

```bash
npm install
cp .env.example .env
npm run dev
```

Put the real `OPENAI_API_KEY` in `.env`. Keep `.env` local or on your server only; commit `.env.example`, not `.env`. `GARMIN_SERVICE_URL` points at the internal Garmin sidecar (`GarminService/`), defaulting to `http://127.0.0.1:8788`.

Environment:

| Var | Default | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | OpenAI key for the coach. |
| `OPENAI_TIMEOUT_MS` | `300000` | Budget for one Responses API call; a call past it is aborted and answered as HTTP 504. The scheduler treats an automatic plan still `generating` after 30 minutes as interrupted, which assumes this stays at about 5 minutes or less. |
| `COACH_CHAT_TIMEOUT_MS` | `45000` | Budget for the coach-chat model call. Past it the chat answers with the built-in quick answer instead. Keep it under the app's 60-second chat timeout. |
| `COACH_CHAT_REASONING_EFFORT` | `low` | Reasoning effort for coach-chat calls on reasoning models (`gpt-5*`, `gpt-6*`, `o*`). `off` leaves the parameter out. |
| `PORT` | `8787` | Listen port. |
| `LOCKIN_APP_TOKEN` | unset | Shared app credential. When set, every route except `GET /health` requires the header `X-Lockin-App-Token: <value>` (constant-time compare) and answers `401 {"error": ...}` otherwise. When unset the proxy stays open and logs a warning at startup. Set it in production and give the same value to the app. |
| `COACH_ALLOWED_MODELS` | `gpt-6.1-sol,gpt-5.5,gpt-5-mini` | Comma-separated models the coach may use. A request for any other model (or none) silently uses the default model, `gpt-6.1-sol`. `GET /models` only lists allowed models. There is no `OPENAI_MODEL` override; the default lives in `src/model-selection.ts`. |
| `LOCKIN_AUTH_SECRET` | dev secret | HMAC secret for `/v1` storage bearer tokens. Tokens expire 180 days after they were issued. With `NODE_ENV=production` and no secret, every `/v1` route answers `503` instead of signing with the built-in development secret. |
| `NODE_ENV` | — | `production` turns on the `/v1` secret check above. |
| `GARMIN_SERVICE_URL` | `http://127.0.0.1:8788` | Internal Garmin sidecar. |
| `GARMIN_SYNC_STATE_PATH` | `.data/garmin-sync-state.json` | Durable watch-sync state. |
| `AUTO_PLAN_STATE_PATH` | `.data/auto-plan-state.json` | Automatic planning state. A file that is not valid JSON is moved to `<path>.corrupt-<timestamp>` and planning starts from an empty state. |
| `AUTO_PLANNER_DISABLED` / `AUTO_PLANNER_INTERVAL_MS` | — / `900000` | Turn off, or change the tick of, the planning scheduler (nightly runs, retries after failures, recovery of runs interrupted by a restart). |
| `LOCKIN_DB_PATH` | `.data/lockin.sqlite` | `/v1` storage database. |
| `OPENAI_TELEMETRY_PATH`, `OPENAI_TELEMETRY_STDOUT`, `OPENAI_TELEMETRY_DISABLED` | see below | Telemetry. |

OpenAI coach telemetry is enabled by default. Each Responses API call writes a start and finish event to `.data/openai-usage.jsonl` and logs a compact `openai.telemetry ...` line to stdout. The finish event includes route, phase, model, latency, input/output/reasoning tokens, cached input tokens, cache hit rate, and an estimated USD cost when the model is in the local price table. Override the file path with `OPENAI_TELEMETRY_PATH`, set `OPENAI_TELEMETRY_STDOUT=0` to keep only the JSONL file, or set `OPENAI_TELEMETRY_DISABLED=1` to disable it.

When the athlete has a race goal, the app calls `POST /generate-week`: the proxy plans the running week first with `src/coach/skills/running-coach-planner`, validates it, then plans the strength week around the accepted runs with `src/coach/skills/fitness-coach-planner` and cross-checks the combined week. Both planners get the computed training signals and the guardrails the validators enforce (`src/coach/planner/running-guardrails.ts`, `strength-guardrails.ts`): weekly km and long-run caps, hard-run rules, plausible targets, strength working caps, set bounds and progression bands. Safety flags never waive a limit. Safe fixes (shortening easy runs to the weekly cap, dropping or replacing an implausible target, lowering an over-cap or unearned rep target) are applied before validation and listed in the response's `adjustments`; anything else gets one repair attempt (`src/coach/plan-pipeline.ts`), then a 422. The coach context for `/generate-week`, `/coach-verdict`, `/coach-chat` and automatic plans is enriched with the last two days of Garmin wellness when the sidecar is reachable and the request carries a `userId` (cached per user for 10 minutes; a context sent without Garmin data is logged with the reason). Metrics the sidecar lists in `unavailableMetrics`, and 0/empty values, are passed to the coach as `null` (no data), never as real low values.

Periodization and continuity (`src/coach/planner/periodization.ts`, `running-phase-limits.ts`, `strength-phase.ts`, `current-plan.ts`):

- Planned recovery weeks (3:1) on the plan-block calendar: after three loading weeks in a row, counted from `planBlockStartedAt` or the last unloading week (a reactive offload, a low-volume week, the taper or the race), the next block week is a recovery week (`coachContext.periodization`). Running drops to at most 75% of the four block weeks before with one quality session and a shorter long run; strength cuts hard sets to 60% of the last loading week, one hard session, no tests, no progression. The rule is stateless, so every nightly re-plan inside the week agrees.
- Taper and race window, per day of the rolling week: 80% of the pre-taper volume 15-21 days out, at most 70% 8-14 days out, race-week shakeouts only (40% of a normal easy run, max 8 km), no hill load inside 10 days, easy running the week after; strength light in the last 10 days and nothing hard within 4.
- Plan continuity: the planned future sessions (`coachContext.currentPlan`) go to both planners with the computed change signals since the plan was made. With no signal, a re-planned run keeps its kind and stays within 15% of its distance; other changes are listed in `adjustments`.
- Readiness is time-based (pain >= 4 or very weak feedback counts for 7 days and a later clean log clears it); plateaus come from rolling 3-week windows; after a new plan block the current level is the baseline plus the block's own logs.
- The exercise library carries pull-up, push-up and plank ladders with selection rules by current max; names are exact (schema enum, validator and the app's `ExerciseKind` are kept identical by a test) and equipment is checked.

Coach requests may carry an optional `timeZone` (IANA id, e.g. `Europe/Amsterdam`). `weekStart` is the athlete's local midnight today; with `timeZone` "today" ends at the next local midnight (correct on 23- and 25-hour DST days), without it 24 hours later. Adherence only counts sessions scheduled before today; today's not-yet-done sessions are reported as `pendingToday` and stay out of the score. Running days: `running.runningDays` empty means unconstrained (any future day 1-6); selected days with no offset left this week mean zero runs.

`POST /coach-chat` takes `{request, messages}`: the same coach request the plan routes take, plus up to the last 20 chat turns (`{role: "user" | "coach", text, createdAt?}`). It builds the same coach context, training signals and coach read as `/coach-verdict`, then asks the athlete's chosen model (`request.model`, resolved like the other routes) for a structured answer: `answer` (60-180 words), `evidence`, 2-3 `followUpPrompts` and `answerKind`. The prompt lives in `src/coach/chat-prompt.ts`; the call, the output checks and the fallback live in `src/coach/chat-model.ts`. Without an API key, or when the call fails, times out or returns unusable output, the route answers with the built-in template answer from `src/coach/chat.ts` and `usedModel: false` (the reason is logged as `coach_chat.fallback`). The chat never changes the plan. Request bodies over 2 MB get `413`; invalid JSON or a malformed chat payload gets `400`; other failures get a generic `500` with the details in the server log.

The legacy strength-only route `POST https://lockin.elevenfactor.com/generate-week-plan` still accepts local training data and the selected model ID. The proxy loads `src/coach/skills/fitness-coach-planner`, builds a deterministic coaching context, calls OpenAI with the skill instructions and references, and runs technical validation on the structured JSON before the app accepts it. This route intentionally skips Garmin enrichment.

Garmin beta routes (all proxied to the sidecar, never exposing it publicly). Every Garmin route requires `userId` to be the app's profile UUID (any case) and answers `400` otherwise, so a request can never fall through to the sidecar's default (owner) Garmin account or name another token directory:

- `POST /garmin/connect` — body `{userId,email,password,mfaCode?}`; creates a per-user Garmin token session. Passwords are used for this login call only and are not stored by Lockin.
- `POST /garmin/disconnect` — body `{userId}`; removes that user's token session.
- `GET /garmin/status?userId=...` — sidecar reachability plus Garmin connection state (`{ok,userId,loggedIn,state,connectedEmail,lastError}`).
- `GET /garmin/snapshot?userId=...&sinceDays=N` — status, wellness days, and running activities in one response (default 7). A wellness day may carry `unavailableMetrics: [...]` naming fields whose Garmin call failed; their `0`/`""` values are placeholders and must not be stored.
- `POST /garmin/sync-plan` — body `{userId,planRevisionId,staleWorkoutIds,workouts,lockedThroughDate?}`; durable desired-state sync for future planned runs. `lockedThroughDate` (`yyyy-MM-dd`, the athlete's local today) protects recorded workouts: today's stays on the watch when left out of `workouts`, and runs dated before it are dropped from the sync state (no longer listed, counted or pushed) while their Garmin workouts stay as history. Only explicit `staleWorkoutIds` delete a workout from Garmin. Without it the proxy uses today in `Europe/Amsterdam`.
- `GET /garmin/sync-status?userId=...` — current watch-plan sync state.
- `POST /garmin/retry-sync` — body `{userId}`; retries failed or blocked watch sync operations.
- Legacy passthrough remains available: `POST /garmin/push-workouts` and `POST /garmin/delete-workouts` (no app callers), now also requiring `userId`.

Push/delete contract: the app-facing response shape is `{results: [...], error?}` and is canonical — the sidecar returns bare result arrays today, and `src/garmin/garmin-client.ts` normalizes both shapes so neither side breaks the other. Durable plan sync state is stored in `.data/garmin-sync-state.json` by default; override with `GARMIN_SYNC_STATE_PATH`.

Check `GET https://lockin.elevenfactor.com/health` to confirm the proxy is running and has an API key (the only route that never needs the app token). The app's AI Coach context tab stores the selected model ID and can refresh available text model IDs through `GET https://lockin.elevenfactor.com/models`, which lists only allowed models.

The request includes baseline numbers, target goals, sessions per week, equipment, target date, recent SwiftData logs, and planned/completed sessions. Each log marks whether pull-ups, push-ups, and plank were actually tested so the model does not treat an unlogged exercise as a zero.
