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
- Selected training days and their allowed `dayOffset` values when provided by the app.
- Raw performance logs, including which exercises were actually logged and the athlete's workout notes.
- Planned or completed sessions when available.

## Context Requirements

Before planning, run `scripts/build-coach-context.ts` and use its output. The context must include:

- `last5Logs`: immediate readiness and fatigue signal.
- `currentPartialMonth`: current calendar month to date, labeled partial.
- `lastFullMonth`: most recent completed calendar month.
- `previousFullMonth`: completed calendar month before `lastFullMonth`.
- `twoFullMonthTrend`: comparison of last full month vs previous full month.
- `bestRecentTests`: best valid pull-up, push-up, and plank values from actually logged tests.
- `adherence`: planned/completed/missed/deload counts when planned sessions are available.
- `riskFlags`: pain, fatigue, missed-session, sudden-volume, or insufficient-history warnings.
- `weekStart`: the Monday/Sunday app-provided start date for scheduling this plan.
- `profileNotes` and recent log `notes`: human context for limitations, form issues, soreness, or unusual circumstances.

Do not ask the model to infer these summaries from raw logs.

## References

- Use `references/progression-policy.md` for progression and deload rules.
- Use `references/exercise-library.json` for available exercise variants and equipment constraints.
- Use `references/real-world-standards.md` when comparing app goals or ranks to external standards.
- Use `references/weekly-plan.schema.json` as the output contract.

## Planning Workflow

1. Read the built coach context.
2. Classify the state as one of: `building`, `plateau`, `overreaching`, `recovery_needed`, or `insufficient_history`.
3. Generate exactly the requested number of sessions.
4. Assign each session a `dayOffset` from the provided future-only allowed `dayOffset` values when present; otherwise use `1` through `6`, in strictly increasing order, relative to `weekStart`. `dayOffset: 0` is today and is locked.
   If selected training days or allowed `dayOffset` values are provided, use only those future offsets and treat all other offsets as rest days.
5. Derive session length from prescribed work; do not use a fixed minutes-per-session input.
6. Include a short purpose for every session.
7. Mark logging fields only for goal exercises actually trained or tested in the session.
8. Return only JSON matching `weekly-plan.schema.json`.
9. Run `scripts/validate-week-plan.ts` for technical output checks.
10. If technical validation fails, repair once. If validation still fails, return an error to the app instead of accepting malformed output.

## Weekly Structure Policy

The app-visible workout calendar is generated from this skill output, so do not rely on hidden app defaults for the weekly split.

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
- No hard, max, or failure-intensity work.
- Keep the weekly session habit only when safe.

## Non-Negotiable Rules

- Never treat an unlogged exercise as zero performance.
- Never prescribe catch-up volume after a missed session.
- Never increase stress when recent pain or fatigue requires deload.
- Never ignore profile or recent workout notes that mention pain, injury, form breakdown, or equipment limitations.
- Never prescribe pull-up-bar exercises when no pull-up bar is available.
- Never label a session `mixed` unless it actually combines the required movement patterns.
- Never create, replace, or repair a session for `dayOffset: 0`. Today may already be logged, finished, or intentionally left as a rest day, so refreshes only plan future days.
- Avoid max testing during recovery or deload states.
- Prefer repeatable progression over heroic one-week jumps.
- Keep app consistency scores separate from real-world benchmarks.

## Output

Return JSON only. No prose outside the JSON object.

The top-level object must include `summary`, `contextState`, `safetyFlags`, and `sessions`.

Each session must include `title`, `dayOffset`, `focus`, `purpose`, `estimatedDurationMinutes`, `progressionRationale`, `safetyNotes`, `loggingFieldsRequired`, and `exercises`.
