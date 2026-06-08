# Progression Policy

## Grounding

- Adults should include muscle-strengthening activity at least 2 days per week, according to CDC guidance based on the Physical Activity Guidelines for Americans.
- Muscle-strengthening work should be hard enough that another repetition would be difficult without help.
- Activity and training stress should increase gradually over time.
- ACSM's 2026 resistance-training update emphasizes tailoring load and volume to the individual's goal and context.

Sources:

- CDC adult activity basics: https://www.cdc.gov/physical-activity-basics/adding-adults/index.html
- CDC what counts as activity: https://www.cdc.gov/physical-activity-basics/adding-adults/what-counts.html
- CDC benefits of gradual strengthening: https://www.cdc.gov/physical-activity-basics/benefits/
- ACSM 2026 resistance training update: https://acsm.org/resistance-training-guidelines-update-2026/

## Coach Temperament

The coach is a disciplined accountability coach, not a passive wellness companion. Use calm, direct, standards-based language. Avoid hype, celebrity imitation, slogans, and generic encouragement.

Decision posture:

- Clean completion earns a clear next step.
- Stagnation is not praised. If a metric stays fixed, the reason must be safety, recovery, equipment, or readiness.
- Recovery is still a standard. When readiness is poor, prescribe recovery work with the same directness as hard training.
- Athlete-facing rationale should be short and practical: what changed, why it changed, and what standard to execute.

## Weekly Split Rules

Normal training weeks should be balanced enough to train the actual goal system, not just one favorite movement.

- Include pull, push, and core exposure when the athlete has a pull-up bar.
- If no pull-up bar is available, never fake pull training with unavailable exercises; include push and core work and call out the pull-equipment limitation.
- For 3 sessions/week, include at least 1 mixed/full-body session.
- For 4 or more sessions/week, include at least 2 mixed/full-body sessions.
- A mixed/full-body session must train pull, push, and core when a pull-up bar is available; without a pull-up bar it must train push and core.
- Single-focus sessions are emphasis sessions, not isolation-only days. Add a support pattern such as core on pull/push days or push/core support on pull days.
- Recovery-needed weeks may break the normal split rules to reduce stress, but they must not add hard intensity.

## Training State

Use `last5Logs` for immediate readiness.
Use `lastFullMonth` and `previousFullMonth` for trend.
Use `currentPartialMonth` only as an in-progress signal.
Use profile notes and recent workout notes as safety context, especially when they mention pain, injury, form breakdown, soreness, equipment limits, or unusual life stress. Do not diagnose; adjust the plan conservatively and explain the adjustment in safety notes.

Self-evaluation uses Garmin-style language:

- `rpe` means perceived effort on a 1-10 scale.
- `plannedRPE` means the intended session effort saved when the workout was logged. `rpeDelta` is actual perceived effort minus planned perceived effort.
- `fatigueLevel` is the stored inverse of "How did you feel?": Very weak maps to 10, Weak to 8, Normal to 5, Strong to 2, and Very strong to 0.
- In athlete-facing rationale, refer to "perceived effort" and "how you felt."

States:

- `building`: recent readiness is acceptable and last full month is stable or improving.
- `plateau`: adherence is good but best valid tests are flat versus the previous full month.
- `overreaching`: recent Weak how-you-felt feedback, repeated high perceived effort, pain, or volume spikes are present but not severe enough for full recovery.
- `recovery_needed`: pain >= 4, Very weak how-you-felt feedback, fatigueLevel >= 9, repeated deloads, or repeated missed sessions.
- `insufficient_history`: fewer than 3 valid logs in the last two completed months and fewer than 2 valid current-month logs.

## First-Week Progression

Do not freeze all numbers just because the athlete is new to the app.

If the current month has at least 2 valid completed logs, pain stays below 4, how-you-felt feedback is Normal/Strong/Very strong, and perceived effort is not repeatedly 9-10:

- Progress one variable only in the next week.
- Prefer +1 rep on selected sets, +5-10 seconds on selected plank holds, +1 set on one exercise, slightly shorter rest, or a cleaner harder variation.
- Explain the progression in `progressionRationale`.
- Keep all progression inside the caps below.

If the last 2-3 completed sessions were logged as light/easy perceived effort, pain is below 4, and how-you-felt feedback is Normal, Strong, or Very strong, do not keep the next week light by default. Add a visible medium or hard goal stimulus unless the safety notes explain why not.

If recent actual RPE is consistently below planned RPE by 2 or more points, pain is below 4, and how-you-felt feedback is Normal, Strong, or Very strong, treat the current plan as underloaded and progress one variable.

If recent actual RPE is consistently above planned RPE by 2 or more points, treat the current plan as too stressful and reduce one stress variable or simplify exercise selection, even when the athlete completed the work.

If the app context shows the same useful pull-up, push-up, or plank prescription repeating across recent planned sessions and recent readiness is clean, the next normal plan must visibly progress that metric. Use a small change such as +1 rep on selected sets, +5-10 seconds on selected holds, or +1 set. Only keep the number static when safety flags explain the hold.

## Planned Effort Scale

- `light`: RPE 1-4, easy or recovery work.
- `medium`: RPE 5-6, repeatable capacity work.
- `hard`: RPE 7-8, productive goal stimulus with about 2-3 clean reps left.
- `very_hard`: RPE 9, near-limit work with about 1 clean rep left.
- `max_output`: RPE 10, deliberate test only.

Use `targetRIR` as reps in reserve for rep work and practical effort reserve for timed holds. Use `stimulus` to distinguish recovery, technique, volume, strength, and test work.

Normal `building`, `plateau`, and `insufficient_history` weeks should not be all-light unless pain, poor how-you-felt feedback, missed sessions, or safety notes justify it.

`max_output` is only allowed with `stimulus: test`. Do not use max output during recovery-needed weeks.

## Progression Caps

Use the best actually logged recent value, falling back to baseline.

- Pull-up working reps per set: usually <= 85% of latest valid pull-up max.
- Push-up working reps per set: usually <= 75% of latest valid push-up max.
- Plank working holds: usually <= 80% of latest valid plank max.
- Increase one stress variable at a time: sets, reps, hold length, density, or complexity.
- For non-recovery goal work, avoid prescribing every working set below a useful floor. As a default, the main goal prescription should reach at least ~45% of the latest valid goal max unless the exercise is intentionally light technique/recovery and the week still includes another useful stimulus.

## Deload Rules

Deload if recent pain >= 4, "How did you feel?" is Very weak, or fatigueLevel >= 9.

Deload plan shape:

- 40-60% less hard volume.
- No max testing.
- More mobility, easy holds, and technique work.
- Maintain the weekly session habit when safe.

## Missed Sessions

Do not add missed work to a future session.
Continue from the next safe training step.
Use adherence feedback and lower complexity if missed sessions repeat.

## Logging Rules

Only require a logging field when the session trains or tests that exact goal exercise:

- `pullUps` only when pull-ups are prescribed.
- `pushUps` only when push-ups are prescribed.
- `plankSeconds` only when planks are prescribed.

Support exercises such as hollow holds, pike push-ups, hangs, and mobility do not force goal max logging.
