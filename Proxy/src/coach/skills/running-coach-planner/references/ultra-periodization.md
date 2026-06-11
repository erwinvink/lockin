# Ultra Periodization

## Phases by Weeks to Race

Use `weeksToRace` to pick the phase. Boundaries are guides, not hard cutoffs.

- Base (more than ~12 weeks out): grow general aerobic volume with easy running. The long run grows gradually. Hills and strides are accents, not workouts.
- Build (~12 to ~6 weeks out): progress weekly volume, long-run distance, and elevation toward race demand. At most one quality session per week.
- Peak (~6 to ~3 weeks out): biggest long runs and biggest elevation weeks of the cycle. Keep intensity controlled; specificity beats speed.
- Taper (final 1-3 weeks): see the Taper section. Begin no later than 21 days out; 8-14 days is the evidence optimum.

## Taper

Verified prescription (Wang 2023 meta-analysis of 14 RCTs; outcomes are sub-ultra time trials, so treat exact percentages as the best available extrapolation for 50-100K):

- Taper for 8-14 days when the block has gone well; never longer than 21 days.
- Cut weekly volume progressively to a total reduction of 41-60% versus the pre-taper week. Cutting more than 60% adds nothing — race week still holds roughly half of normal volume.
- Hold intensity and run frequency constant through the taper: keep short quality touches (strides, brief tempo) into race week. Shorten sessions; do not slow them all down or remove them.

## Long-Run Progression

Established coaching practice, not verified science — treat these caps as protective heuristics:

- Increase the long run by no more than 10-15% per week.
- Never schedule a long run above 1.4x the recent longest run. If race demand seems to require a bigger jump, hold the cap and add a safety flag instead.
- Hold or reduce the long run on recovery weeks and during taper.

## Elevation Progression

- Use the race's elevation/distance ratio (total gain in meters divided by distance in km) as the demand target.
- Aim weekly elevation gain toward (race elevation/distance ratio) × weekly km across build and peak; concentrate gain in long runs and hill sessions.
- A large elevation jump counts as an intensity increase under the one-variable rule.

## Build-Week Shape

A standard build week for an athlete with an established base: the long run, one or two quality sessions (tempo, intervals, or hills), and easy or recovery runs on the remaining days. Weekly volume follows the athlete's demonstrated baseline and builds toward race demand — an experienced athlete's plan should look like experienced training. Safety comes from the progression caps and readiness gates, not from a beginner template.

## Intensity Split

- Keep roughly 80% of weekly running time easy (Zone 2, conversational) and at most 20% hard (tempo, intervals, hard hills).
- Easy days stay easy. Recovery runs carry no quality content.

## Back-to-Back Long Runs

Established coaching practice, not verified science. Schedule back-to-back long runs only when all three hold:

- the phase is build or peak
- the race is 80 km or longer
- recent volume supports it: the combined two-day distance fits inside normal weekly progression

Otherwise use a single long run.

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
