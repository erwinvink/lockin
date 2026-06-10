# Ultrarunning Coach + Garmin Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an ultrarunning coach (second proxy skill + schemas), a race goal (date, distance, elevation), coordinated week planning (runs first, strength around them), and two-way Garmin sync (push structured workouts to the watch, pull activities + wellness back) to lockin.

**Architecture:** The iOS app stays local-first (SwiftData); the Node/TS proxy gains a `running-coach-planner` skill, a coordinated `POST /generate-week` route, and `/garmin/*` passthrough routes to a new internal-only Python sidecar (`GarminService/`) that wraps `python-garminconnect` for both push and pull. Design doc: `docs/plans/2026-06-10-ultrarunning-coach-design.md`.

**Tech Stack:** SwiftUI + SwiftData (iOS), Node/TypeScript + `node:http` + `node:test` via tsx (proxy), Python 3.11 + FastAPI + garminconnect (sidecar), OpenAI Responses API with strict JSON-schema output.

---

## Working agreements (read first)

1. **No new Swift files.** `FitnessApp.xcodeproj/project.pbxproj` lists every file explicitly; adding files requires fragile pbxproj edits. Put new models in `FitnessApp/AppModels.swift`, new DTOs/client code in `FitnessApp/CoachClient.swift`, run UI in the view file that owns the screen, and new tests in the existing test files. New proxy/sidecar files are fine.
2. **Commit style:** sentence-case imperative, no prefix (`Add running week schema`), matching `git log`. Commit after every task. End commit messages with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.
3. **Proxy tests:** `node:test` + `node:assert/strict`, file next to source as `*.test.ts`. Run with `cd Proxy && npm test`. Typecheck with `npm run typecheck`.
4. **iOS build/tests:**
   ```bash
   xcodebuild -project FitnessApp.xcodeproj -scheme FitnessApp \
     -destination 'platform=iOS Simulator,name=iPhone 17' build
   xcodebuild test -project FitnessApp.xcodeproj -scheme FitnessApp \
     -destination 'platform=iOS Simulator,name=iPhone 17'
   ```
5. **Invariants that must survive every task:** `dayOffset 0` (today) is never planned/replaced; all SwiftData properties have defaults (CloudKit requirement); the proxy stores no user training data (Garmin session tokens in the sidecar are the only server state); OpenAI + Garmin credentials exist only in server env.
6. **CloudKit/SwiftData migration rule:** only additive changes — new fields with defaults, new `@Model` classes registered in `ModelContainerFactory.schema`.
7. **Degraded mode rule:** every Garmin-touching code path must work (with a clear status message) when the sidecar is down or logged out. Coaches plan from local data when Garmin context is null.

---

# Phase 1 — Running coach core (usable without Garmin)

### Task 1: App data model — discipline, race goal, run logs, wellness snapshots

**Files:**
- Modify: `FitnessApp/AppModels.swift` (append new types; extend `WorkoutSession`)
- Modify: `FitnessApp/Persistence.swift:8-18` (schema list)
- Modify: `FitnessApp/TrainingPlanStore.swift:190-200` (`wipeAllData`)
- Test: `FitnessAppTests/PersistenceResetTests.swift`

**Step 1: Write failing tests** in `PersistenceResetTests.swift`, following the file's existing in-memory container pattern: (a) inserting then wiping a `RaceGoal`, `RunLog`, and `GarminDailySnapshot` leaves zero rows; (b) a default `WorkoutSession` has `discipline == .strength`; (c) a session created with `discipline: .running` round-trips `runKind`, `plannedDistanceKm`, `plannedElevationM`.

**Step 2: Run tests, verify they fail** (types don't exist yet).

**Step 3: Implement.** In `AppModels.swift` add:

```swift
enum Discipline: String, Codable {
    case strength
    case running
}

enum RunKind: String, CaseIterable, Codable {
    case easy, long, recovery, hills, tempo, intervals, race

    var title: String {
        switch self {
        case .easy: "Easy Run"
        case .long: "Long Run"
        case .recovery: "Recovery Run"
        case .hills: "Hill Session"
        case .tempo: "Tempo Run"
        case .intervals: "Intervals"
        case .race: "Race"
        }
    }

    var isHard: Bool {
        switch self {
        case .long, .tempo, .intervals, .hills, .race: true
        case .easy, .recovery: false
        }
    }
}

enum RunTargetType: String, Codable {
    case pace   // low/high in seconds per km
    case hr     // low/high in bpm
}

enum RunLogSource: String, Codable {
    case manual
    case garmin
}
```

Extend `WorkoutSession` with stored properties (all defaulted) + inits/computed accessors following the existing `focusRaw` pattern:

```swift
var disciplineRaw: String = Discipline.strength.rawValue
var runKindRaw: String = ""
var plannedDistanceKm: Double = 0
var plannedElevationM: Int = 0
var runTargetTypeRaw: String = ""
var runTargetLow: Int = 0
var runTargetHigh: Int = 0
var runZone: String = ""
var garminWorkoutId: String = ""
var pushedToGarminAt: Date? = nil

var discipline: Discipline { Discipline(rawValue: disciplineRaw) ?? .strength }
var runKind: RunKind? { RunKind(rawValue: runKindRaw) }
var runTargetType: RunTargetType? { RunTargetType(rawValue: runTargetTypeRaw) }
var isRun: Bool { discipline == .running }
```

Add a convenience init parameter `discipline: Discipline = .strength` (and run fields with defaults) to the existing `WorkoutSession.init`, assigning `disciplineRaw = discipline.rawValue`.

New models (all properties defaulted, same style as existing models):

```swift
@Model
final class RaceGoal {
    var id: UUID = UUID()
    var name: String = ""
    var raceDate: Date = Date()
    var distanceKm: Double = 0
    var elevationGainM: Int = 0
    var baselineWeeklyKm: Double = 0
    var longestRecentRunKm: Double = 0
    var createdAt: Date = Date()
    init(id: UUID = UUID(), name: String = "", raceDate: Date = Date(), distanceKm: Double = 0,
         elevationGainM: Int = 0, baselineWeeklyKm: Double = 0, longestRecentRunKm: Double = 0,
         createdAt: Date = Date()) { ... } // assign all
}

@Model
final class RunLog {
    var id: UUID = UUID()
    var sessionId: UUID = UUID()
    var completedAt: Date = Date()
    var distanceKm: Double = 0
    var movingSeconds: Int = 0
    var elevationGainM: Int = 0
    var averageHr: Int = 0
    var averagePaceSecPerKm: Int = 0
    var rpe: Int = 0
    var feelScore: Int = 3          // 1 very weak ... 5 very strong
    var notes: String = ""
    var garminActivityId: String = ""
    var sourceRaw: String = RunLogSource.manual.rawValue
    var needsConfirmation: Bool = false
    init(...) { ... } // mirror fields, defaulted
    var source: RunLogSource { RunLogSource(rawValue: sourceRaw) ?? .manual }
}

@Model
final class GarminDailySnapshot {
    var id: UUID = UUID()
    var date: Date = Date()          // startOfDay
    var sleepScore: Int = 0
    var sleepSeconds: Int = 0
    var hrvStatus: String = ""
    var hrvMs: Int = 0
    var bodyBattery: Int = 0
    var trainingReadiness: Int = 0
    var restingHr: Int = 0
    var fetchedAt: Date = Date()
    init(...) { ... }
}
```

Also extend `UserProfile` with running schedule fields + accessors (reuse the `trainingDaysRaw` storage pattern):

```swift
var runningDaysRaw: String = ""
var longRunDayRaw: String = ""

var runningDays: Set<TrainingWeekday> { get/set via rawValue join/split }
var longRunDay: TrainingWeekday? { TrainingWeekday(rawValue: longRunDayRaw) }
```

Register `RaceGoal.self`, `RunLog.self`, `GarminDailySnapshot.self` in `ModelContainerFactory.schema`. Add `try deleteAll(RunLog.self, ...)`, `RaceGoal`, `GarminDailySnapshot` to `wipeAllData` (before `UserProfile`).

**Step 4: Run tests, verify pass. Build the app.**

**Step 5: Commit** — `Add running discipline, race goal, and run log models`

---

### Task 2: Proxy — running skill bundle (SKILL.md, schema, periodization reference)

**Files:**
- Create: `Proxy/src/coach/skills/running-coach-planner/SKILL.md`
- Create: `Proxy/src/coach/skills/running-coach-planner/references/running-week.schema.json`
- Create: `Proxy/src/coach/skills/running-coach-planner/references/ultra-periodization.md`

**Step 1: Write the schema** (strict mode: every property required, `additionalProperties: false` — mirrors `weekly-plan.schema.json`):

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["summary", "safetyFlags", "sessions"],
  "properties": {
    "summary": { "type": "string" },
    "safetyFlags": { "type": "array", "items": { "type": "string" } },
    "sessions": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "dayOffset", "kind", "purpose", "distanceKm",
                     "durationMinutes", "elevationMeters", "target", "zone", "notes"],
        "properties": {
          "title": { "type": "string" },
          "dayOffset": { "type": "integer", "minimum": 1, "maximum": 6 },
          "kind": { "enum": ["easy", "long", "recovery", "hills", "tempo", "intervals"] },
          "purpose": { "type": "string" },
          "distanceKm": { "type": "number", "minimum": 0 },
          "durationMinutes": { "type": "integer", "minimum": 0 },
          "elevationMeters": { "type": "integer", "minimum": 0 },
          "target": {
            "type": "object",
            "additionalProperties": false,
            "required": ["type", "low", "high"],
            "properties": {
              "type": { "enum": ["pace", "hr"] },
              "low": { "type": "integer", "minimum": 0 },
              "high": { "type": "integer", "minimum": 0 }
            }
          },
          "zone": { "type": "string" },
          "notes": { "type": "array", "items": { "type": "string" } }
        }
      }
    }
  }
}
```

`target` semantics: `pace` = seconds per km (low = faster bound), `hr` = bpm. Required so every run is pushable to Garmin as a structured workout.

**Step 2: Write `ultra-periodization.md`** (compact reference, ~60 lines): weeks-to-race phases (base → build → peak → taper, taper = final 2–3 weeks, race week ≤40% peak volume); long-run progression ≤ 10–15% per week and never > 1.4× recent longest run; weekly elevation gain progresses toward race demand (race elevation / race distance ratio); 80/20 easy/hard intensity split; back-to-back long runs only in build/peak for races ≥ 80 km and only when recent volume supports it; readiness gates (training readiness < 30, body battery < 25, sleep score < 50, or HRV status "unbalanced/low" → downgrade the next hard session to easy and flag it); never increase both volume and intensity in the same week.

**Step 3: Write `SKILL.md`** mirroring the fitness skill's structure (frontmatter name/description, Purpose, Coach Temperament, Inputs, References, Workflow, Hard Rules, Repair). Key content:

- Purpose: generate a conservative, schema-valid ultrarunning week from `coachContext.running` (race goal, weeks to race, recent runs, baseline weekly km, selected running days, long-run day) plus shared readiness and optional `coachContext.garmin` wellness.
- Temperament: calm, practical ultra coach; respects strength work happening the same week; no hype.
- Hard rules: today (`dayOffset 0`) locked; only selected future running-day offsets when provided, exactly one run per selected day, strictly increasing; long run lands on the long-run day when provided; most volume easy/Zone 2 (80/20); inside 21 days of `raceDate` taper (reduce volume, keep light frequency); every session includes a pace or HR `target`; respect readiness gates from `ultra-periodization.md`; safety flags for injury notes, volume jumps > 15%, or missing history; schema-valid JSON only.

**Step 4: Verify** the schema parses: `cd Proxy && node -e "JSON.parse(require('fs').readFileSync('src/coach/skills/running-coach-planner/references/running-week.schema.json','utf8')); console.log('ok')"`

**Step 5: Commit** — `Add running coach planner skill bundle`

---

### Task 3: Proxy — running types + running week validator (TDD)

**Files:**
- Modify: `Proxy/src/coach/planner/types.ts`
- Create: `Proxy/src/coach/planner/validate-running-week.ts`
- Test: `Proxy/src/coach/planner/validate-running-week.test.ts`

**Step 1:** Add types to `types.ts`:

```ts
export type RunKind = "easy" | "long" | "recovery" | "hills" | "tempo" | "intervals";

export type RunTarget = { type: "pace" | "hr"; low: number; high: number };

export type RunningWeek = {
  summary: string;
  safetyFlags: string[];
  sessions: Array<{
    title: string;
    dayOffset: number;
    kind: RunKind;
    purpose: string;
    distanceKm: number;
    durationMinutes: number;
    elevationMeters: number;
    target: RunTarget;
    zone: string;
    notes: string[];
  }>;
};

export type RunSummary = {
  completedAt: string;
  distanceKm: number;
  movingSeconds: number;
  elevationGainM: number;
  averageHr?: number;
  rpe?: number;
  kind?: string;
};

export type RunningRequest = {
  raceGoal: { name: string; raceDate: string; distanceKm: number; elevationGainM: number };
  baselineWeeklyKm: number;
  longestRecentRunKm: number;
  runningDays: string[];
  runningDayOffsets: number[];
  longRunDay?: string;
  recentRuns: RunSummary[];
};

export type GarminWellnessDay = {
  date: string;
  sleepScore: number;
  sleepSeconds: number;
  hrvStatus: string;
  hrvMs: number;
  bodyBattery: number;
  trainingReadiness: number;
  restingHr: number;
};

export type RunningContext = RunningRequest & { weeksToRace: number };
```

Add `running?: RunningRequest` to `CoachRequest`, and `running?: RunningContext; garmin?: { wellness: GarminWellnessDay[] } ` to `CoachContext`.

**Step 2: Write failing tests** in `validate-running-week.test.ts` (node:test style, copy fixture approach from `validate-week-plan.test.ts`): accepts a valid 4-run week on allowed offsets; rejects `dayOffset 0`; rejects offsets not in `runningDayOffsets` when provided; rejects non-increasing offsets; rejects week where long-run distance > 1.4 × `longestRecentRunKm` without safety flags (when `longestRecentRunKm > 0`); rejects week with > 50% hard-kind sessions without safety flags; rejects `target.low > target.high` for `hr` targets and `low < high` violation semantics for `pace` (pace: low ≤ high where low is the faster seconds/km bound — just require `low <= high` for both types); rejects long run not on `longRunDay`'s offset when both provided.

**Step 3: Run tests → fail** (`cd Proxy && npm test`).

**Step 4: Implement `validate-running-week.ts`:**

```ts
import type { CoachContext, RunningWeek } from "./types";

export type RunningValidation = { accepted: boolean; messages: string[] };

export function validateRunningWeek(week: RunningWeek, context: CoachContext): RunningValidation {
  const messages: string[] = [];
  const running = context.running;
  const allowed = running?.runningDayOffsets ?? [];
  const hasSelectedDays = allowed.length > 0;
  const hasSafetyFlags = week.safetyFlags.length > 0;

  if (hasSelectedDays && week.sessions.length !== allowed.length) {
    messages.push(`Running week must contain exactly ${allowed.length} runs, one per selected running day.`);
  }

  let previousOffset = -1;
  for (const [index, session] of week.sessions.entries()) {
    const label = `Run ${index + 1}`;
    if (session.dayOffset < 1 || session.dayOffset > 6) {
      messages.push(`${label} must use dayOffset 1 through 6; today is locked.`);
    }
    if (hasSelectedDays && !allowed.includes(session.dayOffset)) {
      messages.push(`${label} is scheduled on a non-running day.`);
    }
    if (session.dayOffset <= previousOffset) {
      messages.push("Runs must use strictly increasing day offsets.");
    }
    previousOffset = session.dayOffset;
    if (session.target.low > session.target.high) {
      messages.push(`${label} target low must not exceed target high.`);
    }
    if (session.distanceKm < 0 || session.durationMinutes < 0 || session.elevationMeters < 0) {
      messages.push(`${label} has a negative distance, duration, or elevation.`);
    }
  }

  const longest = running?.longestRecentRunKm ?? 0;
  const longRun = [...week.sessions].sort((a, b) => b.distanceKm - a.distanceKm)[0];
  if (longRun && longest > 0 && longRun.distanceKm > longest * 1.4 && !hasSafetyFlags) {
    messages.push("Long run jumps more than 40% past the recent longest run without safety flags.");
  }

  const hardKinds = new Set(["long", "tempo", "intervals", "hills"]);
  const hardCount = week.sessions.filter((s) => hardKinds.has(s.kind)).length;
  if (week.sessions.length >= 3 && hardCount > Math.ceil(week.sessions.length / 2) && !hasSafetyFlags) {
    messages.push("More than half the week is hard running without safety flags.");
  }

  if (running?.longRunDay && hasSelectedDays && longRun) {
    const longRunOffset = running.runningDayOffsets[running.runningDays.indexOf(running.longRunDay)];
    if (longRunOffset !== undefined && longRunOffset >= 1 && longRun.dayOffset !== longRunOffset) {
      messages.push("The longest run must land on the selected long-run day.");
    }
  }

  return { accepted: messages.length === 0, messages };
}
```

**Step 5: Run tests → pass. `npm run typecheck`.**

**Step 6: Commit** — `Add running week validator and running coach types`

AMENDED after review: longRunDay name-index lookup was wrong (arrays are not parallel for non-Monday week starts); the app sends `running.longRunDayOffset` computed app-side, and the validator compares against it directly, with tie- and race-day-aware placement.

---

### Task 4: Proxy — running context in build-coach-context (TDD)

**Files:**
- Modify: `Proxy/src/coach/planner/build-coach-context.ts`
- Test: `Proxy/src/coach/planner/build-coach-context.test.ts`

**Step 1: Failing tests:** when `payload.running` present, `buildCoachContext(payload).running` carries it through plus a computed `weeksToRace` (ceil of days/7 between `weekStart` and `raceDate`, minimum 0); `recentRuns` is capped to the most recent 20 sorted ascending by `completedAt`; absent `payload.running` → `context.running` undefined.

**Step 2: Run → fail.**

**Step 3: Implement** inside `buildCoachContext` (non-invasive — append to the returned object):

```ts
running: payload.running
  ? {
      ...payload.running,
      recentRuns: [...payload.running.recentRuns]
        .sort((a, b) => a.completedAt.localeCompare(b.completedAt))
        .slice(-20),
      weeksToRace: Math.max(
        0,
        Math.ceil(
          (Date.parse(payload.running.raceGoal.raceDate) - Date.parse(payload.weekStart)) /
            (7 * 24 * 60 * 60 * 1000)
        )
      )
    }
  : undefined
```

**Step 4: Run → pass. Typecheck.**

**Step 5: Commit** — `Build running context for coach calls`

---

### Task 5: Proxy — coordinated `POST /generate-week` route (TDD on coordination check)

**Files:**
- Create: `Proxy/src/coach/planner/validate-combined-week.ts`
- Test: `Proxy/src/coach/planner/validate-combined-week.test.ts`
- Modify: `Proxy/src/server.ts`

**Step 1: Failing tests** for the interference check: a `very_hard`/`max_output` strength session on the same `dayOffset` as a `long`/`tempo`/`intervals`/`hills` run → message; `hard` strength on an `easy` run day → accepted; empty running week → accepted.

**Step 2: Implement `validate-combined-week.ts`:**

```ts
import type { RunningWeek, WeeklyPlan } from "./types";

export function validateCombinedWeek(running: RunningWeek, strength: WeeklyPlan): string[] {
  const hardRunOffsets = new Set(
    running.sessions
      .filter((s) => ["long", "tempo", "intervals", "hills"].includes(s.kind))
      .map((s) => s.dayOffset)
  );
  const messages: string[] = [];
  for (const session of strength.sessions) {
    if (hardRunOffsets.has(session.dayOffset) &&
        ["very_hard", "max_output"].includes(session.plannedEffort.label)) {
      messages.push(
        `Strength session "${session.title}" stacks ${session.plannedEffort.label} effort on a hard run day (offset ${session.dayOffset}). Lower it or move it.`
      );
    }
  }
  return messages;
}
```

**Step 3: Run → pass.**

**Step 4: Wire the route in `server.ts`.** Follow the existing `/generate-week-plan` handler structure exactly (parse → model check → skill load → generate → validate → one repair → 422). New pieces:

- `const runningSkillRoot = join(process.cwd(), "src", "coach", "skills", "running-coach-planner");`
- `loadRunningSkillBundle()` — reads `SKILL.md`, `references/ultra-periodization.md`, `references/running-week.schema.json` (mirror `loadSkillBundle`).
- `generateRunningWeek(apiKey, model, bundle, context, repair?)` — mirror `generateWeeklyPlan`, schema name `running_week_plan`, system prompt = skill instructions + periodization reference, user content = `JSON.stringify({ coachContext: context, outputRules: { todayIsLocked: true, selectedRunningDays: context.running?.runningDays ?? [], allowedDayOffsets: context.running?.runningDayOffsets ?? [], longRunDay: context.running?.longRunDay ?? null, longRunDayOffset: context.running?.longRunDayOffset ?? null } , repairRequest? })`.
- Route `POST /generate-week`:
  1. Parse `CoachRequest`; require `payload.running` (400 if missing: `"running goal is required for /generate-week"`).
  2. `const context = buildCoachContext(payload);` then `await enrichWithGarmin(context)` (no-op stub until Task 12 — define `async function enrichWithGarmin(context) { return context; }` now with a `// Task 12 wires the sidecar` comment).
  3. Generate running week → `validateRunningWeek` → one repair attempt on failure → 422 on second failure (`error: "Generated running week failed validation after one repair attempt."`).
  4. Generate strength week with the existing `generateWeeklyPlan`, but extend `buildCoachPromptPayload`'s `outputRules` via a new optional argument `plannedRuns` carrying `runningWeek.sessions.map(({dayOffset, kind, distanceKm, elevationMeters}) => ...)` plus rule text: `"thisWeeksPlannedRuns are fixed. Manage total weekly fatigue. Never schedule very_hard or max_output strength on a hard run day (long, tempo, intervals, hills)."`
  5. `validateWeeklyPlan` + `validateCombinedWeek` → combined messages drive the single strength repair attempt → 422 on second failure.
  6. Respond `200` with:
     ```json
     {
       "summary": "<runningWeek.summary> <strengthPlan.summary>",
       "safetyFlags": [...new Set([...runningWeek.safetyFlags, ...strengthPlan.safetyFlags])],
       "runningWeek": { ... },
       "strengthWeek": { ... }
     }
     ```
     (`strengthWeek` = the raw validated weekly plan JSON, same shape the app already parses as `CoachPlanResponse`.)

**Step 5: Verify** `npm run typecheck && npm test`. Manual smoke (needs `OPENAI_API_KEY` in `Proxy/.env`): `npm run dev`, then POST a fixture request to `http://localhost:8787/generate-week` with a `running` block and confirm a 200 with both weeks.

**Step 6: Commit** — `Add coordinated generate-week route with running and strength plans`

---

### Task 6: App — running DTOs, request building, combined-week client (TDD)

**Files:**
- Modify: `FitnessApp/CoachClient.swift`
- Test: `FitnessAppTests/CoachValidationTests.swift`

**Step 1: Failing tests** (XCTest, same file conventions):
- `makeCoachRequest` with a `RaceGoal` + profile running days fills `request.running` (goal fields, runningDays raw values, runningDayOffsets via `TrainingWeekday.dayOffsets`, recentRuns mapped from `RunLog`s sorted ascending, capped 20).
- `RunningWeekResponse` app-side validation rejects: dayOffset 0, non-selected day, `target.low > target.high`, unknown kind.
- `CombinedWeekResponse.runningPlan(weekStart:)` maps sessions to `TrainingSessionPlan`-equivalents dated `weekStart + dayOffset` with discipline running (see Step 3 for the mapping type).

**Step 2: Run tests → fail.**

**Step 3: Implement in `CoachClient.swift`:**

DTOs (mirror proxy types):

```swift
struct CoachRunningGoal: Codable, Equatable {
    var name: String
    var raceDate: Date
    var distanceKm: Double
    var elevationGainM: Int
}

struct CoachRunSummary: Codable, Equatable {
    var completedAt: Date
    var distanceKm: Double
    var movingSeconds: Int
    var elevationGainM: Int
    var averageHr: Int?
    var rpe: Int?
    var kind: String?
}

struct CoachRunningRequest: Codable, Equatable {
    var raceGoal: CoachRunningGoal
    var baselineWeeklyKm: Double
    var longestRecentRunKm: Double
    var runningDays: [String]
    var runningDayOffsets: [Int]
    var longRunDay: String?
    var recentRuns: [CoachRunSummary]
}

struct RunTargetResponse: Codable, Equatable {
    var type: String   // "pace" | "hr"
    var low: Int
    var high: Int
}

struct RunSessionResponse: Codable, Equatable {
    var title: String
    var dayOffset: Int
    var kind: String
    var purpose: String
    var distanceKm: Double
    var durationMinutes: Int
    var elevationMeters: Int
    var target: RunTargetResponse
    var zone: String
    var notes: [String]
}

struct RunningWeekResponse: Codable, Equatable {
    var summary: String
    var safetyFlags: [String]
    var sessions: [RunSessionResponse]
}

struct CombinedWeekResponse: Codable, Equatable {
    var summary: String
    var safetyFlags: [String]
    var runningWeek: RunningWeekResponse
    var strengthWeek: CoachPlanResponse
}
```

Add `var running: CoachRunningRequest? = nil` to `CoachPlanRequest`. Extend `makeCoachRequest` with new optional parameters `raceGoal: RaceGoal? = nil, runLogs: [RunLog] = []`; when `raceGoal != nil`, build `CoachRunningRequest` (runningDays from `profile.runningDays` normalized like training days; offsets via `TrainingWeekday.dayOffsets(for: profile.runningDays, weeklySessions: profile.runningDays.count, weekStart: weekStart)` filtered to `1...6`; `longRunDay = profile.longRunDay?.rawValue`; recentRuns from the last 20 `RunLog`s where `needsConfirmation == false`). longRunDayOffset: compute via `TrainingWeekday.dayOffsets(for: [longRunDay], weeklySessions: 1, weekStart: weekStart).first`, filtered to `1...6` (omit when nil); normalize raceDate to `Calendar.current.startOfDay(for:)` before encoding.

Add `RunningWeekValidator` (struct, same shape as `CoachPlanValidator.validate` but for `RunningWeekResponse` against allowed offsets — port the Task 3 rules that matter client-side: offsets, ordering, target sanity, known kind).

Add `func generateCombinedWeek(request:baseline:preferences:) async throws -> CombinedWeekResponse` to `LocalCoachClient`, POSTing to path `/generate-week` (add a `generateWeekEndpoint(from:)` helper like `verdictEndpoint`), decoding `CombinedWeekResponse`, validating the strength part with the existing `CoachPlanValidator` and the running part with `RunningWeekValidator`, throwing `CoachClientError.validationFailed` on rejection. Use `timeoutInterval = 240` for this request — the route makes 2–4 sequential model calls, so the 120s used by generatePlan is not enough.

**Step 4: Run tests → pass. Build.**

**Step 5: Commit** — `Add combined week client and running validation to the app`

---

### Task 7: App — persist the running week (TDD)

**Files:**
- Modify: `FitnessApp/TrainingPlanStore.swift`
- Modify: `FitnessApp/CoachClient.swift` (mapping extension)
- Test: `FitnessAppTests/CoachValidationTests.swift` (mapping) and `FitnessAppTests/PersistenceResetTests.swift` (persistence — it already owns an in-memory container helper)

**Step 1: Failing tests:** persisting a `RunningWeekResponse` creates one `WorkoutSession` per run with `discipline == .running`, correct date (`weekStart + dayOffset`), `runKind`, `plannedDistanceKm`, `plannedElevationM`, target fields, `summary` prefixed `"AI: "`, `estimatedDurationMinutes == durationMinutes`; re-persisting with `replacingFuturePlannedSessions: true` deletes future *planned* running sessions but never touches today or completed ones; strength repersist does not delete running sessions and vice versa.

**Step 2: Run → fail.**

**Step 3: Implement.**

In `CoachClient.swift`, map response → plan values; in `TrainingPlanStore.swift` add:

```swift
func persist(
    runningWeek: RunningWeekResponse,
    weekStart: Date,
    in modelContext: ModelContext,
    replacingFuturePlannedSessions: Bool = false
) throws {
    if replacingFuturePlannedSessions {
        try deleteFuturePlannedSessions(in: modelContext, for: weekStart, discipline: .running)
    }
    let calendar = Calendar.current
    let start = calendar.startOfDay(for: weekStart)
    for run in runningWeek.sessions {
        let date = calendar.date(byAdding: .day, value: run.dayOffset, to: start) ?? start
        let session = WorkoutSession(
            scheduledDate: date,
            title: run.title,
            weekIndex: 0,
            focus: .mixed,
            summary: "AI: \(run.purpose)",
            estimatedDurationMinutes: max(0, run.durationMinutes),
            discipline: .running,
            runKind: RunKind(rawValue: run.kind),
            plannedDistanceKm: run.distanceKm,
            plannedElevationM: run.elevationMeters,
            runTargetType: RunTargetType(rawValue: run.target.type),
            runTargetLow: run.target.low,
            runTargetHigh: run.target.high,
            runZone: run.zone
        )
        modelContext.insert(session)
    }
}
```

Change the private `deleteFuturePlannedSessions(in:for:)` to take `discipline: Discipline?` (nil = all, used by existing callers via a default), filtering `$0.discipline == discipline` when set, and update the existing strength call site in `persist(plan:...)` to pass `.strength`. Run sessions have no blocks/prescriptions, so the block/prescription cleanup loop naturally no-ops for them.

Also update `AppShellView.refreshTrainingPlanState` filter: it keeps planned sessions with `summary.hasPrefix("AI:")` — running sessions get the same prefix, so no change needed; verify with a test that a planned running session is not deleted by `deleteNonAIPlannedSessions`.

**Step 4: Run tests → pass. Build.**

**Step 5: Commit** — `Persist AI running weeks as running sessions`

AMENDED after review: deleteFuturePlannedSessions now deletes only sessions scheduled strictly after today (>= tomorrow). A planned session sitting on today survives a replan, matching the today-locked invariant and the Coach screen copy.

---

### Task 8: App — race goal setup UI (Settings + Onboarding)

**Files:**
- Modify: `FitnessApp/SettingsView.swift`
- Modify: `FitnessApp/OnboardingView.swift`

**Step 1: Settings.** Add `@Query private var raceGoals: [RaceGoal]` and a `RunningGoalCard` between `WeekScheduleCard` and `ReminderSettingsCard`:

- No goal yet → title "Running", body "Set a race goal to unlock the ultra coach.", button **"Set up running"** (accessibilityIdentifier `running-setup-button`).
- Goal exists → editable fields: name (TextField), race date (DatePicker, `.date`), distance km (`IntegerField`-style; distance uses a `Double` — add a small `DecimalField` private struct in SettingsView or store km as Int if simpler: **store UI as Int km, write Double**), elevation gain m (Int), baseline weekly km (Int), longest recent run km (Int), running-days picker (reuse `TrainingDaysPicker` bound to `profile.runningDays`), long-run day `Picker` over `profile.runningDays` members.
- Save via `modelContext.save()` on change, like the rest of SettingsView.
- Update `ResetCard` copy to mention running data.

**Step 2: Onboarding.** Add an optional `RunningGoalCard`-lite (toggle "I'm also training for a race" → name/date/distance/elevation/running days). On `completeOnboarding`, insert a `RaceGoal` when enabled and set `profile.runningDays`/`longRunDayRaw`. `canCreateProfile` unchanged.

**Step 3: Verify** — build, then run the app in the simulator (`Skill: run` if needed): set a race goal in Settings, relaunch, confirm it persists.

**Step 4: Commit** — `Add race goal setup to settings and onboarding`

---

### Task 9: App — Coach screen plans both weeks

**Files:**
- Modify: `FitnessApp/CoachView.swift`
- Modify: `FitnessAppUITests/FitnessAppUITests.swift` (only if it asserts the button label — check first)

**Step 1:** Add `@Query private var raceGoals: [RaceGoal]` and `@Query(sort: \RunLog.completedAt, order: .reverse) private var runLogs: [RunLog]`. In `requestPlan()`:

- When `raceGoals.first` exists: build the request with `raceGoal:` + `runLogs:`, call `generateCombinedWeek`, then `persist(plan: response.strengthWeek.weeklyPlan(weekStart: request.weekStart), ... replacingFuturePlannedSessions: true)` **and** `persist(runningWeek: response.runningWeek, weekStart: request.weekStart, replacingFuturePlannedSessions: true)`, single `modelContext.save()`. Status: `"Saved \(strengthCount) strength sessions and \(runCount) runs. Today was left untouched."`
- No race goal: existing `/generate-week-plan` path unchanged.

Button label becomes **"Plan my week"** (`Label(isGeneratingPlan ? "Planning" : "Plan my week", systemImage: "sparkles")`), accessibilityIdentifier `plan-week-button`. `CoachInputsCard` gains race-goal lines when present: race name/date, distance + elevation, weeks to race, running days.

**Step 2: Verify** — build; with the proxy running locally is not possible from the app (host-pinned endpoint), so verify in simulator against the hosted proxy *after* Phase 1 server deploy, or temporarily verify decode path with the unit tests from Task 6. Run full iOS test suite.

**Step 3: Commit** — `Plan running and strength weeks together from the coach screen`

AMENDED after review: wrap the combined persist (strength + running + single save) in one synchronous do/catch with modelContext.rollback() on throw, no await between the two persists; record the combined response.summary (running + strength) in the CoachPlan row so the running summary isn't lost.

AMENDED after review: combined plan safetyFlags are folded into the persisted CoachPlan summary as a "Watch:" suffix; both branches persist via a shared saveAtomically helper (rollback on throw); reminder rescheduling failures no longer mask a successful save.

---

### Task 10: App — run cards in Today, run logging, Log timeline

**Files:**
- Modify: `FitnessApp/TodayView.swift`
- Modify: `FitnessApp/LogWorkoutView.swift` (append `LogRunView` struct)
- Modify: `FitnessApp/CalendarView.swift`
- Modify: `FitnessApp/TrainingPlanStore.swift` (formatting helpers)
- Test: `FitnessAppTests/TrainingEngineTests.swift` (scoring a run log)

**Step 1: Formatting helpers** in `TrainingPlanStore.swift`:

```swift
func runDistanceText(km: Double) -> String      // "12.5 km", strips trailing .0
func runPaceText(secondsPerKm: Int) -> String   // "5:30 /km"
func runTargetText(session: WorkoutSession) -> String
// pace → "5:30–6:00 /km", hr → "140–150 bpm", else runZone or "Easy"
```

**Step 2: Today.** `dueSession`/`futureSession` already surface running sessions (they're `WorkoutSession`s). Branch in the body: if `session.isRun`, render a new private `RunPrescriptionCard` (title, `RunKind` title pill, distance, elevation, duration, `runTargetText`, purpose from summary minus `"AI: "` prefix, plus — once Phase 3 lands — an "On your watch" `StatusPill` when `pushedToGarminAt != nil`). A **"Log this run"** button (`accessibilityIdentifier: "log-run-button"`) presents `LogRunView` as a sheet. Multiple due sessions (run + strength same day): change `dueSession` usage to `duePlannedSessions` — add alongside the existing helper:

```swift
func duePlannedSessions(from sessions: [WorkoutSession], now: Date = .init(), calendar: Calendar = .current) -> [WorkoutSession]
```

returning all of today's planned sessions sorted runs-first, and render a card per session in TodayView.

**Step 3: `LogRunView`** (in `LogWorkoutView.swift`, mirroring `LogWorkoutView`'s layout/buttons): fields distance km, moving time (minutes picker), elevation gain m, average HR (optional Int), RPE 1–10, feel 1–5, notes. Save: insert `RunLog(sessionId:, completedAt: Date(), ..., rpe:, feelScore:, source: .manual, needsConfirmation: false)`, set `session.status = .completed`, score via the existing engine:

```swift
let outcome = TrainingEngine().score(
    log: SessionLogInput(completed: true, pullUps: 0, pushUps: 0, plankSeconds: 0,
                         loggedPullUps: false, loggedPushUps: false, loggedPlankSeconds: false,
                         rpe: rpe, painLevel: 0, fatigueLevel: fatigueLevel(fromFeel: feelScore)),
    plannedSession: nil
)
```

with `fatigueLevel(fromFeel:)` mapping feel 1→9, 2→7, 3→5, 4→2, 5→1 (inverse of TodayView's `howYouFeltScore`). Apply to rank with `applyScoreOutcome`, save, dismiss.

**Step 4: Log (CalendarView).** Rows for running sessions show `RunKind` title + planned distance, and for completed ones planned vs actual (`runDistanceText`) from the matching `RunLog` (`@Query` RunLogs, lookup by sessionId). Keep the existing strength row rendering untouched.

**Step 5: Test** in `TrainingEngineTests.swift`: scoring a completed run log input yields positive consistency delta and streak +1; feel 1 maps to deload trigger (fatigue 9 → `didTriggerDeload`).

**Step 6: Verify** — full iOS test run + simulator pass: plan week (or insert preview run), see run card, log a run, streak increments, Log shows it.

**Step 7: Commit** — `Show and log running sessions in Today and Log`

---

# Phase 2 — Garmin pull

### Task 11: Garmin sidecar service (Python, FastAPI)

**Files:**
- Create: `GarminService/main.py`
- Create: `GarminService/garmin_mapping.py`
- Create: `GarminService/test_garmin_mapping.py`
- Create: `GarminService/requirements.txt` (`fastapi`, `uvicorn`, `garminconnect`, `pytest` in a dev extra or same file)
- Create: `GarminService/.env.example` (`GARMIN_EMAIL=`, `GARMIN_PASSWORD=`, `GARMIN_TOKENS_DIR=./tokens`, `PORT=8788`)
- Create: `GarminService/README.md`
- Modify: `.gitignore` (add `GarminService/tokens/`, `GarminService/.env`, `__pycache__/`)

**Step 1: Pin and inspect the library.** `cd GarminService && python3 -m venv .venv && . .venv/bin/activate && pip install fastapi uvicorn garminconnect pytest && pip freeze | grep -i garmin`. Print the workout-related surface before writing code:
`python -c "import garminconnect, inspect; print([m for m in dir(garminconnect.Garmin) if 'workout' in m.lower() or 'wellness' in m.lower() or 'sleep' in m.lower() or 'hrv' in m.lower() or 'body_battery' in m.lower() or 'training_readiness' in m.lower()])"`
Adapt the exact method names below to what the installed version exposes (expected: `get_activities_by_date`, `get_sleep_data`, `get_hrv_data`, `get_body_battery`, `get_training_readiness`, `get_rhr_day`, `upload_workout`/workout create + `schedule_workout` style methods).

**Step 2: TDD the pure mapping layer** (`garmin_mapping.py` — no network): write `test_garmin_mapping.py` with fixture dicts (copy real response shapes from the library's README/examples into the test file) covering:
- `wellness_day(date, sleep_json, hrv_json, body_battery_json, readiness_json, rhr_json) -> dict` → `{date, sleepScore, sleepSeconds, hrvStatus, hrvMs, bodyBattery, trainingReadiness, restingHr}` with 0/"" defaults for missing pieces.
- `running_activity(activity_json) -> dict | None` → `{garminActivityId, startTime, activityType, distanceKm, movingSeconds, elevationGainM, averageHr, averagePaceSecPerKm, name}`; returns `None` for non-running activity types (`activityType.typeKey` not containing `running`/`trail_running`/`ultra`).
- `build_workout(payload) -> dict` → Garmin structured-workout JSON for `{title, date, kind, distanceKm, durationMinutes, target{type,low,high}, notes}`: warmup step (10 min easy) + main step with distance end-condition and pace/HR target + cooldown (5 min easy) for hard kinds; single steady step for easy/recovery. Run `pytest` → fail → implement → pass.

**Step 3: FastAPI app** (`main.py`): lazy singleton `Garmin` client; login order: token dir (`garth`-style resume) → email/password (writes tokens); on `GarminConnectAuthenticationError` set `last_error` and report via status instead of crashing.

Routes:
- `GET /status` → `{"ok": true, "loggedIn": bool, "lastError": str | null}`
- `GET /wellness?days=N` (default 7, max 30) → list of `wellness_day` for each date.
- `GET /activities?days=N` (default 14, max 60) → `running_activity`-mapped, `None`s filtered.
- `POST /workouts/push` body `{"workouts": [...]}` → per item: `build_workout`, create+schedule via the library, collect `{"sessionId", "garminWorkoutId", "scheduled": bool, "error": str | null}`; never abort the batch on one failure.
- `POST /workouts/delete` body {"workoutIds": [...]} → per-id delete via the library, tolerant of already-deleted ids (report per-id status, never abort batch).

Also a one-time login helper: `python main.py login` path that performs interactive login (prompts MFA code if asked) and saves tokens.

**Step 4: README.md** — run instructions (`uvicorn main:app --port 8788`), env vars, the one-time `login` step, Coolify notes (second app, internal port 8788, **no public domain**, persistent volume mounted at `GARMIN_TOKENS_DIR`).

**Step 5: Verify** — `pytest` green. Live smoke is manual and optional here: with real creds in `.env`, `curl localhost:8788/status` shows `loggedIn: true`.

**Step 6: Commit** — `Add Garmin sidecar service with wellness, activities, and workout push`

---

### Task 12: Proxy — `/garmin/*` passthrough + context enrichment (TDD)

**Files:**
- Create: `Proxy/src/garmin/garmin-client.ts`
- Test: `Proxy/src/garmin/garmin-client.test.ts`
- Modify: `Proxy/src/server.ts`
- Modify: `Proxy/.env.example` (`GARMIN_SERVICE_URL=http://127.0.0.1:8788`)

**Step 1: Failing tests** for `garmin-client.ts` using an injected `fetch` stub (the module takes `fetchImpl` parameter defaulting to global fetch): `garminStatus()` maps sidecar JSON; sidecar unreachable (fetch rejects) → `{ok: false, loggedIn: false, lastError: "Garmin service is not reachable."}` instead of throwing; `garminSnapshot(sinceDays)` combines `/wellness` + `/activities` into `{status, wellness, activities}`; `pushWorkouts(workouts)` POSTs and returns results; all functions return degraded shapes (empty arrays + status) on non-200.

**Step 2: Implement `garmin-client.ts`** (~80 lines, plain fetch wrappers reading `process.env.GARMIN_SERVICE_URL ?? "http://127.0.0.1:8788"`).

**Step 3: Routes in `server.ts`:**
- `GET /garmin/status` → `writeJSON(res, 200, await garminStatus())`
- `GET /garmin/snapshot?sinceDays=N` → combined result (cap N at 30)
- `POST /garmin/push-workouts` → body `{workouts: [...]}` → passthrough result
- Replace the Task 5 `enrichWithGarmin` stub: fetch `garminSnapshot(7)`; when `status.loggedIn`, set `context.garmin = { wellness }` (and append a `readiness.riskFlags` entry `"garmin: training readiness low"` when the latest day has `trainingReadiness > 0 && < 30`). Wrap in try/catch → leave context untouched on any failure. Apply in **both** `/generate-week` and `/coach-verdict` handlers.

**Step 4: Verify** — `npm test && npm run typecheck`. Manual: with the sidecar running, `curl localhost:8787/garmin/status`.

**Step 5: Commit** — `Proxy Garmin passthrough routes and wellness-enriched coach context`

---

### Task 13: App — Garmin sync, snapshots, activity auto-match (TDD)

**Files:**
- Modify: `FitnessApp/CoachClient.swift` (DTOs + client methods)
- Modify: `FitnessApp/TrainingPlanStore.swift` (matching + ingest logic)
- Modify: `FitnessApp/AppShellView.swift` (sync on foreground)
- Modify: `FitnessApp/TodayView.swift` (confirm-run card)
- Test: `FitnessAppTests/CoachValidationTests.swift` (DTO decode) + `FitnessAppTests/PersistenceResetTests.swift` (ingest/match against in-memory container)

**Step 1: Failing tests:**
- Decoding fixture JSON for `GarminStatusResponse`, `GarminSnapshotResponse` (status + wellness array + activities array).
- `ingest(wellness:in:)` upserts one `GarminDailySnapshot` per date (re-ingesting same date updates, doesn't duplicate).
- `match(activities:to:existingRunLogs:)`: activity on the same calendar day as a planned running session → creates `RunLog(source: .garmin, needsConfirmation: true)` with actuals + `garminActivityId`; already-ingested `garminActivityId` is skipped; two same-day planned runs → matches the one whose `plannedDistanceKm` is closest; activity with no planned session that day → no log (ignored, YAGNI).

**Step 2: Run → fail.**

**Step 3: Implement.**

DTOs in `CoachClient.swift` (`GarminWellnessDayResponse`, `GarminActivityResponse`, `GarminStatusResponse`, `GarminSnapshotResponse`) + `LocalCoachClient.fetchGarminStatus()` / `fetchGarminSnapshot(sinceDays:)` (paths `/garmin/status`, `/garmin/snapshot`).

Logic in `TrainingPlanStore.swift`:

```swift
func ingest(wellness: [GarminWellnessDayResponse], in modelContext: ModelContext) throws
@discardableResult
func matchGarminActivities(
    _ activities: [GarminActivityResponse],
    sessions: [WorkoutSession],
    existingRunLogs: [RunLog],
    in modelContext: ModelContext,
    calendar: Calendar = .current
) throws -> Int   // number of new pending run logs
```

Matching rule (encode exactly): candidate sessions are `discipline == .running && status == .planned` on the activity's calendar day; pick `min_by(abs(plannedDistanceKm - activity.distanceKm))`; skip if any existing RunLog has the same `garminActivityId`; the created log copies distance/movingSeconds/elevation/avgHr/pace, `rpe: 0`, `needsConfirmation: true`. Session status stays `.planned` until confirmed.

Sync in `AppShellView`: add `@AppStorage("garminLastSyncAt") private var garminLastSyncAt: Double = 0` and a `syncGarmin()` task called from the existing `refreshTrainingPlanState()` path when `scenePhase == .active` and last sync > 30 minutes ago; it fetches snapshot (sinceDays 7), runs `ingest` + `matchGarminActivities`, updates the timestamp; all failures swallowed silently (status surfaced in Settings, Task 16).

Confirm card in `TodayView`: when a due running session has a `RunLog` with `needsConfirmation == true`, render `ConfirmRunCard` ("Synced from Garmin: 12.4 km, 1:12, 380 m+ , avg 148 bpm") with RPE + feel pickers and a **"Confirm run"** button (`accessibilityIdentifier: "confirm-run-button"`) → sets rpe/feel, `needsConfirmation = false`, `session.status = .completed`, scores via the Task 10 path. A secondary "Edit details" opens `LogRunView` prefilled.

**Step 4: Run tests → pass. Build + full iOS suite.**

**Step 5: Commit** — `Sync Garmin wellness and auto-match activities to planned runs`

AMENDED after review: manual run logging leaves a feel-1 (very weak) run as .completed with no deload record and CoachRunSummary carries rpe but not feelScore — Task 13 should either set .deload status for feel<=1 runs or add feelScore to CoachRunSummary (and the proxy RunSummary type) so catastrophic runs reach the coaches.

---

### Task 14: App — readiness strip + running volume on Progress

**Files:**
- Modify: `FitnessApp/ProgressView.swift`

**Step 1:** Add `@Query(sort: \GarminDailySnapshot.date, order: .reverse) private var snapshots: [GarminDailySnapshot]`, `@Query` RunLogs + RaceGoal. At the top of the screen, `ReadinessStripCard` (latest snapshot: sleep score, HRV status, Body Battery, training readiness, resting HR as `MetricCard`-style tiles; hidden entirely when no snapshots exist). Below it, `RunningProgressCard` (only when a `RaceGoal` exists): this week's km + m+ vs last week (sum of confirmed RunLogs), longest run last 6 weeks, countdown — "X weeks to \(race name)".

**Step 2: Verify** — build; simulator check with seeded snapshot (add one in the DEBUG seed in `RootView.swift` `seedTwoWeekActivityPreview` while you're there: one `GarminDailySnapshot` + two confirmed `RunLog`s + one planned run session, so UI tests and previews exercise the running path).

**Step 3: Commit** — `Show Garmin readiness and running volume on Progress`

---

# Phase 3 — Garmin push

### Task 15: Push planned runs to the watch

**Files:**
- Modify: `FitnessApp/CoachClient.swift` (push DTOs + client method)
- Modify: `FitnessApp/CoachView.swift` (push after plan, sync row)
- Modify: `FitnessApp/TodayView.swift` ("On your watch" badge)
- Test: `FitnessAppTests/CoachValidationTests.swift` (request encode / response decode)

**Step 1: Failing test:** `GarminPushRequest(workouts:)` built from running `WorkoutSession`s encodes sessionId/title/ISO date/kind/distanceKm/durationMinutes/target/notes; decode of `GarminPushResponse` fixture maps per-session results.

**Step 2: Implement:** `LocalCoachClient.pushWorkoutsToGarmin(_:)` → POST `/garmin/push-workouts`. In `CoachView.requestPlan()` combined path, after `modelContext.save()`: fetch the just-persisted future running sessions, push, then for each successful result set `garminWorkoutId` + `pushedToGarminAt = Date()` and save again; on failure set `generationStatus` suffix `"Runs are planned but not on your watch yet — retry from the Garmin row."` Add a `GarminSyncRow` card on CoachView (status from `fetchGarminStatus`, "last sync" from the AppStorage timestamp, **"Push runs to watch"** retry button pushing all future planned runs without a `garminWorkoutId`, accessibilityIdentifier `garmin-push-retry`). In `RunPrescriptionCard`/`UpcomingSessionCard`, show `StatusPill(text: "On your watch", systemImage: "applewatch")` when `pushedToGarminAt != nil`.

**Step 3: Verify** — unit tests pass; build; end-to-end manual check happens after deploy (Task 17 checklist).

**Step 4: Commit** — `Push planned runs to Garmin and show watch status`

AMENDED after review: replans delete planned running sessions and with them their garminWorkoutIds, which would orphan already-pushed workouts on the Garmin calendar. Task 15 must: (a) have deleteFuturePlannedSessions (or the calling flow) collect garminWorkoutIds of deleted running sessions, (b) add a sidecar endpoint DELETE /workouts (batch by id) + proxy passthrough POST /garmin/delete-workouts, and (c) call it before pushing the new week. Task 11 should include the sidecar delete capability from the start.

---

# Phase 4 — Polish + ship

### Task 16: Settings Garmin panel + degraded mode

**Files:**
- Modify: `FitnessApp/SettingsView.swift`

`GarminCard` after `RunningGoalCard`: status line (Connected / Not logged in / Unreachable via `fetchGarminStatus`), last sync time, **"Sync now"** button (same sync routine as AppShellView, surfacing errors as text), explanation copy ("Garmin login lives on the lockin server. If this shows Not logged in, run the login step on the server."). Verify in simulator with the sidecar stopped (status shows unreachable, app otherwise fully functional) — that demonstrates degraded mode. Commit — `Add Garmin status panel to settings`

### Task 17: Docs, inventory, deploy checklist

**Files:**
- Modify: `README.md` (routes table: `/generate-week`, `/garmin/*`; architecture diagram + GarminService section; running goal in "What the app does")
- Modify: `FitnessAppTests/TEST_INVENTORY.md` (new tests from Tasks 1–15)
- Modify: `Proxy/README.md` (GARMIN_SERVICE_URL env)

Include a deploy checklist in README: deploy `GarminService` on Coolify (internal-only, volume for tokens, run one-time login), set `GARMIN_SERVICE_URL` on the proxy app, redeploy proxy, `curl https://lockin.elevenfactor.com/garmin/status`. Commit — `Document running coach and Garmin deployment`

### Task 18: Full verification pass

1. `cd Proxy && npm run typecheck && npm test` — all green.
2. `cd GarminService && pytest` — all green.
3. `xcodebuild test ...` (full iOS suite) — all green.
4. Simulator walkthrough: onboard with race goal → Plan my week (against deployed proxy) → run card today with watch badge → confirm a synced run (or log manually) → Progress shows readiness + volume → Settings shows Garmin Connected → wipe data resets everything including running models.
5. Fix anything found; final commit — `Verify ultrarunning coach end to end`

---

## Risk notes for the executor

- **garminconnect API drift:** method names in Task 11 Step 1 are verified against the installed version before any code is written; all Garmin parsing lives in `garmin_mapping.py` behind fixture tests.
- **OpenAI strict schema:** every property must appear in `required` and `additionalProperties: false` at every level, or the Responses API rejects the format — the Task 2 schema already complies; keep it that way when editing.
- **SwiftData migrations:** if the simulator app crashes on first launch after Task 1, delete the app from the simulator (stale store) and relaunch — but the additive-defaults pattern should migrate cleanly; the PersistenceReset tests guard it.
- **Endpoint pinning:** `LocalCoachClient` only accepts `lockin.elevenfactor.com`. Proxy-side changes are only testable from the app after deploy; use unit tests + curl locally, deploy the proxy before the Task 18 walkthrough.
