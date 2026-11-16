# Ultra Periodization

## Phases

Use `coachContext.season.phase` (computed as of today, the first day of the rolling week) to pick the phase; a change later in the week, such as the taper starting, shows day by day in the race window (see the Taper section). `weeksToRace` reads 0 on race day and for any past race, so it never picks the phase. `coachContext.season.reason` says in one sentence where the athlete stands.

| Phase (`season.phase`) | When (computed from the race date and the week start) |
|---|---|
| `general_preparation` | No race ahead: no race goal, the last race's post-race window is over, or the race is more than 112 days (16 weeks) away |
| `base` | 85-112 days (13-16 weeks) to the race |
| `build` | 43-84 days (7-12 weeks) to the race |
| `peak` | 22-42 days (4-6 weeks) to the race |
| `taper` | The final 21 days, race day included |
| `transition` | Day 1 to day `season.postRaceDays` after the race: one day per 4 race km, at least 7 and at most 28 days (54 km: 14 days; 100 km: 25) |

What each phase holds. Quality sessions are `tempo`, `intervals` and `hills` runs; the long run is never one. An athlete whose recent runs show real volume trains like an experienced athlete: safety comes from the caps and gates, not from a beginner template.

- `transition`: the first week after the race holds easy or recovery runs only. From day 8 to the end of the window: easy runs, with strides in two of them (4-6 × 20 s relaxed-fast with full recovery), and an easy, short long run; no tempo, interval or hill session until the window ends (enforced). The weekly km limits are in the Taper section.
- `general_preparation`: one structured speed session a week, either VO2max or hill intervals (2-4 min reps, 12-24 min in total at intensity) or threshold (3 × 8-12 min, building toward 2 × 20 min); strides in two easy runs; weekly volume rising toward a sustainable ceiling (Progression); the long run growing toward 2.5-3 h; one descent-loaded run every 2-4 weeks; 3:1 recovery weeks. No taper or post-race limits apply; the normal weekly and long-run caps do.
- `base`: as general preparation, with a gradually longer long run.
- `build`: one quality session in a 3-4-run week, one or two in a 5-run week (the hard-run cap counts the long run), one of them race-specific: long climbs and sustained descents. The long run moves toward race demand.
- `peak`: race specificity: the biggest long runs and elevation weeks of the cycle and one quality session, race-specific (sustained climbs at race effort).
- `taper`: the final 21 days, race day included (computed); the per-day limits are in the Taper section.
- Recovery weeks: every fourth block week (3:1), see Planned Recovery Weeks.

## Running Floors

Enforced by the proxy in `general_preparation`, `base`, `build` and `peak` for weeks of 3 or more runs (`outputRules.guardrails.floors`; each floor carries its reason). The floors are weekly while the plan covers the coming six days, so they count over 7 days: today's run (locked, done or still planned; `floors.todayRun`) plus the planned runs. The weekly cap counts the same 7 days, so today's run uses part of it, and the floor never exceeds the cap.

- At least one tempo, interval or hill run (`floors.qualityRun`); the long run does not count, and a quality run or a race today already counts (a race, a tune-up race included, is the quality stimulus of its week). After a hard run today, the next day is no hard run.
- Weekly km (race-day session excluded) at least `floors.weeklyKm.minKm`, the weekly-km floor defined in SKILL.md (Hard Rules); `floors.weeklyKm.reason` gives this week's numbers. Holding last week's volume always meets it; the floor never asks for a jump. In the first 3 weeks after the post-race transition it reads the average training week of the four weeks before the taper instead of the last four weeks (which still carry the taper and the race), so it holds last week's training km rather than letting the week shrink. It never asks for every run at its cap: at most 90% of what today's run and the week's runs hold at the long-run cap, rounded down to the half kilometre.
- Lifted in the taper and the transition, by a computed relaxation, for a starter base or the first week back after 4+ weeks without runs; the quality floor also when no running day away from the long run is free (outside a wellness gate's next 48 hours and the day after a hard run today), and the weekly-km floor when the race window reaches into the week or the free days cannot hold it under the long-run cap. A tripped wellness gate lifts no floor (Readiness Gates), and neither does a safety flag or the athlete's profile note: the note shapes which runs fill the floors (less climbing, gentler descents, a flat tempo instead of hills), and logged pain is what lowers the plan (a logged session with pain 4 or more puts readiness in recovery needed).
- When the current plan, kept within 15%, cannot reach a floor, or would stay above this week's weekly or long-run cap, the plan may change (a continuity change signal).
- `trainingSignals.running.noSpeedStimulusLast3Weeks` is true when at least 95% of the last 3 weeks' running time (races left out) was easy, recovery or long running in these phases: no speed stimulus in 3 weeks, so plan the week's structured speed session.

## Progression

- In a given week progress one variable: weekly volume (+5-10%, inside `weeklyVolume.capKm`) or time at intensity (+2-4 min; VO2max and hill intervals add 2-3 min every 1-2 weeks, up to 24 min in total). Never raise volume and intensity in the same week.
- The phase decides which: general preparation and base alternate volume and time at intensity; build progresses volume, the long run and race-specific elevation; peak progresses specificity; the taper keeps intensity and cuts volume.
- A large elevation or descent jump counts as an intensity increase.

## Taper

Verified prescription (Wang 2023 meta-analysis of 14 RCTs; outcomes are sub-ultra time trials, so treat exact percentages as the best available extrapolation for 50-100K):

- Taper for 8-14 days when the block has gone well; never longer than 21 days.
- Cut volume progressively (the meta-analysis optimum is a 41-60% total reduction) while holding intensity: shorten sessions rather than slowing them all down, keep the athlete's established run frequency where the caps allow, and never inflate frequency to every available day.

Enforced by the proxy (`outputRules.guardrails.raceWindow`). Each day of the rolling week has its own phase, so one week can straddle two phases; percentages are of the pre-taper 4-week average (the four weeks before 21 days out):

- 15-21 days out: weekly km at most 80%; the long run at most 75% of the recent longest run.
- 8-14 days out: weekly km 50-70% (capped at 70%); the long run at most 60% of the recent longest run; keep one short quality session (tempo or intervals), the last one at least 8 days out.
- Race week (1-7 days out): besides the race, only short easy runs or shakeouts, each at most 50% of a normal easy run and at most 8 km; strides inside an easy run keep the legs sharp. No tempo, intervals, hills, or long runs. This matches the "about half of normal volume" seen in taper studies; the week's total stays low because every run besides the race is short and easy.
- Inside 10 days: no hill session and no new hill or downhill load (climbing at most 1.5x the athlete's usual m/km, never capped below 150 m).
- After the race (`transition`; Phases says which runs it holds): the first week caps volume (weekly km at most 40%), and at most 70% from day 8 to the end of the post-race window (`season.postRaceDays`; `guardrails.raceWindow.postRaceDays`).
- From 21 days out, one quality session per week at most.

## Long-Run Progression

- No run except the race itself goes above 1.15x the longest training run of the last 30 days (`guardrails.longRun.capKm`; enforced, a safety flag does not waive it). A run more than 10-30% longer than the longest run of the previous 30 days raised overuse injuries among 5,205 Garmin runners (Frandsen 2025, observational), so grow the long run about 10% at a time. With no training run in the last 30 days, the reference is the longest training run of the last 42 days; with none in 42 days either, one run stays within the 20 km return-week cap.
- Races are left out of that reference (runs of kind `race` and any run on the race date): a race is demonstrated capacity (`guardrails.longRun.demonstratedCapacity`), never a long-run base. The legs are damaged after a race, so the post-race rules protect those weeks.
- If race demand seems to require a bigger jump, hold the cap and explain the gap in the summary.
- Reduce the long run in recovery weeks (at most 70% of the recent longest) and during the taper (75% at 15-21 days out, 60% at 8-14 days out, none in race week except the race). The recent longest run is the longest training run of the last 6 weeks, races left out: a race is demonstrated capacity, never a reference.

## Planned Recovery Weeks

- Rhythm 3:1: after three loading weeks in a row, counted from the plan block start or the last unloading week, the next block week is a planned recovery week (`coachContext.periodization.recoveryWeekDue` with `recoveryWeekReason`, limits in `outputRules.guardrails.recoveryWeek`). Ultra coaches commonly use 3:1, or 2:1 for older or heavier athletes.
- A reactive offload (pain, very weak feedback, repeated very hard sessions, a deloaded session), a low-volume week, the taper, or the race resets the count; the taper replaces a recovery week that would fall inside 21 days of the race.
- Running in a recovery week: weekly km 60-75% of the recent 4-week average (capped at 75%), the long run at most 70% of the recent longest run, the usual run frequency, and intensity kept but reduced: one short quality session at most (or strides inside an easy run).
- Strength backs off in the same week; both disciplines recover together.
- Say in the summary that this is a planned recovery week and why.

## Elevation Progression

- Use the race's elevation/distance ratio (total gain in meters divided by distance in km) as the demand target.
- Aim weekly elevation gain toward (race elevation/distance ratio) × weekly km across build and peak; concentrate gain in long runs and hill sessions.
- Weekly climbing over the 7 days (today's run plus the planned runs, race-day session excluded) is at most the larger of 1.25x the 4-week average weekly climbing (races left out) of the 4 weeks before today and 300 m (`guardrails.weeklyClimb.capM`; enforced: over the cap the proxy takes the climbing off the easy and recovery runs first, then the long run, and the hill and quality runs last). Inside 10 days of the race the stricter taper limit applies as well.

## Intensity Split

- Keep roughly 80% of weekly running time easy (Zone 2, conversational) and at most 20% hard (tempo, intervals, hard hills).
- Easy days stay easy. Recovery runs carry no quality content. Use `guardrails.easyReference` (the athlete's own recent easy runs) as the easy pace and heart-rate band.
- `trainingSignals.running.lowIntensityTimeShareLast4Weeks` is the 80/20 split by time: the share of the last 4 weeks' running time spent in easy, recovery, and long runs (long runs are low intensity). A normal build week of a long run, one quality session, and two easy runs reads about 0.8. Only a value well below 0.75 (too much hard running) is a reason to favor easy running. The other end is a problem too: `noSpeedStimulusLast3Weeks` (see Running Floors).

## Back-to-Back Long Runs

Established coaching practice, not verified science. Schedule back-to-back long runs only when all three hold:

- the phase is build or peak
- the race is 80 km or longer
- recent volume supports it: the combined two-day distance fits inside normal weekly progression (the weekly cap)

Otherwise use a single long run. Outside this case, never put two hard runs (long, tempo, intervals, hills) on consecutive days.

## Downhill Conditioning

Descent durability is the limiter in trail ultras, and the protection is trainable: one hard downhill bout reduces muscle damage, soreness and strength loss in the next one (the repeated-bout effect; Khassetarash 2022, recreational runners, bouts about 3 weeks apart). The protection lasts up to about 6 weeks and is gone by 9 (Byrnes 1985), which is why general preparation keeps a descent-loaded run in the rhythm.

- In build and peak, include sustained downhill running inside hill sessions and long runs. Use the race's descent demand and the athlete's recent elevation loss (recentRuns carry `elevationLossM`) to judge how much descent the legs are already absorbing.
- Schedule the last hard downhill-loaded run 2-3 weeks before the race so the protective effect covers race day; never add new downhill load inside the final 10 days.
- Downhill load is eccentric damage by design: introduce it gradually and count a large descent jump as an intensity increase (Progression).

## Readiness Gates

Evidence basis: gating hard sessions on recovery state does not beat a fixed plan on average (Duking 2021 meta-analysis: no significant performance gain); its value is fewer non-responders and better-timed hard sessions. So a gate moves the next quality session; it never empties the week. The rule gates on the athlete's own HRV baseline (Garmin's HRV status is baseline-relative).

- HRV gate: HRV below the athlete's baseline, that is Garmin status LOW or POOR, or a 7-day average below the baseline range (when the wellness day carries `hrvWeeklyAvgMs` and `hrvBaselineLowMs`). UNBALANCED on its own is not a gate: it means the 7-day average sits outside the baseline range in either direction, and above the baseline can be good recovery or functional overreaching.
- Sleep gate: a sleep score below 50 on 2 of the last 3 nights that have a score; one poor night is not a gate.
- Weak signals (heuristic only): training readiness below 30 and body battery below 25. Body battery is a proprietary, unvalidated composite — never let it be the sole reason to change a session; use it as a tie-breaker alongside the HRV or sleep gate.
- A tripped HRV or sleep gate is computed (`guardrails.wellnessGate` holds its day offsets): no tempo, interval or hill run in the next 48 hours (enforced: the proxy turns one there into an easy run). The gate lifts no floor: the run count, the weekly-km floor and the quality run stay, and the quality run moves to a later day that is not next to the long run. Only when no such day is left is the quality floor lifted. Add a safety flag naming the signal.
- HRV is read on the latest day with a reading, while it is at most 2 days old (at the 01:30 plan today's row has none yet); sleep over the last 3 nights that have a score. Treat 0 or missing values as no data, never as a tripped gate.
