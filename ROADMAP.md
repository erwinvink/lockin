# Lockin Roadmap

Lockin started as a strict calisthenics coach for pull-ups, push-ups, and plank.
The next version should become a broader personal training system: strength,
endurance, journaling, sentiment, and multiple specialized coaches that can learn
from the same personal history without making the iPhone app feel heavy.

## Product Direction

Lockin should feel like a serious personal operating system for training, not a
generic workout tracker.

Core pillars:

- Strength progression: keep the current pull-up, push-up, and plank mission.
- Endurance progression: add running, long runs, and eventually ultra-running.
- Personal reflection: add journaling and check-ins as first-class inputs.
- Coaching intelligence: split coaching into focused specialists plus one
  synthesis coach.
- Clean app boundary: keep complex coach logic and private model instructions out
  of the iOS client where possible.

## Coach Model

The intended coach setup:

- Strength coach: owns pull-up, push-up, plank, deloads, strength progression,
  missed workouts, and strict-form benchmarks.
- Ultra-running coach: owns base mileage, long runs, terrain, fatigue, recovery,
  race goals, fueling prompts, and injury risk.
- Synthesis coach: reads strength logs, running logs, journal entries, sentiment,
  pain, fatigue, and adherence. It does not replace the specialist coaches; it
  reconciles them into one weekly direction.

This keeps each coach easier to test and lets the app explain why a plan changed:
"The running coach wanted more volume, but the synthesis coach reduced strength
intensity because your journal and fatigue check-in showed elevated risk."

## Phase 1: Stabilize the Current Strength App

Goal: make the existing calisthenics app a trustworthy base before adding running.

Work:

- Keep the current AI week planning flow visible and explainable.
- Tighten the logging model around completed, missed, partial, and deloaded
  sessions.
- Make the current coach output fully inspectable from the app.
- Preserve the existing proxy boundary so no OpenAI key or hidden coach policy
  lives inside the iOS app.
- Add a small product vocabulary: plan, session, log, check-in, journal, coach,
  risk flag, and recovery state.

Success criteria:

- A user can understand what the strength coach planned, what changed, and why.
- Training history is reliable enough to become input for other coaches.
- The app still feels simple: Today, Plan, Log, Coach, Progress, Settings.

## Phase 2: Server Architecture Spike

Goal: decide whether coach skills and coach orchestration should move from the
local proxy into a real server.

Questions to answer:

- Should the server store coach skills, schemas, validation, and history
  summaries?
- Should the iOS app remain mostly a UI and local cache?
- Which data stays local-only, and which data syncs to the server?
- How do we handle privacy for journals and sentiment check-ins?
- Do coaches run on demand, on a schedule, or both?
- Do we need account/login now, or can this stay personal-device-first for longer?

Likely server responsibilities:

- Store versioned coach skills and reference material.
- Build coach context from training logs, running logs, journals, and check-ins.
- Run specialist coaches and the synthesis coach.
- Validate structured coach output before the app accepts it.
- Return clean, app-ready plans and explanations.

Likely iOS responsibilities:

- Capture workouts, runs, journals, and check-ins.
- Show plans, progress, coach explanations, and alerts.
- Cache recent state for offline use.
- Keep the interface calm and fast.

Decision output:

- Keep local proxy only.
- Move to personal server now.
- Hybrid: keep local mode for development, add server mode for real use.

Recommended default: hybrid. The current proxy is useful for development, but
the long-term app will be cleaner if coach orchestration, validation, and skill
versioning live on a server.

## Phase 3: Journaling and Sentiment Check-ins

Goal: make reflection useful without turning the app into a diary app first.

Work:

- Add a simple daily check-in:
  - mood
  - energy
  - fatigue
  - soreness or pain
  - motivation
  - stress
  - sleep quality
- Add short-form journal entries.
- Let the user tag entries as training, recovery, work stress, faith, motivation,
  injury, race, or general.
- Add sentiment/risk extraction on the server or proxy.
- Keep raw journal text private and make coach-visible summaries explicit.

Coach inputs:

- Last 7 check-ins.
- Last 5 journal summaries.
- Current mood/fatigue trend.
- Any pain, motivation, or stress flags.

Success criteria:

- The app can tell the difference between "I missed a workout because I was lazy"
  and "I missed a workout because stress/fatigue/injury risk is rising."
- The synthesis coach can use journal context without overreacting to one bad day.

## Phase 4: Running Foundation

Goal: add endurance running without jumping straight to ultra complexity.

Work:

- Add running goals:
  - run frequency
  - weekly distance or time
  - long-run target
  - race date
  - preferred surfaces
  - current comfortable distance
  - injury history
- Add run logging:
  - distance
  - duration
  - perceived effort
  - terrain
  - elevation if available later
  - notes
- Add running plan sessions:
  - easy run
  - long run
  - recovery run
  - hill session
  - intervals or tempo
  - rest/mobility
- Create the first ultra-running coach skill with conservative progression and
  recovery rules.

Success criteria:

- The app can plan a sensible running week.
- Running and strength sessions no longer compete blindly for the same recovery
  budget.
- The app can show total weekly load across strength and running.

## Phase 5: Ultra-Running Mode

Goal: support serious long-term ultra preparation.

Work:

- Add race profiles:
  - distance
  - date
  - elevation
  - terrain
  - cutoff time
  - expected weather notes
- Add ultra-specific plan elements:
  - back-to-back long runs
  - hike/run strategy
  - downhill conditioning
  - fueling practice
  - gear checks
  - taper blocks
  - recovery weeks
- Add a long-horizon training calendar.
- Add injury-risk and overtraining warnings.
- Add weekly coach review across strength, running, journal, and sentiment.

Success criteria:

- Lockin can guide a multi-month ultra build without flattening everything into
  normal "workout streak" logic.
- The app explains tradeoffs between strength goals and endurance goals.

## Phase 6: Multi-Coach Orchestration

Goal: make multiple coaches work as one system.

Flow:

1. Strength coach proposes the strength week.
2. Ultra-running coach proposes the running week.
3. Synthesis coach reads both proposals plus logs, journals, and check-ins.
4. Synthesis coach resolves conflicts and returns one integrated week.
5. Validator rejects structurally invalid plans.
6. App shows the final plan and a short explanation.

Needed server/proxy pieces:

- Shared athlete profile.
- Shared training history summary.
- Coach-specific context builders.
- Coach-specific output schemas.
- Synthesis schema.
- Final safety validator.
- Skill version tracking so old plans can be explained later.

Success criteria:

- The app can say: "This week is strength-maintenance because long-run load is
  high."
- Coach decisions are inspectable and testable.
- Adding a new coach later does not require rewriting the whole app.

## Phase 7: Product Polish and Habit System

Goal: make the app something you actually want to open daily.

Work:

- Improve Today into a command center:
  - today's training
  - check-in
  - journal shortcut
  - coach note
  - recovery warning if needed
- Add weekly review:
  - what was planned
  - what happened
  - what changed
  - next week's focus
- Add progress views for:
  - strength goals
  - weekly running load
  - long-run progression
  - consistency
  - recovery/sentiment trend
- Add reminders that feel like coach nudges, not generic notifications.

Success criteria:

- The app has one clear daily loop.
- The user can see whether they are becoming stronger, more durable, and more
  consistent.

## Suggested Implementation Order

1. Write down the server decision and data privacy rules.
2. Add journal and sentiment models to the app.
3. Add daily check-in UI and persistence.
4. Add server/proxy context builder for journals and check-ins.
5. Add basic run logging.
6. Add basic running plans.
7. Add ultra-running coach skill and schema.
8. Add synthesis coach.
9. Add integrated weekly plan.
10. Add ultra race profile and long-horizon calendar.

## Open Product Decisions

- Is Lockin personal-only, or should it be built as a multi-user app from the
  start?
- Should journals sync to a server, stay local, or sync only as summaries?
- Should the synthesis coach be allowed to read raw journal entries?
- Should running plans optimize for distance, time-on-feet, or race date first?
- Should strength goals remain equal priority once ultra training begins?
- Should Apple Health import be part of the first running version, or later?
- Should the app support manual-only running logs first, before GPS/watch data?

## Near-Term Milestone

The next concrete milestone should be:

"Lockin has daily check-ins, short journal entries, and a server/proxy spike that
proves whether coach skills should move out of the app. The existing strength
coach can use check-in and journal summaries when generating the next week."

That milestone is small enough to build next, but it sets up every bigger idea:
ultra running, multi-coach orchestration, sentiment, and a cleaner app boundary.
