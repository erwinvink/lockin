---
name: fitness-coach-planner
description: Use when generating, reviewing, or repairing weekly strict calisthenics training plans from baseline measurements, goals, equipment, target date, sessions per week, planned sessions, and training logs. Always build deterministic context, use bundled references, return schema-valid JSON, and pass technical output validation before accepting a plan.
---

# Fitness Coach Planner

## Purpose

Generate safe, progressive weekly training plans for strict unbroken pull-up, push-up, and plank goals.

This skill is a planning pipeline, not a motivational chat prompt:

1. Build deterministic context from app data.
2. Compare immediate readiness with completed monthly history.
3. Use progression rules, exercise references, and benchmark anchors.
4. Produce structured JSON.
5. Validate the output shape before accepting it.

## Required Inputs

- Profile baseline: pull-ups, push-ups, plank seconds.
- Goal targets: pull-ups, push-ups, plank seconds.
- Profile pain, injury, or limitation notes.
- Week start date.
- Target date.
- Available equipment.
- Requested sessions per week.
- Raw performance logs, including which exercises were actually logged, perceived effort, pain level, Garmin-style how-you-felt self-evaluation, and the athlete's workout notes.
- Planned or completed sessions when available.

## Context Requirements

Before planning, run `scripts/build-coach-context.ts` and use its output. The context must include:

- `last5Logs`: immediate readiness signal, including perceived effort, pain level, and how the athlete felt after training.
- `currentPartialMonth`: current calendar month to date, labeled partial.
- `lastFullMonth`: most recent completed calendar month.
- `previousFullMonth`: completed calendar month before `lastFullMonth`.
- `twoFullMonthTrend`: comparison of last full month vs previous full month.
- `bestRecentTests`: best valid pull-up, push-up, and plank values from actually logged tests.
- `adherence`: planned/completed/missed/deload counts when planned sessions are available.
- `riskFlags`: pain, poor how-you-felt feedback, repeated high perceived effort, missed-session, sudden-volume, or insufficient-history warnings.
- `weekStart`: the Monday/Sunday app-provided start date for scheduling this plan.
- `profileNotes` and recent log `notes`: human context for limitations, form issues, soreness, or unusual circumstances.

Do not ask the model to infer these summaries from raw logs.

## References

- Use `references/progression-policy.md` for progression and deload rules.
- Use `references/exercise-library.json` for available exercise variants and equipment constraints.
- Use `references/real-world-standards.md` when comparing app goals or consistency scores to external standards.
- Use `references/weekly-plan.schema.json` as the output contract.

## Planning Workflow

1. Read the built coach context.
2. Classify the state as one of: `building`, `plateau`, `overreaching`, `recovery_needed`, or `insufficient_history`.
3. Generate exactly the requested number of future sessions.
4. Assign each session a `dayOffset` from `1` through `6`, in strictly increasing order, relative to `weekStart`. `dayOffset: 0` is today and is locked.
5. Derive session length from prescribed work; do not use a fixed minutes-per-session input.
6. Include a `plannedEffort` object for every session and every exercise.
7. Include a short purpose for every session.
8. Mark logging fields only for goal exercises actually trained or tested in the session.
9. Return only JSON matching `weekly-plan.schema.json`.
10. Run `scripts/validate-week-plan.ts` for technical output checks.
11. If technical validation fails, repair once. If validation still fails, return an error to the app instead of accepting malformed output.

## Weekly Structure Policy

The app-visible workout calendar is generated from this skill output, so do not rely on hidden app defaults for the weekly split.

## Self-Evaluation Metrics

The app follows Garmin-style post-workout self-evaluation language:

- `rpe` is the stored compatibility key for `perceivedEffort`, a 1-10 rating of how hard the workout felt.
- `fatigueLevel` is the stored compatibility key for the inverse of "How did you feel?" Higher `fatigueLevel` means the athlete felt worse after training.
- Current UI mapping: "Very weak" -> fatigueLevel 10, "Weak" -> 8, "Normal" -> 5, "Strong" -> 2, "Very strong" -> 0.
- When writing athlete-facing text, say "perceived effort" and "how you felt"; do not call the second metric "fatigue" unless explaining an internal safety flag.
- Treat "Very weak" or fatigueLevel >= 9 as a recovery-needed signal. Treat repeated "Weak" feedback as an overreaching warning unless performance and pain are clearly fine.

## Planned Effort Labels

Every planned session and exercise must declare the intended effort up front.

- `light`: RPE 1-4. Recovery, warm-up, mobility, or deliberately easy technique.
- `medium`: RPE 5-6. Useful repeatable work with several clean reps left.
- `hard`: RPE 7-8. Productive goal stimulus with roughly 2-3 clean reps left.
- `very_hard`: RPE 9. Near-limit work with about 1 clean rep left.
- `max_output`: RPE 10. A deliberate test or max set with 0 clean reps left.

Use `targetRIR` as reps in reserve for rep work. For timed holds, use it as the practical effort reserve: `0` means no clean hold time left, `1` means near-limit, and higher values mean clearly submaximal.

Use `stimulus` to state the training purpose:

- `recovery`: easy work to maintain habit and reduce stress.
- `technique`: skill/form practice.
- `volume`: repeatable submaximal work that builds capacity.
- `strength`: hard goal-focused stimulus.
- `test`: deliberate max or near-max benchmark.

Do not hide a weak plan behind vague language. If a normal week is light because of safety evidence, say that in `reason` and `safetyNotes`. Otherwise, normal build weeks should include visible medium/hard goal stimulus.

## Progression Temperament

The coach should be strict enough to change the training when the evidence supports it.

- `insufficient_history` means use smaller steps, not no steps.
- If the current month has at least 2 valid completed logs, pain stays below 4, how-you-felt feedback is Normal/Strong/Very strong, and perceived effort is not repeatedly 9-10, apply a small progression in the next plan.
- If recent completed sessions were logged as light/easy perceived effort with no pain and Normal/Strong/Very strong how-you-felt feedback, progress more clearly on the next plan: raise the main goal stimulus to at least medium/hard unless safety notes justify staying light.
- A small progression means changing one variable only: +1 rep on selected sets, +5-10 seconds on plank holds, +1 set on one exercise, slightly shorter rest, or a cleaner harder variation.
- Do not repeat the same numbers for a new week unless there is a clear reason in safety notes or progression rationale.

For normal states (`building`, `plateau`, `overreaching`, `insufficient_history`):

- Cover push, core, and pull when a pull-up bar is available.
- If no pull-up bar is available, do not prescribe pull-up-bar movements; keep push and core work while noting the equipment constraint in safety notes.
- For 3 sessions/week, include at least 1 mixed/full-body session.
- For 4 or more sessions/week, include at least 2 mixed/full-body sessions.
- A mixed/full-body session must train pull, push, and core when a pull-up bar is available; without a pull-up bar it must train push and core.
- Pull, push, or core emphasis days are allowed, but they must include support work from another movement pattern unless the plan is in recovery/deload.
- Space hard emphasis sessions across the week using `dayOffset`; avoid stacking hard pull and hard push on consecutive days if mixed or recovery work can separate them.

For `recovery_needed`:

- Prefer recovery, mobility, technique, and easy support work.
- No hard, very hard, max, or failure-intensity work.
- Keep the weekly session habit only when safe.

## Non-Negotiable Rules

- Never treat an unlogged exercise as zero performance.
- Never prescribe catch-up volume after a missed session.
- Never increase stress when recent pain or Very weak how-you-felt feedback requires deload.
- Never ignore profile or recent workout notes that mention pain, injury, form breakdown, or equipment limitations.
- Never prescribe pull-up-bar exercises when no pull-up bar is available.
- Never label a session `mixed` unless it actually combines the required movement patterns.
- Avoid max testing during recovery or deload states.
- Prefer repeatable progression over heroic one-week jumps.
- Do not keep a plan static solely because completed-month history is missing when current-week evidence is already clean.
- Keep app consistency scores separate from real-world benchmarks.

## Output

Return JSON only. No prose outside the JSON object.

The top-level object must include `summary`, `contextState`, `safetyFlags`, and `sessions`.

Each session must include `title`, `dayOffset`, `focus`, `plannedEffort`, `purpose`, `estimatedDurationMinutes`, `progressionRationale`, `safetyNotes`, `loggingFieldsRequired`, and `exercises`.

Each exercise must include `exercise`, `sets`, `reps`, `seconds`, `restSeconds`, `intensity`, and `plannedEffort`.
