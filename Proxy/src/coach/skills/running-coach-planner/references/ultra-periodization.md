# Ultra Periodization

## Phases by Weeks to Race

Use `weeksToRace` to pick the phase. Boundaries are guides, not hard cutoffs.

- Base (more than ~12 weeks out): grow general aerobic volume with easy running. The long run grows gradually. Hills and strides are accents, not workouts.
- Build (~12 to ~6 weeks out): progress weekly volume, long-run distance, and elevation toward race demand. At most one quality session per week.
- Peak (~6 to ~3 weeks out): biggest long runs and biggest elevation weeks of the cycle. Keep intensity controlled; specificity beats speed.
- Taper (final 1-3 weeks): see the Taper section. Begin no later than 21 days out; 8-14 days is the evidence optimum.
- Recovery weeks: every fourth block week (3:1), see Planned Recovery Weeks.

## Taper

Verified prescription (Wang 2023 meta-analysis of 14 RCTs; outcomes are sub-ultra time trials, so treat exact percentages as the best available extrapolation for 50-100K):

- Taper for 8-14 days when the block has gone well; never longer than 21 days.
- Cut volume progressively (the meta-analysis optimum is a 41-60% total reduction) while holding intensity: shorten sessions rather than slowing them all down, keep the athlete's established run frequency where the caps allow, and never inflate frequency to every available day.

Enforced by the proxy (`outputRules.guardrails.raceWindow`). Each day of the rolling week has its own phase, so one week can straddle two phases; percentages are of the pre-taper 4-week average (the four weeks before 21 days out):

- 15-21 days out: weekly km at most 80%; the long run at most 75% of the recent longest run.
- 8-14 days out: weekly km 50-70% (capped at 70%); the long run at most 60% of the recent longest run; keep one short quality session (tempo or intervals), the last one at least 8 days out.
- Race week (1-7 days out): besides the race, only short easy runs or shakeouts, each at most 40% of a normal easy run and at most 8 km; strides inside an easy run keep the legs sharp. No tempo, intervals, hills, or long runs. In an ultra the race itself carries the week's load, so the runs around it are shorter than the "half of normal volume" seen in shorter-race studies.
- Inside 10 days: no hill session and no new hill or downhill load (climbing at most 1.5x the athlete's usual m/km, never capped below 150 m).
- After the race: easy or recovery runs only in the first week (weekly km at most 40%), and at most 70% in the second week.
- From 21 days out, one quality session per week at most.

## Long-Run Progression

Established coaching practice, not verified science — treat these caps as protective heuristics:

- Increase the long run by no more than 10-15% per week.
- Never schedule a long run above 1.4x the recent longest run (`guardrails.longRun.capKm`; enforced, a safety flag does not waive it). If race demand seems to require a bigger jump, hold the cap and explain the gap in the summary.
- Reduce the long run in recovery weeks (at most 70% of the recent longest) and during the taper (75% at 15-21 days out, 60% at 8-14 days out, none in race week except the race).

## Planned Recovery Weeks

- Rhythm 3:1: after three loading weeks in a row, counted from the plan block start or the last unloading week, the next block week is a planned recovery week (`coachContext.periodization.recoveryWeekDue` with `recoveryWeekReason`, limits in `outputRules.guardrails.recoveryWeek`). Ultra coaches commonly use 3:1, or 2:1 for older or heavier athletes.
- A reactive offload (pain, very weak feedback, repeated very hard sessions, a deloaded session), a low-volume week, the taper, or the race resets the count; the taper replaces a recovery week that would fall inside 21 days of the race.
- Running in a recovery week: weekly km 60-75% of the recent 4-week average (capped at 75%), the long run at most 70% of the recent longest run, the usual run frequency, and intensity kept but reduced: one short quality session at most (or strides inside an easy run).
- Strength backs off in the same week; both disciplines recover together.
- Say in the summary that this is a planned recovery week and why.

## Elevation Progression

- Use the race's elevation/distance ratio (total gain in meters divided by distance in km) as the demand target.
- Aim weekly elevation gain toward (race elevation/distance ratio) × weekly km across build and peak; concentrate gain in long runs and hill sessions.
- A large elevation jump counts as an intensity increase under the one-variable rule.

## Build-Week Shape

A standard build week for an athlete with an established base: the long run, one or two quality sessions (tempo, intervals, or hills), and easy or recovery runs on the remaining days. Weekly volume follows the athlete's demonstrated baseline and builds toward race demand — an experienced athlete's plan should look like experienced training. Safety comes from the progression caps and readiness gates, not from a beginner template.

## Intensity Split

- Keep roughly 80% of weekly running time easy (Zone 2, conversational) and at most 20% hard (tempo, intervals, hard hills).
- Easy days stay easy. Recovery runs carry no quality content. Use `guardrails.easyReference` (the athlete's own recent easy runs) as the easy pace and heart-rate band.
- `trainingSignals.running.lowIntensityTimeShareLast4Weeks` is the 80/20 split by time: the share of the last 4 weeks' running time spent in easy, recovery, and long runs (long runs are low intensity). A normal build week of a long run, one quality session, and two easy runs reads about 0.8. Only a value well below 0.75 (too much hard running) is a reason to favor easy running.

## Back-to-Back Long Runs

Established coaching practice, not verified science. Schedule back-to-back long runs only when all three hold:

- the phase is build or peak
- the race is 80 km or longer
- recent volume supports it: the combined two-day distance fits inside normal weekly progression (the weekly cap)

Otherwise use a single long run. Outside this case, never put two hard runs (long, tempo, intervals, hills) on consecutive days.

## Downhill Conditioning

Descent durability is the limiter in trail ultras, and the protection is trainable: a single hard downhill bout measurably reduces muscle damage, soreness, and strength loss in the next hard downhill for up to ~3 weeks (the repeated-bout effect — verified in trail runners; Khassetarash 2023 and corroborating studies).

- In build and peak, include sustained downhill running inside hill sessions and long runs. Use the race's descent demand and the athlete's recent elevation loss (recentRuns carry `elevationLossM`) to judge how much descent the legs are already absorbing.
- Schedule the last hard downhill-loaded run 2-3 weeks before the race so the protective effect covers race day; never add new downhill load inside the final 10 days.
- Downhill load is eccentric damage by design: introduce it gradually and count a large descent jump as an intensity increase under the one-variable rule.

## Readiness Gates

Evidence basis: gating hard sessions on recovery state does not beat a fixed plan on average — its demonstrated value is fewer non-responders and equal adaptation from fewer hard sessions (Vesterinen 2016 RCT; Duking 2021 meta-analysis). The validated rule gates on the athlete's own HRV baseline; Garmin's HRV status is baseline-relative, so it is the primary gate here.

- Primary gate: HRV status "unbalanced" or "low" (case-insensitive; devices report values like UNBALANCED).
- Secondary gate: sleep score below 50.
- Weak gates (heuristic only): training readiness below 30 and body battery below 25. Body battery is a proprietary, unvalidated composite — never let it be the sole reason to change a session; use it as a tie-breaker alongside a primary or secondary gate.
- When a gate trips: move the planned quality session to a later clean day in the same week when one exists; downgrade it to easy only when no clean day remains. Either way, add a safety flag naming the signal. Fewer, better-timed hard sessions achieve the same adaptation.
- Evaluate gates on the most recent wellness day only. Treat 0 or missing values as no data, never as a tripped gate.

## One Variable at a Time

- Never increase both volume and intensity in the same week.
- Progress the variable that serves the current phase: volume in base and build, specificity in peak, freshness in taper.
