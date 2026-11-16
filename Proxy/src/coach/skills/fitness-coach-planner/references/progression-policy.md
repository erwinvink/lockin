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
- ACSM 2026 position stand: https://pubmed.ncbi.nlm.nih.gov/41843416/
- ACSM progression models position stand: https://pubmed.ncbi.nlm.nih.gov/19204579/
- Autoregulation review: https://pubmed.ncbi.nlm.nih.gov/33520457/
- Deload consensus study: https://pubmed.ncbi.nlm.nih.gov/37730925/

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
- A normal week plans at least 3 strength sessions when 3 training days are free (enforced as `minSessionsThisWeek`; a heavy running week, hard runs and the weeks after a race never lower it), and never more than fit around the runs with one full rest day (`maxSessionsThisWeek`; with 0, no session, and earned progression carries over). Fewer only when fewer days are free, or in a planned recovery week, the race taper, an overreaching week or a computed recovery need (a logged session with pain 4 or more puts readiness there); a note in the profile never lowers it. Training days are not a quota above that minimum.
- In a normal week each goal exercise (pull-ups only with a pull-up bar) appears as useful work (medium effort or harder, at the useful floor of 45% of the current best or more) or a test in at least 2 sessions, or in every session when fewer are planned (enforced, `goalExposures`). Light, technique and recovery work, and work below the useful floor do not count. Above 40 push-ups that is one high-rep or density day and one submaximal volume day, with harder variants on a third day; above 120 s two plank holds a week; above 12 pull-ups two pull-up volume days, with weighted or archer work on top.

## Delivered Work Against The Plan

A coach judges a session by the work the athlete actually delivered, not only by the plan. Every logged goal result is compared with the target its own session planned (any effort label, tests excluded):

- More than planned: at least 2 reps (5 seconds on a plank) and at least 10% above the planned target. The athlete chose to do more. A higher effort rating on that session is explained by the extra work: it is clean, it earns progression, and it never counts toward overreaching. It also shows the plan undershot the athlete: the next week plans from the level shown.
- As planned but rated 2 or more RPE points above plan, or RPE 9+ on work planned below very_hard: the plan was harder than intended. That is a warning sign, handled by the readiness ladder below. Planned near-max work (very_hard, or a test at max_output) rated as planned is the plan, never a warning sign.
- Less than planned (below the target): the athlete fell short. That, pain 4 or more, and very weak feedback are the real warning signs.
- Lower logged numbers that simply meet a lighter planned week (taper, recovery week, after a race) are not a decline. Logged numbers in working sessions follow the plan; a decline needs at least 2 results below their plan in the last 3 weeks.

Say it plainly in the plan text: "You did 38 when 10 was asked, so this week's sets start at 20." Never call extra work too hard, and never plan less because the athlete did more.

## Training State

Use `last5Logs` for immediate readiness.
Use `history.rollingTrend` (best of the last 21 days against the 21 days before, logs since the plan block start) for plateau and decline.
Use `lastFullMonth`, `previousFullMonth`, and `currentPartialMonth` as background context only.
Use profile notes and recent workout notes as safety context, especially when they mention pain, injury, form breakdown, soreness, equipment limits, or unusual life stress. The profile note shapes exercise choice and effort within the limits; it never lowers the session minimum or the goal sets. Logged pain is what lowers the plan: a logged session with pain 4 or more puts readiness in recovery needed. Do not diagnose; adjust conservatively within the limits and explain the adjustment in safety notes.

Self-evaluation uses Garmin-style language:

- `rpe` means perceived effort on a 1-10 scale.
- `plannedRPE` means the intended session effort saved when the workout was logged. `rpeDelta` is actual perceived effort minus planned perceived effort.
- `fatigueLevel` is the stored inverse of "How did you feel?": Very weak maps to 10, Weak to 8, Normal to 5, Strong to 2, and Very strong to 0.
- In athlete-facing rationale, refer to "perceived effort" and "how you felt."

States:

- `building`: recent readiness is acceptable and the rolling trend is stable or improving. A calibration (below) keeps readiness `building`.
- `plateau`: adherence is good but the best logged values of the last 3 weeks equal those of the 3 weeks before (each window needs at least two logs of a metric).
- `overreaching`: an effort flag plus a second marker within 14 days, or a rolling decline with at least 2 results below plan in the last 3 weeks (lower numbers that only follow a lighter planned week, or one off day, do not count). See the readiness ladder. A monthly volume increase without negative effort, fatigue, pain, or performance evidence remains `building`; it is only a watch item.
- `recovery_needed`: pain >= 4 or Very weak how-you-felt feedback (fatigueLevel >= 9) in the last 7 days (14 days while no session was logged after it). A later clean session clears it early: pain 2 or lower clears a pain flag, Normal or better feedback with pain below 4 clears a very-weak flag. A pain flag from last month alone is a watch item, not `recovery_needed`.
- `insufficient_history`: fewer than 3 valid logs in the last two completed months and fewer than 2 valid current-month logs.

## Adaptive Phase And Progression

Choose the phase from current evidence, not from a rigid four-week calendar:

- `Build`: clean readiness and earned progression.
- `Offload`: computed overreaching (hold or one step back for 3-7 days, about 30-50% fewer hard sets) or a computed recovery need. A planned recovery week (every fourth plan-block week, `coachContext.periodization.recoveryWeekDue`) is also an `Offload` week: at most 60% of the last loading week's hard sets (40-60% less hard volume), one hard session, at most 3 sets per goal exercise, no progression, and no tests except a due test on its last 2 days (outside the hard-set cap and the hard-session limit).
- `Restore`: the first controlled step back after an offload.
- `Assessment`: a week built around goal tests. A test of a goal exercise is due (enforced, `strengthGuardrails.assessment`) 42 days after its last test or the plan block's baseline, or 28 days when its progression is blocked at the working cap and the set limit or session budget (`blocked`) or readiness is plateau. It applies in a normal-readiness week. Tests pause in the taper phase of the season (the last 21 days before the race), judged per planned day: a week that starts before the taper takes no test on its days inside it; the strength taper of the last 10 days is a separate rule (strength light, no tests). No test sits on post-race days 1-7, judged per planned day (a week that starts on post-race day 7 can test from day 8). A recovery week takes it on its last 2 days only. A due test is one max set (stimulus test, max_output, 1 set) on one of `assessment.testDayOffsets`: not a hard-run day, the day before a long run or the race, or the week's only free day; when no day fits, it waits a week. Due tests may share one session, and a test counts as a hard session. With nothing due, a test is optional and needs at least 28 days since the latest test (enforced).
- Test protocol (stated in the session in plain words): test at the start of the session after a warm-up, on fresh legs (no hard training the day before); one all-out set of each tested exercise in strict form (its `formStandard` in `exercise-library.json`), 3-5 minutes rest between exercises; write down the number. The listed test days are fresh ones (not after a hard run, a long run or hard strength) when the week has one; otherwise the reason says the test follows hard work. A missed test is no test: it stays due.

Prefix the plan `summary` with the phase. The summary must explain the pull-up, push-up, and plank decision separately.

Use `plannedWork.recentGoalPerformance` as the main progression evidence; `strengthGuardrails.progression` turns it into the allowed range for each metric. `clean` already means pain below 4, fatigue below 9, and actual RPE no more than 1 point above planned RPE, or a result clearly more than planned (the extra work explains the higher effort). When a log has no planned RPE (manual or older logs), the planned effort label's RPE is used, else 7.

- Earned progression: a clean logged best at least 2 above the target (plank: 2 seconds) earns it immediately; otherwise the second consecutive clean completion at or above the same standard earns it. After the first clean exposure at the standard, hold.
- A result clearly more than planned is clean even when it was rated harder than planned, including on light or technique work. It re-bases the next target on the level shown: `allowedTopTarget` runs from the useful floor (or the earned step, if higher) up to the working cap. A previous prescription below the useful floor restarts at that floor, so one easy or tapered week never leaves the athlete stuck at uselessly low numbers.
- Earned step sizes, scaled to the metric and level: pull-ups +1 rep; push-ups +1 rep below 15, +1-2 below 30, +1-3 from 30; plank +5-10 seconds below 60 s, +5-15 seconds from 60 s.
- Instead of the rep or hold step, one more set at the same target also counts as the progression (`setRoute`). When the working cap blocks the rep step, the extra set is the progression. When 6 sets or the session budget block that too, the metric holds (`blocked`) and a test is due 28 days after the last one.
- Never increase sets and repetitions or hold time together.
- If clean evidence earned progression, progression is mandatory unless a computed recovery state, a planned recovery week or the race taper applies. Running load never holds upper-body progression. Safety text alone cannot override the evidence.
- Without earned progression, keep the top working target within one step below the previous working target and no higher than it (`allowedTopTarget`); sets may rise by at most one per week (none in a calibration hold). This is how underloaded weeks progress: add one set, not reps.

Do not freeze all numbers just because the athlete is new to the app: with no previous prescription (`status: free`), start inside the working cap and above the useful floor.

If the last 2-3 completed sessions were logged as light/easy perceived effort, pain is below 4, and how-you-felt feedback is Normal, Strong, or Very strong, do not keep the next week light by default. Add a visible medium or hard goal stimulus unless the safety notes explain why not.

If recent actual RPE is consistently below planned RPE by 2 or more points, pain is below 4, and how-you-felt feedback is Normal, Strong, or Very strong, treat the current plan as underloaded: add one set within the bounds; rep or hold increases still need earned progression.

Effort above plan on work done as planned follows the readiness ladder below: calibrate the exercises it touched first; reduce globally only with a second marker. When the athlete did clearly more than planned, the higher effort comes from the extra work: that is not a reason to reduce. Plan from the level shown.

Prescription history is supporting context, not proof of adaptation. Match logged results to their prescriptions before deciding that progression was earned.

## Planned Effort Scale

- `light`: RPE 1-4, easy or recovery work.
- `medium`: RPE 5-6, repeatable capacity work.
- `hard`: RPE 7-8, productive goal stimulus with about 2-3 clean reps left.
- `very_hard`: RPE 9, near-limit work with about 1 clean rep left.
- `max_output`: RPE 10, deliberate test only.

Use `targetRIR` as reps in reserve for rep work and practical effort reserve for timed holds. Use `stimulus` to distinguish recovery, technique, volume, strength, and test work.

Normal `building`, `plateau`, and `insufficient_history` weeks are never all-light (enforced), the weeks after a race included: keep at least one session at medium effort or harder. Only a computed recovery need (pain, very weak feedback), an overreaching week (its top goal blocks still hold the hold-or-step-back band), a planned recovery week, or the race taper allows an all-light week. A safety string alone is not evidence.

`max_output` is only allowed with `stimulus: test`. Do not use max output during recovery-needed weeks.

## Progression Caps

Use the current level (`history.bestRecentTests`): the baseline set at the plan block start plus logs since then (all recent logs when no block start is known). After "Start a new plan" with a lower retest, older higher bests appear only in `history.bestBeforeBlock` as context; never plan from them. The baseline set at the block start also counts as a fresh test for the 28-day test spacing. These caps are enforced (`strengthGuardrails.workingCaps`); only `stimulus: test` may exceed them.

- Pull-up working reps per set: at most 85% of the best recent pull-up value (at least 1).
- Push-up working reps per set: at most 75% of the best recent push-up value.
- Plank working holds: at most 80% of the best recent plank value (at least 10 seconds).
- Goal work uses 3-6 sets per exercise in a normal week, 2-3 in a planned recovery week or the race taper (their phase maximum), and 2-6 in an overreaching week (one set fewer than before per block, at most 3 without a recent prescription) or a computed recovery need (`goalSetsPerExercise`). A previous prescription with fewer sets (an older plan) continues at that minimum, and an Assessment's single max set is never the working standard the next week continues from.
- Session budget (`strengthGuardrails.sessionBudget`): a goal exercise's useful working sets x reps (seconds for the plank) in one session stay at or below 3.0x the best for pull-ups and 3.5x for push-ups and the plank; a test and light work are not counted. Over it, a second block of the exercise in that session gives way first (fewer sets, or light technique work when it would drop below the week's minimum sets), so the main block and its earned progression stay; then the main block's sets are lowered, never below the minimum. The set route stops at the budget.
- At most 2 hard strength sessions a week alongside a running week (3 without), never on more than two consecutive days.
- Increase one stress variable at a time: sets, reps, hold length, density, or complexity.
- For non-recovery goal work, never prescribe every working set below a useful floor. In a normal week the main goal prescription reaches at least the useful floor, 45% of the current best rounded up, from a best of 2 reps (the plank from 10 s) (enforced; the hold and earned bands are raised to it) unless the exercise is intentionally light technique/recovery and the week still includes another useful stimulus. In a normal week a session whose goal work of an exercise is all below the useful floor at medium effort or harder has its top block raised to the floor when another session reaches it (the proxy does it, listed in adjustments): plan easier work as light or technique, and a lighter finisher behind a block at the floor stays.

## Readiness Ladder

Readiness is computed in code and judged against the plan: sessions that tested a goal exercise, work planned very_hard and rated as planned, and sessions with clearly more than planned never count as excess effort. Each step changes only what it names:

1. calibrate: 2 of the last 5 sessions done as planned were rated 2 or more RPE above plan, with no second marker. Readiness stays normal. The goal exercises those sessions trained hold (`coachContext.readiness.calibration`): no progression, no extra set, nothing below the hold band; the other exercises follow their own progression. Delivered work ends the hold: as soon as a later session of that exercise is clearly more than planned (light or technique work included), or its working sets are done as planned (RPE at most 1 above plan), it progresses again; light technique work merely done as planned does not end it.
2. overreaching: an effort flag (2 of the last 5 sessions rated 2 or more above plan, or 3 of the last 5 at RPE 9+ on work planned below very_hard) plus a second marker within 14 days: a result below a working target the athlete completed cleanly before (a test's max set is not a working completion), the flag persisting (3 of the last 5), or 2 of the last 5 sessions rated Weak or Very weak. A rolling decline with at least 2 results below plan also counts. Response for the next 3-7 days (enforced, `strengthGuardrails.overreaching`): the top block of each goal exercise (its highest target in the week), whatever its effort label, holds or steps back one step from the previous working target; no block goes above it, lighter technique or support blocks may sit below it, and each block keeps one set fewer (never below 2); a goal exercise without a recent prescription keeps at most 3 sets inside the cap; about 30-50% fewer hard sets, at most 70% of the last loading week's, or at most 1 hard session when there is no loading week to compare; no tests (a test becomes working sets). An all-light week, or no session, is allowed (`Offload:`).
3. recovery_needed: pain >= 4 or Very weak feedback (fatigueLevel >= 9) in the last 7 days (14 while no session followed). No hard work and no tests; plan what is safe within the caps, with more mobility, easy holds and technique work, and keep the weekly session habit when safe.

A monthly volume flag alone is not an offload trigger.

## Missed Sessions

Do not add missed work to a future session.
Continue from the next safe training step.
Never suppress progression or add catch-up work for an old or isolated miss. Lower complexity or frequency only when misses repeat in the most recent 14 days: the session minimum drops by one, and a held target may drop further than one step, down to the useful floor (45% of the current best), never below it.

## Running Priority And Rest

- Fixed running sessions lead the combined plan.
- Never put hard strength on a long, tempo, interval, hill, or race-run day, and never very_hard or max_output strength (tests included) on the day before a long run or the race.
- In the last 10 days before the race strength stays light: no tests, no very_hard or max_output, at most one hard session, at most 3 sets per goal exercise, no progression required. Nothing hard within 4 days of the race.
- Leave at least one of future offsets 1 through 6 unused by both running and strength.
- After a race, judged per planned day (post-race day 1 is the day after the race): nothing hard on post-race days 1-2 (light or medium only); at most hard on days 3-7 (no very_hard or max_output, so no tests); from day 8 normal effort. Only the effort is capped: earned progression, the session minimum, goal sets and exposures still apply.
- Running load never holds upper-body progression: a heavy running week, 3 or more hard runs, the weeks before the 10-day strength taper and the weeks after a race are normal strength weeks. Running leads only in the scheduling rules above.

## Logging Rules

Only require a logging field when the session trains or tests that exact goal exercise:

- `pullUps` only when pull-ups are prescribed.
- `pushUps` only when push-ups are prescribed.
- `plankSeconds` only when planks are prescribed.

Support exercises such as hollow holds, pike push-ups, hangs, and mobility do not force goal max logging.
