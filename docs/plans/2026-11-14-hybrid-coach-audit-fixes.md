# Hybrid Coach Audit Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (or superpowers:executing-plans) to implement this plan task-by-task.

**Goal:** Make lockin's coach progress a hybrid athlete (calisthenics strength + trail running) on its own — after a race, without a next race, and without the athlete steering — by fixing the defects found in the 14 Nov 2026 audit.

**Architecture:** All coaching decisions that the audit found "left to the model" or "computed wrong" move into the proxy's planner code (`Proxy/src/coach/planner/`), with the skill/prompt text rewritten to match exactly what the code enforces. A single computed **season** (race state, phase, emphasis) drives both the running and the strength planner. Part 2 adds a leg-strength family to the exercise library and the iOS app, scheduled by body region.

**Tech Stack:** TypeScript (Node 22, `node --test` via tsx) for the proxy; Swift/SwiftUI/SwiftData + XCTest for the iOS app; LLM prompts in Markdown skill files.

**Source of truth for the "why":** `reports/Hybrid coach instruction audit.md` and the four notes in `research_notes/Hybrid coach instruction audit/` (strength_calisthenics.md, ultra_trail_running.md, concurrent_training.md, monitoring_autoregulation.md). Each task names the report section it fixes; implementers must read that section and the cited code lines before writing tests.

**Athlete facts that shape defaults:** no next race (last race 31 Oct 2026, 54 km / 1,400 m, still stored in the app as the race goal); has access to weights (dumbbells; possibly barbell); ~40 push-ups max; 35-45 km/week; 6 training days; goal "stronger and faster" without steering the coach.

---

## Ground rules for every task

- Work in `/Users/erwinvink/ai_stuff/lockin` on the current branch. **Do not commit, push, stash, reset or checkout.** Other uncommitted work (13 Nov delivered-work changes) is the base you build on.
- TDD, strictly: write the failing test, run it, see it fail for the right reason, implement the minimum, see it pass. Then run the full proxy suite and typecheck:
  - `cd Proxy && npm test` (expect all pass) and `npm run typecheck` (expect no output errors).
  - When Swift changes: `xcodebuild test -project FitnessApp.xcodeproj -scheme FitnessApp -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:FitnessAppTests` (expect `** TEST SUCCEEDED **`).
- An existing test that encodes behavior this task deliberately changes may be updated; say which and why in your report. Never weaken a test's purpose to make it pass.
- Prompt/skill text must match what code enforces: nothing the model is told may be rejected by a validator, and every enforced rule must be stated to the model. Athlete-facing text is plain coaching language (no field names, no snake/camelCase, no "validator/proxy/JSON").
- Keep modules small; put new computed concepts in their own file under `Proxy/src/coach/planner/` with a focused test file next to it.
- Report back: files changed, tests added/changed (and why), final `npm test` pass count, typecheck result.

---

# PART 1 — Proxy fixes (deployable without an app release)

### Task 1: Computed season — race state, phase, emphasis

Fixes report §"A finished race reads as in taper forever" and §"hierarchy" (emphasis). Read: report lines 15-31, 101-117; ultra_trail_running.md (race-state traces); concurrent_training.md (emphasis proposal).

**Files:**
- Create: `Proxy/src/coach/planner/season.ts`, `Proxy/src/coach/planner/season.test.ts`
- Modify: `Proxy/src/coach/planner/types.ts` (add `season` to `CoachContext`), `build-coach-context.ts` (set `context.season`), `compute-training-signals.ts` (`raceSignals`, lines ~167-176), `running-phase-limits.ts` (`TAPER_LIMITS.postRaceDays` → per-race window; `phaseForDaysToRace` takes the window), `chat.ts` (~line 300 race line), `evaluate-coach-read.ts` (any "weeks to race" wording), `skills/running-coach-planner/SKILL.md`, `references/ultra-periodization.md` (phase table), `skills/fitness-coach-planner/SKILL.md` (one sentence: read `coachContext.season`).
- Modify (app, text only): `FitnessApp/CoachView.swift:~674-690` (`weeksToRaceText`/race summary must say "Raced N days ago" / no "Race week" for a past date).

**Behavior:**
```ts
export type Season = {
  raceState: "upcoming" | "recent" | "none";   // recent = inside the post-race window
  raceName: string | null;
  daysToRace: number | null;                   // upcoming only
  daysSinceRace: number | null;                // recent, or none after a race
  postRaceDays: number;                        // window for the stored race
  phase: "general_preparation" | "base" | "build" | "peak" | "taper" | "transition";
  emphasis: "transition" | "strength_led" | "balanced" | "run_led" | "taper";
  reason: string;                              // one plain sentence for prompts
};
```
- `postRaceDays = clamp(round(distanceKm / 4), 7, 28)` (54 km → 14; 21 km → 7; 100 km → 25; 170 km → 28).
- Upcoming race (raceDate ≥ weekStart): days = round((race − weekStart)/day). Phase: taper ≤ 21 days; peak ≤ 6 weeks; build ≤ 12 weeks; base ≤ 16 weeks; general_preparation beyond 16 weeks. Emphasis: taper ≤ 10 days; run_led ≤ 8 weeks; balanced ≤ 16 weeks; strength_led beyond.
- Past race within `postRaceDays`: raceState recent, phase transition, emphasis transition.
- Past race beyond the window, or no race: raceState none, phase general_preparation, emphasis strength_led.
- `trainingSignals.race` for a past race must never say `"in-taper"`: add `daysSinceRace` and `taperStatus: "post-race"` (inside window) or `"none"` (beyond); `daysToRace` becomes null for past races. Update every consumer (grep `taperStatus`, `daysToRace`, `weeksToRace`).
- `weeksToRace` stays for compatibility but the prompts must pick the phase from `coachContext.season.phase`.
- `runningPhaseLimits` uses the stored race's `postRaceDays`: post_race_1w = days 1-7 after; post_race_2w = day 8 through the window end; beyond → build limits (normal caps).
- Prompts: running SKILL.md and ultra-periodization.md get a phase table that includes **transition** and **general_preparation** (see Task 3 for their training content); "Use `coachContext.season.phase`". The chat/coach read say "your race N days ago" / "no race planned", never "0 weeks out".

**Tests (season.test.ts), at least:**
1. `a 54 km race 1 day ago is a 14-day transition` → raceState recent, phase transition, emphasis transition, daysSinceRace 1, postRaceDays 14.
2. `the day after the window the athlete is in general preparation, strength-led` (race 31 Oct, weekStart 15 Nov) → none / general_preparation / strength_led / daysSinceRace 15.
3. `post-race window scales with race size` (21, 54, 100, 170 km).
4. `upcoming race phases by distance` (25 weeks → general_preparation/strength_led; 14 → base/balanced; 10 → build/balanced; 5 → peak/run_led; 15 days → taper/run_led; 8 days → taper/taper).
5. In compute-training-signals tests: `a past race is never in taper` (taperStatus post-race then none, daysToRace null).
6. In running-phase-limits/guardrails tests: `a 100 km race keeps the easy post-race rules for 25 days`.

---

### Task 2: Running speed rules and phase content (text)

Fixes report §"Inside a race build, the rules still ask for too little speed". Read report lines 21-25 and ultra_trail_running.md speed sections. Text only, but it must match Tasks 3 and 4.

**Files:** `Proxy/src/coach/skills/running-coach-planner/references/ultra-periodization.md`, `Proxy/src/coach/skills/running-coach-planner/SKILL.md`, `Proxy/src/coach/planner/coach-temperament.ts` only if the principle text needs a running word.

**Content (state each rule once; remove contradictions such as "at most one quality session" vs "one or two"):**
- **transition** (post-race window): week 1 easy/recovery only; after day 7 easy runs plus strides (4-6 × 20 s relaxed-fast with full recovery) in two easy runs; no tempo, interval or hill sessions until the window ends; long run easy and short.
- **general_preparation** (no race, or race > 16 weeks): one structured speed session a week (VO2max or hill intervals: 2-4 min reps, 12-24 min total at intensity, adding 2-3 min every 1-2 weeks; or threshold 3 × 8-12 min building toward 2 × 20 min), strides in two easy runs, volume +5-10%/week up to a sustainable ceiling, long run growing to 2.5-3 h, one descent-loaded run every 2-4 weeks, 3:1 recovery weeks.
- **base** (13-16 weeks, as computed in Task 1): as general preparation, plus a gradually longer long run.
- **build** (7-12 weeks): one or two quality sessions (one race-specific: long climbs/descents), long run toward race demand.
- **peak** (4-6 weeks): race specificity, biggest long runs and elevation; one quality session.
- **taper**: unchanged (it already matches the evidence).
- Progression: increase time at intensity by 2-4 min/week, never volume and intensity in the same week.
- Fix the downhill citation (report line 29; ultra_trail_running.md "Khassetarash 2022, recreational runners, up to ~6 weeks").

**Tests:** extend `coach-temperament.test.ts` instruction-coverage test (or a new `skills.test.ts`) to assert the running skill files name both `transition` and `general_preparation` and no longer contain "At most one quality session per week".

---

### Task 3: Running floors by phase (enforced)

Fixes report §"nothing requires a quality session or enforces a volume floor". Read report lines 17, 25; validate-running-week.ts:120-129; running SKILL.md:54; compute-training-signals.ts:83-87.

**Files:** `Proxy/src/coach/planner/validate-running-week.ts` (+ test), `running-guardrails.ts` (expose the floor in `guardrails` for the prompt), `compute-training-signals.ts` (easy-share flag), running SKILL.md (state the enforced floors).

**Behavior (only when season.phase ∈ {general_preparation, base, build, peak} AND no recovery week, no computed relaxation, ≥ 3 runs planned):**
- At least one run of kind `tempo`, `intervals` or `hills` (the long run does **not** count). Replace the `weeksToRace > 3` guard with this phase rule.
- Planned weekly km ≥ 85% of the guardrails' reference/target weekly km (use the same reference the weekly cap uses; read running-guardrails.ts to find it). Below → validator message naming the floor.
- **Amended during review (as built):**
  - The floors (and the weekly cap) count a 7-day window: today's run (done today, else planned for today) plus offsets 1-6. Today's quality run satisfies the quality floor, and after a hard run today, offset 1 can't be hard.
  - km floor = min(0.85 × the 4-week average TRAINING km, last-7-days TRAINING km). Races are excluded and both are counted from local midnight, so the floor never forces a volume jump in the same week as new intensity.
  - Exemptions:
    - the first week back after 4+ weeks off;
    - no free eligible day for a quality run (quality floor only);
    - the race window reaching into the week (km floor only);
    - the floor not fitting under the long-run cap.
  - Continuity yields to the floors (`planner/continuity-floors.ts`): a change signal fires when the kept plan cannot reach floor + 0.5 km. The estimate counts each kept run at +15% within its own cap, rounded down to 0.5 km, and uncovered days at their allowed maximum. A quality variant fires when no eligible day is left. A season-change signal (transition → general preparation) also releases continuity.
  - The profile note never relaxes a floor (owner decision; see Task 11). A tripped wellness gate keeps every floor and keeps quality runs out of the next 48 h.
- Transition phase: no floor and no quality requirement.
- `trainingSignals.running`: add a flag when the easy share of the last 3 weeks ≥ 0.95 in those phases ("no speed stimulus in 3 weeks"); the running prompt tells the model to add the structured session.

**Tests:** (validate-running-week.test.ts / running-guardrails.test.ts)
1. `general preparation rejects an all-easy week with a long run` (long + 4 easy → message).
2. `a tempo run satisfies the quality floor`.
3. `transition accepts an all-easy week`.
4. `general preparation rejects a week under 85% of the reference km` and accepts one at 90%.
5. `a recovery week lifts both floors; a wellness gate keeps both floors but no quality run may fall in the next 48 h` (resolved 14 Nov: the gate acts on the next 48 h only, per Task 4 and the audit).

---

### Task 4: Tighten the aggressive running items

Fixes report lines 27-31. Read ultra_trail_running.md "too aggressive" items; running-guardrails.ts:590-603 (HRV gate) and 682-688 (long-run cap); running-phase-limits.ts:267-270 (post-race week 2).

**Files:** `running-guardrails.ts`, `running-phase-limits.ts`, `compute-training-signals.ts` (if the gate lives there), tests next to them, running SKILL.md / ultra-periodization.md wording.

**Behavior:**
- Long-run cap = 1.15 × the longest **training** run of the last 30 days (exclude runs of kind `race` and any run on the stored race date); with no long run in 30 days fall back to the existing reference. Track race distance separately as "demonstrated capacity" text only. **As built:** the fallback is the longest training run of the last 42 days, else the 20 km return-week cap — never a race. The weekly cap uses the same 7-day window as the floors, anchored at local midnight; the climbing average excludes races and uses the same window, with today's climbing subtracted. Wellness gate data: `ENRICHMENT_DAYS` 4; the latest HRV reading with data, ignored when older than 2 days; sleep counted over the last 3 nights that have a score; every wellness value comes from its own latest day with data and carries that date. Hard-run cap: counted over the same 7-day window — today's run counts (from the 3 km easy-run minimum; a race today is hard). A race in the 7-day window satisfies the quality floor (owner decision: the race is that week's quality stimulus). Operational follow-up: time a real `/wellness?days=4` sidecar call once deployed; if close to the 10 s enrichment timeout, give the 01:30 auto-plan a longer timeout or trim older-day calls.
- Post-race window after day 7: allowed kinds easy, recovery, long (easy pace) — no tempo/intervals/hills (matches Task 2's transition text). Weekly ratio for day 8+ stays 0.7.
- Weekly planned climbing ≤ max(1.25 × the 4-week average weekly climbing, 300 m) outside taper rules (which stay stricter).
- HRV/wellness gate: trigger only on below-baseline HRV (Garmin status LOW/POOR, or 7-day average below the baseline range) — **not** on UNBALANCED when above baseline; a sleep score < 50 needs 2 of the last 3 nights. A tripped gate removes quality sessions from the next 48 h only and keeps the easy-run floor (does not empty the week).

**Tests:** one per bullet, plus `the 75.6 km post-race long-run cap is gone` (race 54 km in history → cap from training runs only).

---

### Task 5: Effort flags judged against the plan; scoped response; overreaching needs a co-signal

Fixes report §"Readiness rules cut the plan on two ratings" (lines 70-99). Read monitoring_autoregulation.md fully. **Ship together with Tasks 6 and 7** (scheduled tests would otherwise trip these flags).

**Files:** `build-coach-context.ts` (`collectRiskFlags`, `classifyState`), `strength-guardrails.ts` (non-normal progression band), `periodization.ts` and `current-plan.ts` if they read the same flags, `progression-policy.md`, fitness `SKILL.md`, tests in `build-coach-context.test.ts`.

**Behavior:**
- `repeated_high_perceived_effort`: count only logs with RPE ≥ 9 whose planned effort was below very_hard (plannedRPE ≤ 8, or planned label not very_hard/max_output) and whose session had no goal test; over-delivered logs stay excluded. 3 of the last 5 → flag.
- `recent_effort_above_plan` (2 of the last 5 planned-work logs ≥ 2 above plan, excluding over-delivery and test sessions) becomes a **calibration** signal: the goal metrics trained in those sessions get status `hold` (no progression, no reduction below the hold band); readiness stays normal.
- Readiness becomes `overreaching` only when an effort flag co-occurs with a second marker within 14 days: (a) a shortfall on a target the athlete had completed cleanly before, (b) the effort flag persists (3 of the last 5), or (c) 2+ of the last 5 logs rated Weak or Very weak.
- Decline (rolling trend) counts only with ≥ 2 shortfalls against plan in the recent window (keep the 13 Nov "follows lighter plan" rule).
- Overreaching response (strength): band = [previous − one step, previous] (hold or one step down), sets ≤ max(2, previousSets − 1), hard sets −30-50% for the week; text says "3-7 days". Not "reduce as needed within the cap".
- Policy/skill text describes exactly this ladder (calibrate → overreaching → recovery_needed).

**Tests:**
1. `a test session at RPE 10 never counts toward repeated high effort` (two tests + one very_hard session rated as planned → no flag, building).
2. `two sessions rated 2 above plan hold only the metrics they trained` (push-up sessions → pushUps hold, pullUps still earned/free, state building).
3. `effort above plan plus a shortfall is overreaching`.
4. `three of five above plan is overreaching without another marker`.
5. `overreaching holds or steps back one step, never down to 1 rep` (band check).
6. `one shortfall in the recent window is not a decline; two are`.

---

### Task 6: Assessment due — computed and enforced

Fixes report §"Strength targets ... wait for a test no code schedules" (lines 33-41). Read strength_calisthenics.md test sections; validate-week-plan.ts:578-596; strength-phase.ts (tests in recovery weeks).

**Files:** create `Proxy/src/coach/planner/assessment.ts` (+ test); modify `strength-guardrails.ts` (`strengthGuardrailsForPrompt` gets `assessment`), `validate-week-plan.ts`, `strength-phase.ts` / `clampStrengthPhase` (allow tests on the last 2 days of a recovery week), fitness `SKILL.md`, `progression-policy.md`.

**Behavior:**
- Per goal metric (pull-ups only with a pull-up bar): `daysSinceTest = weekStart − max(latestTestDate, baselineSetAt)` (null → treat as due if any logs exist).
- **Due** when daysSinceTest ≥ 42, or ≥ 28 and the metric is blocked (status hold because the cap and set limit block it, or plateau), in a normal-readiness week that is not the race taper, not transition week 1, and not a recovery week (except its last 2 days, where tests are allowed).
- When due and the week has a legal day (not the day before a long run or race — existing rule), the validator requires a test of that metric (`stimulus: test`, `max_output`, 1 set) somewhere in the week; all due metrics may share one session.
- `strengthGuardrailsForPrompt.assessment = { due: GoalMetric[], protocol: string, reason }`; the skill states the standard protocol once: after a warm-up at the start of the session, fresh (no hard work the day before), strict form standards from the library, one max set per metric, 3-5 min rest between metrics, record the number.
- A recovery week's last 2 days: the clamp keeps a test there instead of converting it to medium.

**Tests:**
1. `a metric 42 days after its last test is due`.
2. `a capped metric is due after 28 days`.
3. `no test is due in the taper, in transition week 1, or mid recovery week`.
4. `a due metric without a test in the week is sent back; with one it passes`.
5. `a test on the last day of a recovery week is kept`.

---

### Task 7: Exposures per goal movement, session rep budget, ladder text

Fixes report lines 41-60 (set-count-blind caps; ladders against goals). Read strength_calisthenics.md ladder/budget sections; exercise-library.json selectionRules (lines ~10-25).

**Files:** `strength-guardrails.ts` (budget clamp + prompt), `validate-week-plan.ts` (exposure rule), `exercise-library.json` (selection-rule text), `exercise-catalog.ts` if it echoes ladder text, fitness SKILL.md / progression-policy.md.

**Behavior:**
- Normal week: each goal metric (pull-ups only with a pull-up bar) appears as useful goal work or a test in ≥ 2 sessions, or in every session when fewer than 2 are planned. Validator message names the metric and the count.
- Session budget per goal metric: sets × target ≤ budget, budget = 3.0 × best (pull-ups), 3.5 × best (push-ups, plank seconds). The clamp lowers sets (never below the week's minimum sets) to fit; the progression's `maxSets` respects it (so the set route stops at the budget → that is a "blocked" metric for Task 6).
- Ladder text: push-ups 41+: "keep two push-up goal days (one high-rep or density day, one submaximal volume day); add harder variants on a third day"; plank 121 s+: "keep two plank holds a week for the goal; add harder variants"; pull-ups 13+: "keep two pull-up volume days; add weighted or archer work".

**Tests:**
1. `a normal week with push-ups in only one session is sent back`.
2. `40 push-ups: 6 x 30 is clamped to 4 sets` (budget 140).
3. `the set route stops at the budget and the metric becomes test-due after 28 days` (ties to Task 6).
4. `selection rules keep two goal days above 40 push-ups` (library text test).

---

### Task 8: Re-scope strength maintenance; readiness coherence; exit signals

Fixes report lines 84-86 and 105-107 (maintenance) and the coach-read contradictions. Read concurrent_training.md maintenance section; monitoring_autoregulation.md contradictions list; validate-combined-week.ts:57-86; evaluate-coach-read.ts:82-87,139; current-plan.ts:226-230; running-guardrails.ts:543-546.

**Files:** `validate-combined-week.ts` (incl. its fixed 14-day post-race branch ~lines 69-71 and the race-day `>= 0` check — deferred here from Task 1's review: use `contextSeason(context)`), `plan-pipeline.ts`, `strength-guardrails.ts`, `running-guardrails.ts`, `evaluate-coach-read.ts`, `current-plan.ts`, tests, policy/skill text (incl. fitness `SKILL.md` "the two weeks after the race" wording).

**Behavior:**
- Upper-body strength never enters maintenance for post-race windows or running km/hard-run counts: `strengthMaintenanceReason` no longer applies to upper-body goal work (keep the function for Part 2 leg dosing: peak ≤ 6 weeks, ≥ 3 hard runs excluding the long run, or > 1.1 × the 4-week average). Session minimum is therefore 3 in every normal week; taper/recovery-week rules unchanged.
- Post-race strength (found in the strength review): the strength side has no post-race rule, so very_hard strength the day after an ultra can pass. Post-race days 1-2: no hard strength (light or medium only); days 3-7: no very_hard or max_output; from day 8 normal upper-body progression (legs, Part 2: bodyweight only in transition). Clamp + validate + state it; test it.
- Strength-derived states do not relax the running week: running relaxations apply for `recovery_needed`, wellness gates and run distress, not for `overreaching` derived only from strength logs.
- Coach read: Garmin training readiness < 30 alone gives a "watch" status, not "Needs recovery"; the coach read's status comes from the same computed readiness as the planner (one source).
- Exit signal: when the readiness state at the time the current plan was generated was overreaching or recovery_needed and is now normal, `currentPlan.changeSignals` gets "Readiness is back to normal: return to the full plan." (compute the earlier state from logs up to `currentPlanGeneratedAt`).
- Text fixes: remove the "≥80% 1RM … frame strength as part of the ultra build" claim from `compute-training-signals.ts:~133` until Part 2 lands (Part 2 restores an accurate version); profile pain note expires after 28 days unless re-confirmed (if the app sends no date, leave as is and note it).

**Tests:** `a post-race week keeps upper-body progression and a 3-session minimum`; `strength-only overreaching does not relax running floors`; `training readiness 25 with normal logs reads watch, not needs recovery`; `leaving overreaching adds a back-to-normal change signal`.

---

# PART 2 — Legs and season-driven dosing (needs an app release)

### Task 9: Leg-strength family in library, catalog and app

Fixes report §"The real hybrid gap is the legs" (lines 109-117). Read concurrent_training.md strength-for-runners and minimal-dose sections.

**Files:** `exercise-library.json` (exercises + selection rules + form standards), `exercise-catalog.ts` (+ test that keeps names identical to the app), `weekly-plan.schema.json` enum (via `schemaForExercises`), `FitnessApp/AppModels.swift` (`ExerciseKind` cases + titles; `EquipmentKind.barbell`), `FitnessApp/WorkoutInfoView.swift` (how-to text), app tests that enumerate exercises.

**Exercises (support work, never goal metrics; logged only via session RPE):**
`gobletSquat` (dumbbells or backpack), `backSquat` (barbell), `bulgarianSplitSquat` (dumbbells/backpack/bodyweight), `romanianDeadlift` (dumbbells or barbell), `stepDown` (slow eccentric, bodyweight or dumbbells), `singleLegCalfRaise` (bodyweight or dumbbell), `nordicCurl` (bodyweight, anchored feet), `pogoJump` (bodyweight plyometric), `jumpSquat` (bodyweight plyometric). Add `barbell` to `EquipmentKind`. Loading is prescribed by reps in reserve in the exercise's reason text ("pick a weight that leaves 2 reps"), since the schema has no load field.

**Tests:** catalog/app name parity test passes; equipment filter (barbell lifts need barbell); Swift unit tests pass.

### Task 10: Leg dosing by season emphasis and region-aware scheduling

**Files:** create `Proxy/src/coach/planner/leg-strength.ts` (+ test); modify `validate-combined-week.ts`, `strength-guardrails.ts` (prompt guidance), `plan-pipeline.ts`, fitness SKILL.md, progression-policy.md, `compute-training-signals.ts` (restore an accurate running-economy line).

**Behavior:**
- Leg sessions per week by emphasis: strength_led 2 heavy (3-5 × 4-6 at 2-3 reps in reserve: a squat or split squat, a hinge, calves; plyometrics 2-3 × 6-10 contacts; Nordic 2-3 × 3-5); balanced 2 (6-10 reps, add eccentric step-downs); run_led 1 maintenance (2-3 heavy sets); taper 0 hard; transition bodyweight only from day 8. Leg work lives inside existing sessions (a 20-30 min block), not extra sessions.
- Region-aware rules replace the blanket "no hard strength on hard-run days": upper-body work may sit on any run day; heavy legs may sit on a quality-run day (after the run) or an easy day, never within 48 h before a long run, quality run or race; no plyometrics the day before a long run.
- First 2 weeks of leg work: one set less and 3+ reps in reserve (unaccustomed soreness).

**Tests:** emphasis → leg dose; 48 h rule violations rejected; upper-body hard on a tempo day accepted; plyometrics before a long run rejected.

---

### Task 11: Structured pain/injury input replaces the free-text heuristic

Free-text keyword detection of pain notes cannot be made reliable in Dutch and English (14 Nov reviews: every phrase-list version still produced false positives on fresh notes). Decision in Part 1: the free-text profile note never relaxes a floor or minimum (it is model context only; pain logs drive recovery). This task adds the explicit way to say "I'm injured, ease off".

**Files:** `FitnessApp/AppModels.swift` (profile: `hasCurrentPainOrInjury: Bool`, `painOrInjuryArea: String`, `painOrInjurySince: Date?`), the profile/New Plan UI where "Pain, injuries or limits" is edited, `FitnessApp/CoachClient.swift` (send `painInjury: { current, area, since }`), proxy `types.ts` + request parsing, `running-guardrails.ts` / `strength-guardrails.ts` (floors and minimums read the structured flag; the free-text note stays model context only), skills text, tests on both sides.

**Also:** runs carry only a feel score today, so a runner with knee pain who logs no strength session can lower the plan only by rating a run feel 1-2. Add an optional pain level (0-10) and area to the run confirmation in the app and send it with `recentRuns`; a run with pain ≥ 4 counts like a strength log with pain ≥ 4 for readiness.

**Behavior:** a current pain/injury flag relaxes exactly what the old free-text pain note relaxed (run-count floor lowered, km floor lifted, quality floor kept, strength minimum 0); it expires 28 days after `since` unless the athlete re-confirms it in the app (the app asks); without the flag, free text never relaxes a floor.

---

# PART 3 — Later (not in this round)

Running without any race goal (app sends running without `raceGoal`; until then keep the past race in the app — the coach treats it as "no race planned"), Garmin sidecar sends the HRV 7-day average and baseline (`GarminService/garmin_mapping.py` ~190: `hrvWeeklyAvgMs`, `hrvBaselineLowMs`) so the below-baseline-average HRV trigger can fire, a pace check that keeps the post-race long run easy, per-set logging with reps in reserve and pain region, structured intervals in the Garmin mapping, shoulder-health block and pulling-volume ramp, daily check-in with illness flag, staged goal milestones.

---

## Verification after Part 1 and after Part 2

- `cd Proxy && npm test && npm run typecheck` all green; Swift unit tests green after Part 2.
- Scenario replay (scripts under /tmp, not in the repo) for this athlete: race 31 Oct (54 km), weekStart 15 Nov and 22 Nov, ~40 km/week of runs, push-ups best 40, logs at 20-25 per set:
  - running week (7-day window incl. today) has ≥ 1 tempo/intervals/hills run, km ≥ the floor min(0.85 × 4-week training avg, last-7-days training km), long run ≤ 1.15 × the 30-day training longest;
  - strength week has ≥ 3 sessions, each goal metric in ≥ 2 sessions, push-up targets 18-30, a test scheduled when due, sets within the budget;
  - signals say "general preparation" / "strength-led", never "in taper";
  - (Part 2) two leg blocks, none within 48 h before the long or quality run.
- Independent code review of the full diff before handing back.
