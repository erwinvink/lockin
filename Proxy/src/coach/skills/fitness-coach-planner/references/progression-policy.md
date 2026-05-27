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

States:

- `building`: recent readiness is acceptable and last full month is stable or improving.
- `plateau`: adherence is good but best valid tests are flat versus the previous full month.
- `overreaching`: recent fatigue, pain, or volume spikes are present but not severe enough for full recovery.
- `recovery_needed`: pain >= 4, fatigue >= 9, repeated deloads, or repeated missed sessions.
- `insufficient_history`: fewer than 3 valid logs in the last two completed months.

## Progression Caps

Use the best actually logged recent value, falling back to baseline.

- Pull-up working reps per set: usually <= 85% of latest valid pull-up max.
- Push-up working reps per set: usually <= 75% of latest valid push-up max.
- Plank working holds: usually <= 80% of latest valid plank max.
- Increase one stress variable at a time: sets, reps, hold length, density, or complexity.

## Deload Rules

Deload if recent pain >= 4 or fatigue >= 9.

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
