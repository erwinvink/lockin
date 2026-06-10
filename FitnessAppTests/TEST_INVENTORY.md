# lockin Test Inventory

This file is the durable human-readable test list for the lockin app. It records the automated tests currently in the project, the broader screen/scenario coverage already exercised, and additional tests that should be added as the app grows.

## Current Automated Unit Tests

### Training Engine

- `testGeneratesExactWeeklySessionsFromPreferences`
  - Verifies the local training engine generates the configured number of weekly sessions.
  - Confirms generated sessions contain workout blocks.
  - Confirms pull-up work is included when a pull-up bar is available.

- `testPainSignalTriggersDeloadScoring`
  - Verifies a completed session with pain triggers a deload outcome.
  - Confirms deload credit does not create penalty points.

- `testMissedSessionCreatesScorePenaltyWithoutExtraLoad`
  - Verifies a missed session creates a negative consistency outcome.
  - Confirms missed sessions create penalty points.
  - Confirms missed sessions do not trigger unsafe extra training load.

- `testMissedSessionResetsConsistencyStreakImmediately`
  - Confirms missed sessions reset the consistency streak immediately.

- `testTodayOnlyTreatsCurrentDaySessionsAsDue`
  - Confirms Today treats only current-day planned sessions as due.
  - Confirms overdue sessions go to the missed sweep and future sessions stay scheduled.

- `testCompletedRunLogInputScoresPositiveConsistencyAndStreak`
  - Verifies a completed run log scores positive consistency and a +1 streak without any max-test fields.

- `testVeryWeakRunFeelTriggersDeloadScoring`
  - Verifies a very weak run feel (high fatigue) triggers deload scoring while still counting the completion.

- `testHowFeltMapsToExactFatigueLevels`
  - Confirms the 1-5 "how it felt" scale maps to the exact engine fatigue levels (10/8/5/2/0).

- `testRunDistanceTextIsLocaleAwareAndStripsTrailingZero`
  - Verifies run distance formatting follows the locale decimal separator and drops trailing zeros.

- `testRunPaceTextFormatsSecondsPerKilometre`
  - Verifies pace formatting renders seconds per kilometre as `m:ss /km`.

- `testRunTargetTextPrefersPaceThenHeartRateThenZone`
  - Verifies the run target line prefers pace range, then heart-rate range, then zone, then the run kind.

- `testRunTargetTextIgnoresEmptyRanges`
  - Confirms zero/empty target ranges fall through to the next target source.

- `testDuePlannedSessionsReturnsAllOfTodaySortedRunsFirst`
  - Verifies all of today's planned sessions are due, sorted runs before strength.
  - Confirms overdue and future sessions are excluded from due.

### Coach Validation

- `testProxyUnavailableErrorExplainsHostedProxyChecks`
  - Verifies hosted proxy connection errors explain the Coolify/DNS checks.
  - Confirms the message points to `https://lockin.elevenfactor.com`.

- `testMissingAPIKeyErrorExplainsProxyEnvironment`
  - Verifies the app explains the missing proxy `OPENAI_API_KEY` state.
  - Confirms the Coolify environment variable instruction is visible in the error message.

- `testCoachClientDefaultsToHostedProxy`
  - Verifies the default endpoint is `https://lockin.elevenfactor.com/generate-week-plan`.

- `testCoachClientNormalizesBareHostedProxyHost`
  - Verifies entering `lockin.elevenfactor.com` still calls `/generate-week-plan`.

- `testCoachClientRejectsNonHostedProxyHosts`
  - Verifies loopback, plain-HTTP, and other non-hosted proxy hosts are rejected instead of normalized.

- `testCoachPlanRequestEncodesSelectedModel`
  - Verifies the app sends the selected AI model ID and training days in coach-generation requests.

- `testCoachModelCatalogFallsBackForEmptySelection`
  - Verifies empty model settings fall back to the app default model ID.

- `testAcceptsAIPlanWithoutLocalMovementBalancePolicy`
  - Verifies local validation no longer enforces movement-balance policy.
  - Confirms coaching policy remains skill-owned.

- `testRejectsAIPlanWithInvalidTechnicalShape`
  - Verifies malformed schedules, logging fields, and exercise values are rejected.

- `testRejectsAIPlanForToday`
  - Verifies AI generation cannot create a refreshed session for today.

- `testRejectsAIPlanOutsideSelectedTrainingDays`
  - Verifies AI generation honors selected future training days.

- `testAcceptedAIPlanConvertsToVisibleWeeklyPlan`
  - Verifies a balanced AI plan is accepted.
  - Confirms AI `dayOffset` values become visible scheduled workout dates.
  - Confirms AI-generated sessions are visibly labeled in summaries.

- `testMakeCoachRequestWithRaceGoalFillsRunningRequest`
  - Verifies a saved race goal fills the running request (race date, distance, elevation, running days, long-run day, recent runs).

- `testMakeCoachRequestWithoutRaceGoalLeavesRunningNil`
  - Confirms the running request stays nil without a race goal, so the legacy strength-only route is used.

- `testMakeCoachRequestCapsRecentRunsToMostRecentTwenty`
  - Verifies recent runs sent to the coach are capped to the most recent twenty.

- `testMakeCoachRequestOmitsLongRunDayOffsetOutsidePlannableRange`
  - Confirms a long-run day that cannot land in the plannable window is omitted instead of sent stale.

- `testMakeCoachRequestWithEmptyRunningDaysStaysUnconstrained`
  - Confirms an empty running-day selection sends no day constraint.

- `testMakeCoachRequestOmitsLongRunDayOutsideRunningDays`
  - Confirms a long-run day outside the selected running days is omitted.

- `testMakeCoachRequestMapsRunFeelScoreToCoachSummaries`
  - Verifies run feel scores map to the coach-facing log summaries.

- `testRunningWeekValidatorRejectsInvalidTechnicalShape`
  - Verifies malformed running weeks (bad offsets, distances, targets) are rejected client-side.

- `testRunningWeekValidatorRejectsRunsOutsideSelectedDays`
  - Verifies runs scheduled outside the selected running days are rejected.

- `testRunningWeekValidatorAcceptsValidWeekOnAllowedOffsets`
  - Confirms a valid running week on allowed day offsets is accepted.

- `testRunningWeekValidatorAcceptsValidWeekWithoutSelectedDays`
  - Confirms validation passes without a running-day constraint.

- `testCombinedWeekResponseDecodesProxyShape`
  - Verifies the `POST /generate-week` combined running + strength response decodes.

- `testGarminStatusResponseDecodesProxyShape`
  - Verifies `GET /garmin/status` decodes into `GarminStatusResponse`.

- `testGarminSnapshotResponseDecodesProxyShape`
  - Verifies `GET /garmin/snapshot` decodes status, wellness days, and activities.

- `testGarminSnapshotResponseDecodesTruncatedWellness`
  - Confirms a throttling-truncated wellness list still decodes; missing days stay missing.

- `testGarminPushWorkoutsBuildsSidecarPayloadFromPlannedRunningSessions`
  - Verifies planned running sessions convert to the sidecar push payload (title, date, kind, distance, duration, target, notes).

- `testGarminPushWorkoutsKeepsUnsetTargetEmptyForSidecar`
  - Confirms runs without a target send an empty target instead of fabricated bounds.

- `testGarminPushRequestEncodesSidecarContract`
  - Verifies the push request JSON matches the sidecar contract exactly.

- `testGarminPushResponseDecodesProxyShape`
  - Verifies the `{results, error?}` push response decodes.

- `testApplyGarminPushResultsStampsOnlyScheduledMatches`
  - Confirms only scheduled push results stamp `garminWorkoutId`/push date onto their sessions.

- `testGarminDeleteResponseDecodesProxyShape`
  - Verifies the `{results, error?}` delete response decodes.

### Persistence, Reset, and Journey State

- `testWipeAllDataDeletesEveryModel`
  - Verifies reset deletes profile, sessions, blocks, prescriptions, logs, rank, coach plans, and coach decisions.

- `testPersistAIPlanReplacesOnlyFuturePlannedSessions`
  - Verifies AI week persistence replaces only future planned sessions.
  - Confirms completed history survives replacement.
  - Confirms old prescriptions/blocks for replaced planned sessions are deleted.

- `testDeleteNonAIPlannedSessionsKeepsAIAndHistory`
  - Verifies legacy rules-generated planned sessions are removed.
  - Confirms AI planned sessions and completed history survive cleanup.
  - Confirms blocks and prescriptions for removed planned sessions are deleted.

- `testOverduePlannedSessionsAreAutomaticallyMarkedMissed`
  - Verifies the missed sweep marks overdue planned strength sessions missed with the rank penalty.

- `testOverduePlannedRunningSessionIsMarkedMissedWithSameRankPenalty`
  - Verifies a running session past the grace day is missed with the same streak/penalty/consistency impact as strength.

- `testUnloggedRunningSessionGetsOneGraceDayBeforeMissed`
  - Confirms an unlogged run keeps one grace day for the overnight Garmin sync.
  - Confirms strength sessions are still missed at the start of the next day.

- `testRunningSessionWithRunLogIsNeverAutoMissed`
  - Confirms any run log — pending or confirmed — shields the session from the missed sweep.

- `testCompleteRunOnMissedSessionRefundsMissAndScoresNormally`
  - Walks the Monday-run-confirmed-on-Wednesday trace: sweep misses the run, a late Garmin sync matches it, confirming refunds.
  - Verifies the miss penalty/consistency refund is exact, completion scores normally, and a double confirm is a no-op.

- `testCompleteRunOnPlannedSessionAppliesConfirmScoring`
  - Verifies confirming a pending run log completes the session, stores RPE/feel, and applies normal completion scoring.

- `testWipeAllDataDeletesRunningModels`
  - Verifies reset also deletes race goals, run logs, and wellness snapshots.

- `testDefaultWorkoutSessionDisciplineIsStrength`
  - Confirms sessions default to the strength discipline.

- `testUnknownDisciplineRawFallsBackToStrength`
  - Confirms unknown persisted discipline values fall back to strength instead of crashing.

- `testRunningSessionRoundTripsRunFields`
  - Verifies run kind, distance, elevation, duration, targets, and zone survive persistence round trips.

- `testPersistRunningWeekCreatesRunningSessions`
  - Verifies a generated running week persists as planned running sessions.

- `testPersistRunningWeekReplacesOnlyFuturePlannedRunningSessions`
  - Verifies running-week persistence replaces only future planned runs and keeps run history.

- `testPersistStrengthPlanKeepsPlannedRunningSessions`
  - Confirms persisting a strength week does not touch planned runs.

- `testPersistStrengthPlanKeepsPlannedSessionScheduledToday`
  - Confirms strength replacement leaves today's planned session in place.

- `testPersistRunningWeekKeepsPlannedRunningSessionScheduledToday`
  - Confirms running replacement leaves today's planned run in place.

- `testPersistRunningWeekReturnsGarminWorkoutIdsOfDeletedPushedRuns`
  - Verifies replacing pushed runs returns their Garmin workout ids so the caller can delete them from the watch.

- `testPersistRunningWeekWithoutReplacementReturnsNoStaleIds`
  - Confirms persistence without replacement returns no stale Garmin ids.

- `testDeleteNonAIPlannedSessionsKeepsAIRunningSessions`
  - Confirms legacy cleanup keeps AI planned running sessions.

- `testRunningDaysEmptySetRoundTripsThroughPersistence`
  - Verifies an empty running-day selection survives persistence.

- `testRunningDaysCanonicalizeToAllCasesOrder`
  - Verifies running days persist in canonical weekday order.

- `testLongRunDayNilRoundTripsThroughPersistence`
  - Verifies an unset long-run day stays nil through persistence.

- `testIngestWellnessUpsertsOneSnapshotPerCalendarDay`
  - Verifies Garmin wellness ingest upserts exactly one snapshot per calendar day.

- `testMatchGarminActivitiesCreatesPendingRunLogForSameDayPlannedRun`
  - Verifies a synced Garmin activity creates a pending run log on the same-day planned run.

- `testMatchGarminActivitiesMatchesMissedRunningSessionOnSameDay`
  - Confirms a late-synced activity still matches a session the sweep already marked missed.

- `testMatchGarminActivitiesSkipsAlreadyIngestedActivityIds`
  - Confirms already-ingested Garmin activity ids are not ingested twice.

- `testMatchGarminActivitiesMatchesClosestPlannedDistance`
  - Verifies an activity matches the same-day run with the closest planned distance.

- `testMatchGarminActivitiesIgnoresActivityWithoutSameDayPlannedRun`
  - Confirms activities without a same-day planned run are ignored.

- `testMatchGarminActivitiesClaimsEachSessionOnceAndSkipsNonRunningTypes`
  - Confirms each session is claimed by at most one activity and non-running activity types are skipped.

- `testZeroBaselineThreeWeekJourneyWithMissesAndCompletedDaysUpdatesRewards`
  - Creates a zero-baseline `ZeroPlan` profile.
  - Sets custom goals 3 weeks in advance.
  - Generates 3 weeks of sessions.
  - Marks some days missed and fills in the remaining days as completed.
  - Verifies no planned sessions remain.
  - Verifies missed/completed counts, performance logs, penalty points, streak, and consistency.

## Current Automated UI Tests

- `testOnboardingScreenShowsGoalSetup`
  - Launches the app in UI-test mode.
  - Verifies onboarding shows the `lockin` wordmark.
  - Verifies profile creation is available without seeding a local plan.

- `testMainShellAndCoachGeneratorSurfaceAfterOnboarding`
  - Completes onboarding with default values.
  - Verifies Today opens with the AI-only empty plan state.
  - Opens Coach.
  - Verifies Coach shows the coach read, the ready-for-the-first-week status, and the `Plan my week` action.

- `testLogShowsEmptyAIOnlyStateAfterOnboarding`
  - Completes onboarding.
  - Verifies Log starts empty until an AI plan is generated.

- `testProgressScreenAfterOnboarding`
  - Completes onboarding.
  - Tests the Progress overview: streak, best, missed trainings, and embedded lift rings.

- `testCoachReadAndAdvancedControlsAfterOnboarding`
  - Completes onboarding.
  - Tests the Coach read surface and the Advanced disclosure with model and proxy status controls.

- `testProfileResetFlowUsesAIOnlyPlanCreation`
  - Completes onboarding.
  - Tests Profile/Settings, confirms local fallback controls are absent, verifies reminder toggle/time picker, reset alert, and reset returning to onboarding.

- `testTwoWeekSeedPreviewDataSurfaces`
  - Launches with the seeded two-week activity fixture.
  - Verifies the pending Garmin run renders a confirm card above the due session.
  - Verifies Log history, the future workout preview, Progress readiness and running volume (longest run), and the coach read headline.

## Screen Coverage Checklist

- Onboarding
  - Covered: default setup and profile creation.
  - Covered indirectly: custom goals and zero baseline through unit journey test.
  - Still useful: UI-level editing of all numeric onboarding fields.

- Today
  - Covered: AI-only empty state, consistency card.
  - Still useful: AI-generated prescription card, log session, mark missed, week processed.
  - Still useful: popover copy for every exercise info button.

- Log Sheet
  - Covered: save default logged values for planned sessions.
  - Still useful: editing numeric log fields, support-only sessions, pain/fatigue deload UI path.

- Progress
  - Covered: overview, consistency, penalties, Lifts, History, Consistency navigation.
  - Still useful: progress rings after varied pull-up/push-up/plank values.

- Consistency
  - Covered: consistency details screen and benchmark anchors.
  - Still useful: score behavior after varied completion and miss patterns.

- Coach
  - Covered: generator surface, Context model settings, Rules.
  - Covered in unit tests: technical AI output validation and accepted AI conversion.
  - Still useful: UI-level proxy unavailable and missing API key messages.

- Log/Calendar
  - Covered: empty history before AI generation.
  - Still useful: session history and completed status after AI generation.
  - Still useful: deload status row and multi-week date ordering.

- Profile/Settings
  - Covered: profile screen, fallback controls absent, reminder toggle/time picker presence, destructive reset alert.
  - Still useful: reminders authorization allowed/denied paths with a mock notification scheduler.

## Recommended Additional Tests

### High Priority

- Add UI test for custom onboarding values:
  - Set name, baseline measurements, custom goals, sessions per week, and target date.
  - Verify Today goal strip reflects those goals.

- Add unit test for no pull-up bar:
  - Generate a plan without `pullUpBar`.
  - Verify no pull-up-bar exercises are prescribed.

- Add unit test for support-only session logging:
  - Confirm support-only sessions preserve latest goal measurements and do not force unrelated max logging.

- Add unit test for deload persistence:
  - Save a painful/high-fatigue log.
  - Verify session status becomes `deload`.
  - Verify a clamped coach plan and `auto-deload` decision are stored.

- Add UI test for Coach proxy error display:
  - Point proxy URL to an unavailable endpoint.
  - Tap `Plan my week`.
  - Verify the user-facing error explains how to start the proxy.

### Medium Priority

- Add UI test for exercise info popover:
  - Open info for pull-up, push-up, plank, and support exercises.
  - Verify target/rest/effort/context text is visible.

- Add unit test for current-week replacement boundaries:
  - Verify replacement does not delete past planned sessions.
  - Verify replacement does not delete future completed sessions.

- Add unit test for consistency score boundaries:
  - Verify missed and completed sessions clamp consistency at zero and update streaks correctly.

- Add UI test for reset cancellation:
  - Tap reset.
  - Cancel the alert.
  - Verify profile data remains.

### Lower Priority / Regression Safety

- Add snapshot or screenshot checks for every primary screen after the light redesign.
- Add accessibility identifier checks for primary actions.
- Add launch test for non-UI-testing persistence with CloudKit fallback behavior.
- Add test coverage for large text sizes and small-screen layout.
- Add test coverage for empty history, empty plans, and all sessions processed.
- Add proxy script tests for invalid JSON, schema mismatch, and OpenAI non-2xx responses.

## Manual Verification Notes

When doing manual QA on the simulator, use this sequence:

1. Start fresh and verify onboarding.
2. Create a zero-baseline profile with goals 3 weeks out.
3. Open Today and verify the AI-only empty state.
4. Generate a week from Coach through the hosted proxy.
5. Return to Today and inspect consistency, compact prescription rows, checkboxes, and readiness.
6. Check off the due session.
7. Let the next due day roll forward or use test data to verify missed automation.
8. Verify `Week processed`.
9. Inspect Progress overview, embedded lift rings, and Consistency.
10. Inspect Coach generator, Context, Rules.
11. Inspect Log session history.
12. Inspect Profile/Settings and reset.
13. Rerun the full automated test suite.
