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

- `testTodayOnlyTreatsTodayOrOverdueSessionsAsDue`
  - Confirms Today treats only today/overdue planned sessions as due.
  - Confirms future sessions stay scheduled instead of becoming today's action.

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

- `testCoachClientRejectsLoopbackProxyHosts`
  - Verifies loopback proxy hosts are rejected instead of normalized.

- `testCoachPlanRequestEncodesSelectedModel`
  - Verifies the app sends the selected AI model ID and training days in coach-generation requests.

- `testCoachModelCatalogFallsBackForEmptySelection`
  - Verifies empty model settings fall back to the app default model ID.

- `testAcceptsAIPlanAboveFormerProgressionCapsWhenTechnicallyValid`
  - Verifies former local progression caps no longer veto skill-owned coaching policy.
  - Confirms technically valid AI output is accepted.

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
  - Verifies Coach shows the generator surface and AI generation action without the initial ready status.

- `testLogShowsEmptyAIOnlyStateAfterOnboarding`
  - Completes onboarding.
  - Verifies Log starts empty until an AI plan is generated.

- `testProgressAndConsistencyScreensAfterOnboarding`
  - Completes onboarding.
  - Tests Progress overview, embedded lift rings, consistency, penalties, and benchmarks.

- `testCoachTabsAfterOnboarding`
  - Completes onboarding.
  - Tests Coach generator, Context model settings, and Rules surfaces.

- `testProfileResetFlowUsesAIOnlyPlanCreation`
  - Completes onboarding.
  - Tests Profile/Settings, confirms local fallback controls are absent, verifies reminder scheduling button, reset alert, and reset returning to onboarding.

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
  - Covered: profile screen, fallback controls absent, reminder button presence, destructive reset alert.
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
  - Tap `Generate AI week`.
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
