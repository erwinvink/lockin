# Ultrarunning Coach + Garmin Integration — Design

Date: 2026-06-10
Branch: `feature/ultrarunner`
Status: validated with Erwin (screens, architecture, data model, build plan)

## Goal

Extend lockin from a strength-only app into a dual-discipline coach:

- A **strength coach** (exists today, stays as-is) and an **ultrarunning coach**, both implemented as proxy skills with their own JSON schemas.
- A **running goal**: race date, distance (km), and elevation gain (m+), alongside the existing strength goals.
- **Two-way Garmin integration**: workouts planned in the app are pushed to the Garmin watch; activities and health data sync back and feed both coaches.

## Decisions made

| Decision | Choice | Why |
| --- | --- | --- |
| Old `ultrarunner` branch (June 3) | Leave untouched; fresh start from `main` | It bundles a redesign, predates 7 newer main commits, and "was not working very well". Use only as inspiration (its `running-coach-planner` skill/schema shape was sound). |
| Garmin route | Unofficial Garmin Connect API via `python-garminconnect` | Official Garmin Connect Developer Program requires a legal entity — no personal use. The unofficial library is mature, handles Garmin SSO, reads wellness data, and can create + schedule structured running workouts that sync to the watch. |
| Coach relationship | Coordinated week | One "Plan my week" action: ultra coach plans runs first (owns periodization toward the race), strength coach plans around them with the runs in context. Two skills, two schemas, one coherent week. |
| Race goals | One active race goal | YAGNI; B-races can come later. |

## The final app, screen by screen

Five-tab shape unchanged. Running is a second discipline woven into existing screens, not a mode switch.

- **Onboarding / Running setup**: new running step — race goal (name, date, distance km, elevation m+), current weekly km, longest recent run, which days can hold runs, preferred long-run day. Same form reachable from Settings as "Set up running" so existing users never re-onboard.
- **Today**: all sessions due today. Run card shows kind, distance, elevation, zone/pace target, purpose, and an "On your watch" badge once pushed to Garmin. When the Garmin activity syncs back, the run log is pre-filled (actual km, time, D+, avg HR); the athlete confirms and adds RPE/feel.
- **Log**: one mixed timeline of runs and strength sessions; runs show planned vs. actual distance/elevation.
- **Coach**: one **Plan my week** button (coordinated generation). Shows both coaches' summaries and safety flags, plus a Garmin sync row (last pull, push status, retry).
- **Progress**: Running section (weekly km + D+ trend, long-run progression, race countdown vs. expected volume) above the existing Strength section; readiness strip on top (sleep, HRV status, Body Battery, training readiness).
- **Settings**: race goal editing, running days, Garmin panel (connection status, last sync, sync now).

## Architecture

```text
iOS app (SwiftUI + SwiftData, local-first — unchanged)
        |  HTTPS JSON
        v
Coach proxy (Node/TS on Coolify)
   ├── OpenAI Responses API          (plans + verdicts, key in env)
   └── Garmin service (small Python sidecar, internal-only)
         python-garminconnect · GARMIN_EMAIL/PASSWORD in env
         token cache on a disk volume — the only server-side state
         ├── PUSH: structured run workouts → Garmin calendar → watch
         └── PULL: activities + wellness (sleep, HRV, Body Battery,
                    readiness, resting HR) → proxy → app
```

Boundary rules preserved: training data lives on device, secrets live on the server, the proxy stores no user training data. The sidecar's Garmin session tokens are the only persisted server state. The sidecar is never exposed publicly; the Node proxy calls it over localhost.

Why Python sidecar instead of porting to TS: `python-garminconnect` (cyberjunky) is actively maintained and owns the brittle part — Garmin's SSO/auth dance — plus structured workout creation and calendar scheduling. Reimplementing that in TypeScript means owning breakage forever.

### Flows

1. **Plan my week** — app → proxy: proxy pulls a fresh Garmin snapshot (readiness + real recent volume) → ultra skill → schema validation → strength skill with the planned runs in context → validation → returns one combined plan. App saves locally, then asks the proxy to push the runs to the Garmin calendar.
2. **Sync back** — on app foreground and on demand: app fetches recent activities + daily wellness via proxy, stores snapshots in SwiftData, auto-matches run activities to planned sessions (same day + discipline) to pre-fill logs. Manual logging stays as fallback.
3. **Degraded mode** — if Garmin auth breaks: coaches plan from local logs (flagged in context), Settings shows the failure, pushes queue with retry. The app never hard-depends on Garmin.

## Data model (SwiftData)

Extend, don't fork:

- `WorkoutSession` gains `disciplineRaw` (`strength` | `running`, default `strength`) plus running plan fields: `runKindRaw` (easy/long/recovery/hills/tempo/intervals), `plannedDistanceKm`, `plannedElevationM`, target type + range (pace or HR), `garminWorkoutId`, `pushedToGarminAt`. Streaks, consistency scoring, Today, and Log keep working on one session type.
- `RaceGoal` (new @Model) — name, date, distanceKm, elevationM, baselineWeeklyKm, longestRecentRunKm. Strength goals on `UserProfile` untouched. Running day selection + long-run day stored on `UserProfile` (same raw-string pattern as `trainingDaysRaw`).
- `RunLog` (new @Model) — sessionId, actualDistanceKm, movingSeconds, elevationGainM, avgHr, avgPaceSecPerKm, rpe, feel/notes, `garminActivityId`, sourceRaw (`garmin` | `manual`).
- `GarminDailySnapshot` (new @Model) — date, sleepScore, sleepSeconds, hrvStatus, bodyBattery, trainingReadiness, restingHr. (Exact field set verified against the library during implementation.)

All new fields/models use defaults → lightweight SwiftData migration, same pattern as previous schema additions.

## Proxy contract

Existing routes unchanged (`/health`, `/models`, `/coach-verdict`, `/generate-week-plan` kept for compatibility until the app moves over).

New:

- `POST /generate-week` — coordinated orchestration; returns `{runningWeek, strengthWeek, summary, safetyFlags}`.
- `POST /garmin/push-workouts` — builds structured workouts from run sessions, schedules them on calendar dates, returns per-session `{garminWorkoutId, status}`.
- `GET /garmin/snapshot?sinceDays=N` — recent activities + daily wellness.
- `GET /garmin/status` — auth health, last successful push/pull timestamps.
- `POST /coach-verdict` — context now includes wellness when available.

## Skills

- `running-coach-planner` (new) — schema: kind, dayOffset, distanceKm, durationMinutes, elevationMeters, structured target (pace range or HR zone — required so workouts are pushable), purpose, notes, safetyFlags. References: `ultra-periodization.md` (long-run progression, back-to-back rules, taper, weeks-to-race awareness), the running schema. Context: race goal, weeks to race, recent volume from Garmin + logs, readiness, selected running days, long-run day. Same dayOffset rules as the strength skill (today locked, future days only).
- `fitness-coach-planner` (existing) — unchanged except context gains the planned runs + readiness, with one new rule: manage total weekly fatigue; never stack max-effort strength onto hard run days.

## Build order (one branch, four working checkpoints)

1. **Running coach core** — race goal setup UI, data model migration, running skill + schema, coordinated `/generate-week`, run cards in Today/Log, manual run logging. Usable ultra coach before Garmin exists.
2. **Garmin pull** — Python sidecar, `/garmin/snapshot` + `/garmin/status`, wellness into both coaches' context, activity auto-match → pre-filled run logs, readiness strip on Progress.
3. **Garmin push** — structured workouts to calendar/watch, "On your watch" badges, retry handling.
4. **Polish** — Progress running analytics, Settings Garmin panel, degraded-mode UX.

## Testing

- Proxy (vitest): running schema validator; week-coordination logic (no hard-day collisions); Garmin workout builder against recorded fixtures — no live Garmin calls in CI.
- Swift unit tests: migration defaults, activity-to-session matching.
- UI test: plan-week flow with both disciplines.

## Risks

- **Unofficial API breakage** — isolated in the sidecar; `garmin/status` surfaces what broke; app degrades gracefully.
- **Garmin MFA/login** — token cache keeps logins rare; one-time setup script for the first MFA login.
- **SwiftData migration** — all-new-fields-with-defaults; extend the persistence reset tests to the new models.

## Sources

- Garmin program requires legal entity: https://developer.garmin.com/gc-developer-program/program-faq/
- Garmin Training API (official, for reference): https://developer.garmin.com/gc-developer-program/training-api/
- python-garminconnect: https://github.com/cyberjunky/python-garminconnect
