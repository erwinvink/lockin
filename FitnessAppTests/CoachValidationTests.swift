import XCTest
@testable import FitnessApp

final class CoachValidationTests: XCTestCase {
    func testProxyUnavailableErrorExplainsHostedProxyChecks() throws {
        let endpoint = try XCTUnwrap(URL(string: LocalCoachClient.hostedEndpointString))
        let error = CoachClientError.proxyUnavailable(endpoint, URLError(.cannotConnectToHost))
        let message = try XCTUnwrap(error.errorDescription)

        XCTAssertTrue(message.contains("hosted coach proxy is not reachable"))
        XCTAssertTrue(message.contains("Coolify deployment"))
        XCTAssertTrue(message.contains("https://lockin.elevenfactor.com"))
    }

    func testProxyUnavailableErrorExplainsLocalProxyStart() throws {
        let endpoint = try XCTUnwrap(URL(string: "http://127.0.0.1:8787/generate-week-plan"))
        let error = CoachClientError.proxyUnavailable(endpoint, URLError(.cannotConnectToHost))
        let message = try XCTUnwrap(error.errorDescription)

        XCTAssertTrue(message.contains("local coach proxy"))
        XCTAssertTrue(message.contains("npm run dev"))
    }

    func testMissingAPIKeyErrorExplainsProxyEnvironment() {
        let error = CoachClientError.invalidStatus(500, "OPENAI_API_KEY is not set")
        let message = error.localizedDescription

        XCTAssertTrue(message.contains("OPENAI_API_KEY is not set"))
        XCTAssertTrue(message.contains("Coolify environment variables"))
    }

    func testMissingGarminRouteErrorExplainsProxyRedeploy() throws {
        let endpoint = try XCTUnwrap(URL(string: "https://lockin.elevenfactor.com/garmin/connect"))
        let error = CoachClientError.missingGarminRoute(endpoint)
        let message = error.localizedDescription

        XCTAssertTrue(message.contains("/garmin/connect"))
        XCTAssertTrue(message.contains("Redeploy the coach proxy"))
        XCTAssertTrue(message.contains("GARMIN_SERVICE_URL"))
    }

    func testMissingCoachChatRouteErrorExplainsHostedRedeployOrDebugEndpoint() throws {
        let endpoint = try XCTUnwrap(URL(string: "https://lockin.elevenfactor.com/coach-chat"))
        let error = CoachClientError.missingCoachChatRoute(endpoint)
        let message = error.localizedDescription

        XCTAssertTrue(message.contains("/coach-chat"))
        XCTAssertTrue(message.contains("COACH_PROXY_ENDPOINT"))
        XCTAssertTrue(message.contains("redeploy"))
    }

    func testMissingCoachChatRouteErrorExplainsLocalProxyRestart() throws {
        let endpoint = try XCTUnwrap(URL(string: "http://192.168.1.20:8787/coach-chat"))
        let error = CoachClientError.missingCoachChatRoute(endpoint)
        let message = error.localizedDescription

        XCTAssertTrue(message.contains("local coach proxy"))
        XCTAssertTrue(message.contains("npm run dev"))
    }

    func testSimulatorDevelopmentEndpointFallsBackToLoopbackProxy() {
        XCTAssertEqual(
            LocalCoachClient.resolvedDevelopmentEndpoint(environment: [:], isSimulator: true),
            "http://127.0.0.1:8787/generate-week-plan"
        )
        XCTAssertEqual(
            LocalCoachClient.resolvedDevelopmentEndpoint(environment: ["COACH_PROXY_ENDPOINT": "   "], isSimulator: true),
            "http://127.0.0.1:8787/generate-week-plan"
        )
    }

    func testPhysicalDeviceDevelopmentEndpointFallsBackToHostedProxy() {
        XCTAssertEqual(
            LocalCoachClient.resolvedDevelopmentEndpoint(environment: [:], isSimulator: false),
            LocalCoachClient.hostedEndpointString
        )
        XCTAssertEqual(
            LocalCoachClient.resolvedDevelopmentEndpoint(environment: ["COACH_PROXY_ENDPOINT": "   "], isSimulator: false),
            LocalCoachClient.hostedEndpointString
        )
    }

    func testPhysicalDeviceDevelopmentEndpointHonorsBundledLanEndpoint() {
        XCTAssertEqual(
            LocalCoachClient.resolvedDevelopmentEndpoint(
                environment: [:],
                isSimulator: false,
                bundledEndpoint: "http://192.168.1.20:8787/generate-week-plan"
            ),
            "http://192.168.1.20:8787/generate-week-plan"
        )
    }

    func testPhysicalDeviceDevelopmentEndpointIgnoresBundledLoopbackEndpoint() {
        XCTAssertEqual(
            LocalCoachClient.resolvedDevelopmentEndpoint(
                environment: [:],
                isSimulator: false,
                bundledEndpoint: "http://127.0.0.1:8787/generate-week-plan"
            ),
            LocalCoachClient.hostedEndpointString
        )
        XCTAssertEqual(
            LocalCoachClient.resolvedDevelopmentEndpoint(
                environment: [:],
                isSimulator: false,
                bundledEndpoint: "$(COACH_PROXY_ENDPOINT)"
            ),
            LocalCoachClient.hostedEndpointString
        )
    }

    func testDevelopmentEndpointEnvironmentOverrideWinsOverBundledEndpoint() {
        XCTAssertEqual(
            LocalCoachClient.resolvedDevelopmentEndpoint(
                environment: ["COACH_PROXY_ENDPOINT": "http://192.168.1.30:8787"],
                isSimulator: false,
                bundledEndpoint: "http://192.168.1.20:8787"
            ),
            "http://192.168.1.30:8787"
        )
    }

    func testDevelopmentEndpointHonorsSchemeEnvironmentOverride() {
        XCTAssertEqual(
            LocalCoachClient.resolvedDevelopmentEndpoint(environment: ["COACH_PROXY_ENDPOINT": "http://192.168.1.20:8787"], isSimulator: true),
            "http://192.168.1.20:8787"
        )
    }

    func testPhysicalDeviceDevelopmentEndpointIgnoresLoopbackOverride() {
        XCTAssertEqual(
            LocalCoachClient.resolvedDevelopmentEndpoint(environment: ["COACH_PROXY_ENDPOINT": "http://127.0.0.1:8787"], isSimulator: false),
            LocalCoachClient.hostedEndpointString
        )
        XCTAssertEqual(
            LocalCoachClient.resolvedDevelopmentEndpoint(environment: ["COACH_PROXY_ENDPOINT": "localhost:8787"], isSimulator: false),
            LocalCoachClient.hostedEndpointString
        )
    }

    func testPhysicalDeviceDevelopmentEndpointAllowsLanOverride() {
        XCTAssertEqual(
            LocalCoachClient.resolvedDevelopmentEndpoint(environment: ["COACH_PROXY_ENDPOINT": "http://192.168.1.20:8787"], isSimulator: false),
            "http://192.168.1.20:8787"
        )
    }

    func testHostedEndpointStringPointsAtProductionProxy() {
        XCTAssertEqual(LocalCoachClient.hostedEndpointString, "https://lockin.elevenfactor.com/generate-week-plan")
    }

    func testCoachClientNormalizesBareHostedProxyHost() throws {
        let client = try LocalCoachClient(endpointString: "lockin.elevenfactor.com")

        XCTAssertEqual(client.endpoint.absoluteString, "https://lockin.elevenfactor.com/generate-week-plan")
    }

    func testCoachClientRejectsNonHostedProxyHostsWhenLocalEndpointsDisallowed() {
        // Release behavior: only the hosted proxy over https is accepted.
        XCTAssertThrowsError(try LocalCoachClient(endpointString: "127.0.0.1:8787", allowsLocalEndpoints: false))
        XCTAssertThrowsError(try LocalCoachClient(endpointString: "http://localhost:8787/generate-week-plan", allowsLocalEndpoints: false))
        XCTAssertThrowsError(try LocalCoachClient(endpointString: "http://172.20.10.3:8790/generate-week-plan", allowsLocalEndpoints: false))
        XCTAssertThrowsError(try LocalCoachClient(endpointString: "http://lockin.elevenfactor.com/generate-week-plan", allowsLocalEndpoints: false))
    }

    func testCoachClientAcceptsLoopbackAndPrivateHostsForLocalDevelopment() throws {
        XCTAssertEqual(
            try LocalCoachClient(endpointString: "http://127.0.0.1:8787", allowsLocalEndpoints: true).endpoint.absoluteString,
            "http://127.0.0.1:8787/generate-week-plan"
        )
        XCTAssertNoThrow(try LocalCoachClient(endpointString: "http://localhost:8787/generate-week-plan", allowsLocalEndpoints: true))
        XCTAssertNoThrow(try LocalCoachClient(endpointString: "http://192.168.1.20:8787/generate-week-plan", allowsLocalEndpoints: true))
        XCTAssertNoThrow(try LocalCoachClient(endpointString: "http://172.20.10.3:8790/generate-week-plan", allowsLocalEndpoints: true))
        XCTAssertNoThrow(try LocalCoachClient(endpointString: "http://10.0.0.5:8787", allowsLocalEndpoints: true))
    }

    func testCoachClientDefaultsBarePrivateHostsToHTTPForLocalDevelopment() throws {
        let client = try LocalCoachClient(endpointString: "192.168.1.20:8787", allowsLocalEndpoints: true)

        XCTAssertEqual(client.endpoint.absoluteString, "http://192.168.1.20:8787/generate-week-plan")
    }

    func testCoachClientRejectsPublicHTTPHostsEvenWithLocalEndpointsAllowed() {
        XCTAssertThrowsError(try LocalCoachClient(endpointString: "http://example.com/generate-week-plan", allowsLocalEndpoints: true))
        XCTAssertThrowsError(try LocalCoachClient(endpointString: "http://8.8.8.8:8787", allowsLocalEndpoints: true))
    }

    func testCoachClientStillAcceptsHostedProxyWithLocalEndpointsAllowed() {
        XCTAssertNoThrow(try LocalCoachClient(endpointString: LocalCoachClient.hostedEndpointString, allowsLocalEndpoints: true))
    }

    func testLegacyIntensityMapsCommonHostedTerms() {
        XCTAssertEqual(PlannedEffortLabel.fromLegacyIntensity("challenging"), .hard)
        XCTAssertEqual(PlannedEffortLabel.fromLegacyIntensity("warm-up"), .light)
        XCTAssertEqual(PlannedEffortLabel.fromLegacyIntensity("support"), .medium)
    }

    func testCoachPlanRequestEncodesSelectedModel() throws {
        let request = CoachPlanRequest(
            userId: LockinCurrentUser.username,
            model: "gpt-5.5",
            baseline: CoachBaseline(pullUps: 1, pushUps: 2, plankSeconds: 30),
            goals: CoachGoals(pullUps: 10, pushUps: 20, plankSeconds: 120),
            profileNotes: "Left elbow gets cranky after high pull volume.",
            weekStart: Date(timeIntervalSince1970: 0),
            weeklySessions: 3,
            trainingDays: ["monday", "wednesday", "friday"],
            trainingDayOffsets: [1, 3, 5],
            equipment: ["pullUpBar"],
            targetDate: Date(timeIntervalSince1970: 86_400),
            trainingLogs: [
                CoachLog(
                    id: UUID().uuidString,
                    sessionId: UUID().uuidString,
                    completedAt: Date(timeIntervalSince1970: 0),
                    pullUps: 1,
                    pushUps: 2,
                    plankSeconds: 30,
                    loggedPullUps: true,
                    loggedPushUps: true,
                    loggedPlankSeconds: true,
                    rpe: 7,
                    painLevel: 2,
                    fatigueLevel: 5,
                    notes: "Felt shoulder tightness near the end."
                )
            ],
            plannedSessions: []
        )

        let data = try JSONEncoder.coachEncoder.encode(request)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(object["model"] as? String, "gpt-5.5")
        XCTAssertEqual(object["userId"] as? String, LockinCurrentUser.username)
        XCTAssertEqual(object["profileNotes"] as? String, "Left elbow gets cranky after high pull volume.")
        XCTAssertEqual(object["trainingDays"] as? [String], ["monday", "wednesday", "friday"])
        XCTAssertEqual(object["trainingDayOffsets"] as? [Int], [1, 3, 5])
        let logs = try XCTUnwrap(object["trainingLogs"] as? [[String: Any]])
        let firstLog = try XCTUnwrap(logs.first)
        XCTAssertEqual(firstLog["notes"] as? String, "Felt shoulder tightness near the end.")
    }

    func testCoachPlanRequestIncludesPreviousPrescriptions() throws {
        let scheduledDate = Date()
        let session = WorkoutSession(
            scheduledDate: scheduledDate,
            title: "Pull plan",
            weekIndex: 1,
            focus: .pull,
            summary: "AI: Pull work"
        )
        let prescription = SetPrescription(
            sessionId: session.id,
            blockId: UUID(),
            orderIndex: 0,
            exercise: .pullUp,
            sets: 3,
            targetReps: 4,
            restSeconds: 120,
            intensity: "Hard",
            plannedEffort: .hard("Build strict pull-up capacity.")
        )
        let profile = UserProfile(
            targetDate: Date(timeIntervalSince1970: 86_400),
            weeklySessions: 1,
            equipment: [.pullUpBar],
            baselinePullUps: 3,
            baselinePushUps: 15,
            baselinePlankSeconds: 45
        )

        let request = makeCoachRequest(
            profile: profile,
            modelID: "gpt-5-mini",
            logs: [],
            sessions: [session],
            prescriptions: [prescription],
            weekStart: scheduledDate.addingTimeInterval(86_400)
        )

        XCTAssertEqual(request.userId, profile.id.uuidString)
        let exercise = try XCTUnwrap(request.plannedSessions.first?.exercises.first)
        XCTAssertEqual(exercise.exercise, "pullUp")
        XCTAssertEqual(exercise.sets, 3)
        XCTAssertEqual(exercise.targetReps, 4)
        XCTAssertEqual(exercise.plannedEffortLabel, "hard")
        XCTAssertEqual(exercise.plannedEffortStimulus, "strength")
    }

    func testMakeCoachRequestCarriesPlannedVsActualRPECalibration() throws {
        let now = Date()
        let profile = UserProfile(
            targetDate: now.addingTimeInterval(86_400),
            weeklySessions: 1,
            equipment: [.pullUpBar],
            baselinePullUps: 3,
            baselinePushUps: 15,
            baselinePlankSeconds: 45
        )
        let session = WorkoutSession(
            scheduledDate: now,
            title: "Pull calibration",
            weekIndex: 1,
            focus: .pull,
            status: .completed,
            summary: "AI: Pull work",
            plannedEffort: PlannedEffort.hard("Pull day should feel productive.")
        )
        let log = PerformanceLog(
            sessionId: session.id,
            completedAt: now,
            pullUps: 4,
            pushUps: 15,
            plankSeconds: 45,
            rpe: 4,
            plannedRPE: 7,
            plannedEffortLabelAtLog: .hard,
            plannedEffortReasonAtLog: "Pull day should feel productive.",
            painLevel: 0,
            fatigueLevel: 2,
            notes: "Finished with plenty left."
        )

        let request = makeCoachRequest(
            profile: profile,
            modelID: "gpt-5-mini",
            logs: [log],
            sessions: [session],
            weekStart: currentWeekStart()
        )

        let coachLog = try XCTUnwrap(request.trainingLogs.first)
        XCTAssertEqual(coachLog.plannedRPE, 7)
        XCTAssertEqual(coachLog.actualRPE, 4)
        XCTAssertEqual(coachLog.rpeDelta, -3)
        XCTAssertEqual(coachLog.rpeSummary, "RPE - Planned 7 | Actual 4")
        XCTAssertEqual(coachLog.plannedEffortLabel, "hard")
        XCTAssertEqual(coachLog.plannedEffortReason, "Pull day should feel productive.")
    }

    func testCoachModelCatalogFallsBackForEmptySelection() {
        XCTAssertEqual(CoachModelCatalog.normalized("  "), CoachModelCatalog.defaultModelID)
        XCTAssertEqual(CoachModelCatalog.normalized(" gpt-5.5 "), "gpt-5.5")
    }

    func testCoachVerdictFreshnessUsesSourceLogIDWhenAvailable() {
        let latestLog = PerformanceLog(
            sessionId: UUID(),
            completedAt: Date(timeIntervalSince1970: 200),
            pullUps: 5,
            pushUps: 20,
            plankSeconds: 60,
            rpe: 7,
            painLevel: 0,
            fatigueLevel: 5,
            notes: "Latest session"
        )
        let currentVerdict = coachVerdictFixture(
            sourceLogId: latestLog.id,
            createdAt: Date(timeIntervalSince1970: 100)
        )
        let oldVerdict = coachVerdictFixture(
            sourceLogId: UUID(),
            createdAt: Date(timeIntervalSince1970: 300)
        )

        XCTAssertFalse(coachVerdictNeedsRefresh(latestLog: latestLog, latestVerdict: currentVerdict))
        XCTAssertTrue(coachVerdictNeedsRefresh(latestLog: latestLog, latestVerdict: oldVerdict))
        XCTAssertTrue(coachVerdictNeedsRefresh(latestLog: latestLog, latestVerdict: nil))
        XCTAssertFalse(coachVerdictNeedsRefresh(latestLog: nil, latestVerdict: currentVerdict))
    }

    func testCoachVerdictFreshnessFallsBackToTimestampsForLegacyVerdicts() {
        let latestLog = PerformanceLog(
            sessionId: UUID(),
            completedAt: Date(timeIntervalSince1970: 200),
            pullUps: 5,
            pushUps: 20,
            plankSeconds: 60,
            rpe: 7,
            painLevel: 0,
            fatigueLevel: 5,
            notes: "Latest session"
        )
        let staleLegacyVerdict = coachVerdictFixture(sourceLogId: nil, createdAt: Date(timeIntervalSince1970: 100))
        let currentLegacyVerdict = coachVerdictFixture(sourceLogId: nil, createdAt: Date(timeIntervalSince1970: 300))

        XCTAssertTrue(coachVerdictNeedsRefresh(latestLog: latestLog, latestVerdict: staleLegacyVerdict))
        XCTAssertFalse(coachVerdictNeedsRefresh(latestLog: latestLog, latestVerdict: currentLegacyVerdict))
    }

    func testCoachVerdictHumanizesWatchItemsAndUsesDomainReads() {
        let verdict = CoachVerdict(
            sourceLogId: nil,
            headline: "Recovery needed",
            summary: "Keep the next step simple.",
            latestChange: "Fallback running",
            recommendation: "Fallback strength",
            runningRead: "Running volume rose quickly; keep the next run easy.",
            strengthRead: "Strength stays supportive while pain settles.",
            nextStep: "Keep the next session easy.",
            watchItems: ["recent_pain_level_4_or_higher", "recent_effort_above_plan"],
            shouldUpdatePlan: true,
            contextState: "recovery_needed",
            safetyFlags: []
        )

        XCTAssertEqual(verdict.runningRead, "Running volume rose quickly; keep the next run easy.")
        XCTAssertEqual(verdict.strengthRead, "Strength stays supportive while pain settles.")
        XCTAssertEqual(verdict.nextStep, "Keep the next session easy.")
        XCTAssertEqual(verdict.watchItems, ["Pain reached 4/10 recently", "Effort has been higher than planned"])
    }

    func testCoachVerdictPersistsStructuredEvaluationAndSnapshot() {
        let response = CoachVerdictResponse(
            headline: "On track",
            summary: "Adherence is good and readiness is clear.",
            latestChange: "Recent work is steady.",
            recommendation: "Keep the next session controlled.",
            runningRead: "Running stays steady.",
            strengthRead: "Strength stays productive.",
            nextStep: "Complete today's session.",
            watchItems: [],
            shouldUpdatePlan: false,
            contextState: "building",
            safetyFlags: [],
            evaluation: CoachEvaluationResponse(
                status: "on_track",
                statusLabel: "On track",
                adherence: CoachAdherenceEvaluationResponse(
                    standardPct: 80,
                    band: "on_track",
                    completedPct: 83,
                    dueSessions: 6,
                    completedSessions: 5,
                    partialSessions: 0,
                    deloadSessions: 0,
                    missedSessions: 1,
                    futureSessionsExcluded: 2,
                    rationale: "83% meets the 80% adherence standard. 2 future sessions excluded."
                ),
                readiness: CoachReadinessEvaluationResponse(
                    state: "building",
                    painOrFatigueFlag: false,
                    hrvGate: "ok-for-hard",
                    trainingReadiness: 71,
                    riskFlags: [],
                    rationale: "No current readiness gate is blocking normal work."
                ),
                progress: CoachProgressEvaluationResponse(
                    state: "holding",
                    trendLabel: "flat",
                    flatGoalMetrics: [],
                    rationale: "Progress is holding rather than clearly moving forward."
                ),
                planDecision: CoachPlanDecisionResponse(
                    action: "keep_plan",
                    shouldUpdatePlan: false,
                    rationale: "The current plan is still the right structure."
                ),
                nextAction: "Complete today's session."
            ),
            snapshot: CoachSnapshotResponse(
                version: 1,
                generatedAt: "2026-06-28T12:00:00.000Z",
                status: "on_track",
                statusLabel: "On track",
                adherencePct: 83,
                readinessState: "building",
                planDecision: "keep_plan",
                shouldUpdatePlan: false,
                nextAction: "Complete today's session.",
                facts: ["Adherence 83%", "Readiness building"]
            )
        )

        let verdict = CoachVerdict(response: response, sourceLogId: nil)

        XCTAssertEqual(verdict.evaluationStatus, "on_track")
        XCTAssertEqual(verdict.evaluationStatusLabel, "On track")
        XCTAssertEqual(verdict.adherencePct, 83)
        XCTAssertEqual(verdict.adherenceLabel, "83%")
        XCTAssertEqual(verdict.adherenceDetail, "6 due, 2 future excluded")
        XCTAssertEqual(verdict.planDecisionLabel, "Keep plan")
        XCTAssertTrue(verdict.coachEvaluationReasons.contains("No current readiness gate is blocking normal work."))
        XCTAssertFalse(verdict.coachSnapshotRaw.isEmpty)
    }

    func testRejectsMaxOutputPlanWhenItIsNotATest() {
        let response = CoachPlanResponse(
            summary: "Too hot",
            contextState: "building",
            safetyFlags: [],
            sessions: [
                CoachSessionResponse(
                    title: "Bad pull day",
                    dayOffset: 1,
                    focus: "pull",
                    plannedEffort: .effort(label: "max_output", targetRPE: 10, targetRIR: 0, stimulus: "strength"),
                    purpose: "Too much work",
                    estimatedDurationMinutes: 20,
                    progressionRationale: "Unsafe",
                    safetyNotes: [],
                    loggingFieldsRequired: ["pullUps"],
                    exercises: [
                        CoachExerciseResponse(exercise: "pullUp", sets: 8, reps: 20, seconds: 0, restSeconds: 30, intensity: "Max", plannedEffort: .effort(label: "max_output", targetRPE: 10, targetRIR: 0, stimulus: "strength"))
                    ]
                )
            ]
        )

        let result = CoachPlanValidator().validate(
            response: response,
            baseline: Baseline(pullUps: 5, pushUps: 20, plankSeconds: 60),
            preferences: TrainingPreferences(
                weeklySessions: 1,
                equipment: [.pullUpBar],
                targetDate: Date(timeIntervalSinceNow: 365 * 24 * 60 * 60)
            ),
            weekStart: Date()
        )

        XCTAssertEqual(result.status, .rejected)
        XCTAssertTrue(result.messages.contains { $0.contains("max output") })
    }

    func testRejectsAIPlanForToday() {
        var response = CoachPlanResponse.balancedFixture()
        response.sessions[0].dayOffset = 0

        let result = CoachPlanValidator().validate(
            response: response,
            baseline: Baseline(pullUps: 5, pushUps: 20, plankSeconds: 60),
            preferences: TrainingPreferences(
                weeklySessions: 4,
                equipment: [.pullUpBar],
                targetDate: Date(timeIntervalSinceNow: 365 * 24 * 60 * 60)
            ),
            weekStart: Date()
        )

        XCTAssertEqual(result.status, .rejected)
        XCTAssertTrue(result.messages.contains { $0.contains("day offset 0 is today") })
    }

    func testRejectsAIPlanOutsideSelectedTrainingDays() {
        var response = CoachPlanResponse.balancedFixture()
        response.sessions = [
            CoachPlanResponse.mixedFixture(title: "Monday", dayOffset: 1),
            CoachPlanResponse.mixedFixture(title: "Rest day leak", dayOffset: 4),
            CoachPlanResponse.mixedFixture(title: "Friday", dayOffset: 5)
        ]

        let result = CoachPlanValidator().validate(
            response: response,
            baseline: Baseline(pullUps: 5, pushUps: 20, plankSeconds: 60),
            preferences: TrainingPreferences(
                weeklySessions: 3,
                trainingDays: [.monday, .wednesday, .friday],
                equipment: [.pullUpBar],
                targetDate: Date(timeIntervalSinceNow: 365 * 24 * 60 * 60)
            ),
            weekStart: Date(timeIntervalSince1970: 0)
        )

        XCTAssertEqual(result.status, .rejected)
        XCTAssertTrue(result.messages.contains { $0.contains("rest day") })
    }

    func testAcceptsAIPlanWithFewerSessionsThanSelectedFutureTrainingDays() throws {
        let weekStart = try XCTUnwrap(Calendar.current.date(from: DateComponents(year: 2026, month: 6, day: 7)))
        var response = CoachPlanResponse.balancedFixture()
        response.sessions = [
            CoachPlanResponse.mixedFixture(title: "Monday", dayOffset: 1),
            CoachPlanResponse.mixedFixture(title: "Wednesday", dayOffset: 3)
        ]

        let result = CoachPlanValidator().validate(
            response: response,
            baseline: Baseline(pullUps: 5, pushUps: 20, plankSeconds: 60),
            preferences: TrainingPreferences(
                weeklySessions: 4,
                trainingDays: [.monday, .wednesday, .friday, .saturday],
                equipment: [.pullUpBar],
                targetDate: Date(timeIntervalSinceNow: 365 * 24 * 60 * 60)
            ),
            weekStart: weekStart
        )

        XCTAssertEqual(result.status, .accepted)
        XCTAssertTrue(result.messages.isEmpty)
    }

    func testRejectsAIPlanWithMoreSessionsThanSelectedFutureTrainingDays() throws {
        let weekStart = try XCTUnwrap(Calendar.current.date(from: DateComponents(year: 2026, month: 6, day: 7)))
        let response = CoachPlanResponse.balancedFixture()

        let result = CoachPlanValidator().validate(
            response: response,
            baseline: Baseline(pullUps: 5, pushUps: 20, plankSeconds: 60),
            preferences: TrainingPreferences(
                weeklySessions: 2,
                trainingDays: [.friday, .saturday],
                equipment: [.pullUpBar],
                targetDate: Date(timeIntervalSinceNow: 365 * 24 * 60 * 60)
            ),
            weekStart: weekStart
        )

        XCTAssertEqual(result.status, .rejected)
        XCTAssertTrue(result.messages.contains { $0.contains("no more than 2 future sessions") })
    }

    func testAcceptsEmptyAIPlanWhenNoSelectedFutureTrainingDaysRemain() throws {
        let saturday = try XCTUnwrap(Calendar.current.date(from: DateComponents(year: 2026, month: 7, day: 4)))
        var response = CoachPlanResponse.balancedFixture()
        response.sessions = []

        let result = CoachPlanValidator().validate(
            response: response,
            baseline: Baseline(pullUps: 5, pushUps: 20, plankSeconds: 60),
            preferences: TrainingPreferences(
                weeklySessions: 1,
                trainingDays: [.saturday],
                equipment: [.pullUpBar],
                targetDate: Date(timeIntervalSinceNow: 365 * 24 * 60 * 60)
            ),
            weekStart: saturday
        )

        XCTAssertEqual(result.status, .accepted)
        XCTAssertTrue(result.messages.isEmpty)
    }

    func testAcceptsAIPlanWithoutLocalMovementBalancePolicy() {
        let response = CoachPlanResponse(
            summary: "Too narrow",
            contextState: "building",
            safetyFlags: [],
            sessions: (1...4).map {
                CoachSessionResponse(
                    title: "Pull only \($0)",
                    dayOffset: $0,
                    focus: "pull",
                    plannedEffort: .effort(label: "medium", targetRPE: 6, targetRIR: 4, stimulus: "volume"),
                    purpose: "Only pull",
                    estimatedDurationMinutes: 20,
                    progressionRationale: "No balance",
                    safetyNotes: [],
                    loggingFieldsRequired: ["pullUps"],
                    exercises: [
                        CoachExerciseResponse(exercise: "pullUp", sets: 3, reps: 3, seconds: 0, restSeconds: 120, intensity: "Moderate", plannedEffort: .effort(label: "medium", targetRPE: 6, targetRIR: 4, stimulus: "volume")),
                        CoachExerciseResponse(exercise: "deadHang", sets: 2, reps: 0, seconds: 20, restSeconds: 60, intensity: "Support", plannedEffort: .effort(label: "medium", targetRPE: 6, targetRIR: 4, stimulus: "volume"))
                    ]
                )
            }
        )

        let result = CoachPlanValidator().validate(
            response: response,
            baseline: Baseline(pullUps: 5, pushUps: 20, plankSeconds: 60),
            preferences: TrainingPreferences(
                weeklySessions: 4,
                equipment: [.pullUpBar],
                targetDate: Date(timeIntervalSinceNow: 365 * 24 * 60 * 60)
            ),
            weekStart: Date()
        )

        XCTAssertEqual(result.status, .accepted)
        XCTAssertTrue(result.messages.isEmpty)
    }

    func testRejectsAllLightAIPlanWithoutSafetyFlags() {
        var response = CoachPlanResponse.balancedFixture()
        response.contextState = "building"
        response.sessions = response.sessions.map { session in
            var updated = session
            updated.plannedEffort = .effort(label: "light", targetRPE: 3, targetRIR: 6, stimulus: "technique")
            updated.exercises = updated.exercises.map { exercise in
                var updatedExercise = exercise
                updatedExercise.plannedEffort = .effort(label: "light", targetRPE: 3, targetRIR: 6, stimulus: "technique")
                return updatedExercise
            }
            return updated
        }

        let result = CoachPlanValidator().validate(
            response: response,
            baseline: Baseline(pullUps: 5, pushUps: 20, plankSeconds: 60),
            preferences: TrainingPreferences(
                weeklySessions: 4,
                equipment: [.pullUpBar],
                targetDate: Date(timeIntervalSinceNow: 365 * 24 * 60 * 60)
            ),
            weekStart: Date()
        )

        XCTAssertEqual(result.status, .rejected)
        XCTAssertTrue(result.messages.contains { $0.contains("cannot be all light") })
    }

    func testRejectsUsefulGoalWorkBelowBaselineFloor() {
        let response = CoachPlanResponse.balancedFixture()

        let result = CoachPlanValidator().validate(
            response: response,
            baseline: Baseline(pullUps: 5, pushUps: 40, plankSeconds: 60),
            preferences: TrainingPreferences(
                weeklySessions: 4,
                equipment: [.pullUpBar],
                targetDate: Date(timeIntervalSinceNow: 365 * 24 * 60 * 60)
            ),
            weekStart: Date()
        )

        XCTAssertEqual(result.status, .rejected)
        XCTAssertTrue(result.messages.contains { $0.contains("push-up goal work is below") })
    }

    func testRejectsStaticPlanAfterCleanFlatRecentPrescriptions() {
        let weekStart = Date(timeIntervalSince1970: 14 * 24 * 60 * 60)
        let result = CoachPlanValidator().validate(
            response: .balancedFixture(),
            baseline: Baseline(pullUps: 5, pushUps: 20, plankSeconds: 60),
            preferences: TrainingPreferences(
                weeklySessions: 4,
                equipment: [.pullUpBar],
                targetDate: Date(timeIntervalSinceNow: 365 * 24 * 60 * 60)
            ),
            weekStart: weekStart,
            plannedSessions: [
                previousCoachSession(scheduledDate: Date(timeIntervalSince1970: 0)),
                previousCoachSession(scheduledDate: Date(timeIntervalSince1970: 7 * 24 * 60 * 60))
            ],
            trainingLogs: [
                cleanCoachLog(completedAt: Date(timeIntervalSince1970: 6 * 24 * 60 * 60)),
                cleanCoachLog(completedAt: Date(timeIntervalSince1970: 13 * 24 * 60 * 60))
            ]
        )

        XCTAssertEqual(result.status, .rejected)
        XCTAssertTrue(result.messages.contains { $0.contains("pull-up work repeats") })
        XCTAssertTrue(result.messages.contains { $0.contains("push-up work repeats") })
    }

    func testRejectsAIPlanWithInvalidTechnicalShape() {
        var response = CoachPlanResponse.balancedFixture()
        response.sessions[1].dayOffset = response.sessions[0].dayOffset
        response.sessions[2].loggingFieldsRequired = ["watts"]
        response.sessions[3].exercises[0] = CoachExerciseResponse(exercise: "plank", sets: 0, reps: -1, seconds: 30, restSeconds: 90, intensity: "Moderate")

        let result = CoachPlanValidator().validate(
            response: response,
            baseline: Baseline(pullUps: 5, pushUps: 20, plankSeconds: 60),
            preferences: TrainingPreferences(
                weeklySessions: 4,
                equipment: [.pullUpBar],
                targetDate: Date(timeIntervalSinceNow: 365 * 24 * 60 * 60)
            ),
            weekStart: Date()
        )

        XCTAssertEqual(result.status, .rejected)
        XCTAssertTrue(result.messages.contains { $0.contains("strictly increasing") })
        XCTAssertTrue(result.messages.contains { $0.contains("unknown logging field") })
        XCTAssertTrue(result.messages.contains { $0.contains("non-positive set count") })
        XCTAssertTrue(result.messages.contains { $0.contains("negative reps") })
    }

    func testAcceptedAIPlanConvertsToVisibleWeeklyPlan() {
        let weekStart = Date(timeIntervalSince1970: 0)
        let response = CoachPlanResponse.balancedFixture()

        let result = CoachPlanValidator().validate(
            response: response,
            baseline: Baseline(pullUps: 5, pushUps: 20, plankSeconds: 60),
            preferences: TrainingPreferences(
                weeklySessions: 4,
                equipment: [.pullUpBar],
                targetDate: Date(timeIntervalSinceNow: 365 * 24 * 60 * 60)
            ),
            weekStart: weekStart
        )
        let plan = response.weeklyPlan(weekStart: weekStart)

        XCTAssertEqual(result.status, .accepted)
        XCTAssertEqual(plan.sessions.count, 4)
        XCTAssertEqual(plan.sessions[2].date, Calendar.current.date(byAdding: .day, value: 5, to: Calendar.current.startOfDay(for: weekStart)))
        XCTAssertEqual(plan.sessions[0].estimatedDurationMinutes, 40)
        XCTAssertTrue(plan.sessions.allSatisfy { $0.summary.contains("AI:") })
    }

    func testLegacyHostedPlanWithoutPlannedEffortStillConverts() {
        let weekStart = Date(timeIntervalSince1970: 0)
        var response = CoachPlanResponse.balancedFixture()
        response.safetyFlags = ["insufficient_training_history"]
        response.sessions = response.sessions.map { session in
            var legacySession = session
            legacySession.plannedEffort = nil
            legacySession.exercises = legacySession.exercises.map { exercise in
                var legacyExercise = exercise
                legacyExercise.plannedEffort = nil
                return legacyExercise
            }
            return legacySession
        }

        let result = CoachPlanValidator().validate(
            response: response,
            baseline: Baseline(pullUps: 5, pushUps: 20, plankSeconds: 60),
            preferences: TrainingPreferences(
                weeklySessions: 4,
                equipment: [.pullUpBar],
                targetDate: Date(timeIntervalSinceNow: 365 * 24 * 60 * 60)
            ),
            weekStart: weekStart
        )
        let plan = response.weeklyPlan(weekStart: weekStart)

        XCTAssertEqual(result.status, .accepted)
        XCTAssertEqual(plan.sessions.first?.plannedEffort.label, .hard)
        XCTAssertEqual(plan.sessions.first?.blocks.first?.sets.first?.plannedEffort.label, .hard)
    }

    func testAcceptedAIPlanUsesRollingUpcomingWindow() throws {
        let calendar = Calendar.current
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 5, day: 22, hour: 13)))
        let windowStart = rollingPlanStart(date: now, calendar: calendar)
        let windowEnd = rollingPlanEnd(date: now, calendar: calendar)
        let plan = CoachPlanResponse.balancedFixture().weeklyPlan(weekStart: windowStart)

        XCTAssertEqual(plan.weekStart, windowStart)
        XCTAssertTrue(plan.sessions.allSatisfy { $0.date >= windowStart && $0.date < windowEnd })
    }

    func testMakeCoachRequestWithRaceGoalFillsRunningRequest() throws {
        let calendar = Calendar.current
        // 2026-06-08 is a Monday, so tuesday/thursday/saturday land on offsets 1/3/5.
        let weekStart = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 8)))
        let raceDate = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 9, day: 19, hour: 14, minute: 30)))
        let profile = runningProfileFixture(runningDays: [.saturday, .tuesday, .thursday], longRunDay: .saturday)
        let raceGoal = RaceGoal(
            name: "Mozart 100",
            raceDate: raceDate,
            distanceKm: 104,
            elevationGainM: 5_000,
            baselineWeeklyKm: 42,
            longestRecentRunKm: 24
        )
        let runLogs = [
            RunLog(completedAt: weekStart.addingTimeInterval(-86_400), distanceKm: 12, movingSeconds: 4_200, elevationGainM: 180, averageHr: 151, rpe: 6),
            RunLog(completedAt: weekStart.addingTimeInterval(-3 * 86_400), distanceKm: 8, movingSeconds: 2_900, elevationGainM: 60),
            RunLog(completedAt: weekStart.addingTimeInterval(-2 * 86_400), distanceKm: 21, movingSeconds: 7_600, elevationGainM: 400)
        ]

        let request = makeCoachRequest(
            profile: profile,
            modelID: "gpt-5-mini",
            logs: [],
            sessions: [],
            raceGoal: raceGoal,
            runLogs: runLogs,
            weekStart: weekStart
        )

        let running = try XCTUnwrap(request.running)
        XCTAssertEqual(running.raceGoal.name, "Mozart 100")
        XCTAssertEqual(running.raceGoal.raceDate, calendar.startOfDay(for: raceDate))
        XCTAssertEqual(calendar.dateComponents([.year, .month, .day], from: running.raceGoal.raceDate), DateComponents(year: 2026, month: 9, day: 19))
        XCTAssertEqual(running.raceGoal.distanceKm, 104)
        XCTAssertEqual(running.raceGoal.elevationGainM, 5_000)
        XCTAssertEqual(running.baselineWeeklyKm, 42)
        XCTAssertEqual(running.longestRecentRunKm, 24)
        XCTAssertEqual(running.runningDays, ["tuesday", "thursday", "saturday"])
        XCTAssertEqual(running.runningDayOffsets, [1, 3, 5])
        XCTAssertEqual(running.longRunDay, "saturday")
        XCTAssertEqual(running.longRunDayOffset, 5)
        XCTAssertEqual(running.recentRuns.count, 3)
        XCTAssertEqual(running.recentRuns.map(\.distanceKm), [8, 21, 12])
        XCTAssertNil(running.recentRuns[0].averageHr)
        XCTAssertNil(running.recentRuns[0].rpe)
        XCTAssertNil(running.recentRuns[1].rpe)
        XCTAssertEqual(running.recentRuns[1].feelScore, 3)
        XCTAssertEqual(running.recentRuns[2].averageHr, 151)
        XCTAssertEqual(running.recentRuns[2].rpe, 6)
        XCTAssertNil(running.recentRuns[2].kind)
    }

    func testMakeCoachRequestDeduplicatesGarminActivityIdsForRecentRuns() throws {
        let calendar = Calendar.current
        let weekStart = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 8)))
        let profile = runningProfileFixture(runningDays: [.tuesday, .saturday], longRunDay: .saturday)
        let runDate = weekStart.addingTimeInterval(-86_400)
        let matchedSession = WorkoutSession(
            scheduledDate: runDate,
            title: "Easy run",
            weekIndex: 1,
            focus: .mixed,
            status: .completed,
            summary: "Completed from Garmin.",
            discipline: .running
        )
        let duplicateStandalone = RunLog(
            sessionId: RunLog.unattachedSessionId,
            completedAt: runDate,
            distanceKm: 35,
            movingSeconds: 12_600,
            garminActivityId: "garmin-35k",
            source: .garmin
        )
        let matchedLog = RunLog(
            sessionId: matchedSession.id,
            completedAt: runDate,
            distanceKm: 35,
            movingSeconds: 12_600,
            averageHr: 142,
            garminActivityId: "garmin-35k",
            source: .garmin
        )

        let request = makeCoachRequest(
            profile: profile,
            modelID: "gpt-5-mini",
            logs: [],
            sessions: [matchedSession],
            raceGoal: raceGoalFixture(),
            runLogs: [duplicateStandalone, matchedLog],
            weekStart: weekStart
        )

        let running = try XCTUnwrap(request.running)
        XCTAssertEqual(running.recentRuns.count, 1)
        XCTAssertEqual(running.recentRuns.first?.distanceKm, 35)
        XCTAssertEqual(running.recentRuns.first?.averageHr, 142)
    }

    func testMakeCoachRequestCapsRecentRunsToMostRecentThirty() throws {
        // 30 runs spans roughly the 90-day activity lookback at 3-4 runs/week.
        let calendar = Calendar.current
        let weekStart = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 8)))
        let profile = runningProfileFixture(runningDays: [.tuesday, .saturday], longRunDay: .saturday)
        let runLogs = (1...35).map {
            RunLog(completedAt: weekStart.addingTimeInterval(-Double($0) * 86_400), distanceKm: Double($0), movingSeconds: 3_600)
        }

        let request = makeCoachRequest(
            profile: profile,
            modelID: "gpt-5-mini",
            logs: [],
            sessions: [],
            raceGoal: raceGoalFixture(),
            runLogs: runLogs.shuffled(),
            weekStart: weekStart
        )

        let running = try XCTUnwrap(request.running)
        XCTAssertEqual(running.recentRuns.count, 30)
        XCTAssertEqual(running.recentRuns.first?.distanceKm, 30)
        XCTAssertEqual(running.recentRuns.last?.distanceKm, 1)
    }

    func testMakeCoachRequestCarriesElevationLossNilWhenZero() throws {
        let calendar = Calendar.current
        let weekStart = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 8)))
        let profile = runningProfileFixture(runningDays: [.tuesday, .saturday], longRunDay: .saturday)
        let runLogs = [
            RunLog(completedAt: weekStart.addingTimeInterval(-86_400), distanceKm: 14, movingSeconds: 5_400, elevationGainM: 420, elevationLossM: 410),
            RunLog(completedAt: weekStart.addingTimeInterval(-2 * 86_400), distanceKm: 6, movingSeconds: 2_100)
        ]

        let request = makeCoachRequest(
            profile: profile,
            modelID: "gpt-5-mini",
            logs: [],
            sessions: [],
            raceGoal: raceGoalFixture(),
            runLogs: runLogs,
            weekStart: weekStart
        )

        let runs = try XCTUnwrap(request.running).recentRuns
        XCTAssertEqual(runs.last?.elevationLossM, 410)
        XCTAssertNil(runs.first?.elevationLossM)
    }

    func testMakeCoachRequestOmitsLongRunDayOffsetOutsidePlannableRange() throws {
        let calendar = Calendar.current
        // weekStart is a Monday, so monday maps to offset 0 and gets dropped everywhere.
        let weekStart = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 8)))
        let profile = runningProfileFixture(runningDays: [.monday, .wednesday], longRunDay: .monday)

        let request = makeCoachRequest(
            profile: profile,
            modelID: "gpt-5-mini",
            logs: [],
            sessions: [],
            raceGoal: raceGoalFixture(),
            runLogs: [],
            weekStart: weekStart
        )

        let running = try XCTUnwrap(request.running)
        XCTAssertEqual(running.runningDays, ["monday", "wednesday"])
        XCTAssertEqual(running.runningDayOffsets, [2])
        XCTAssertEqual(running.longRunDay, "monday")
        XCTAssertNil(running.longRunDayOffset)
        XCTAssertTrue(running.recentRuns.isEmpty)
    }

    func testMakeCoachRequestWithEmptyRunningDaysStaysUnconstrained() throws {
        let calendar = Calendar.current
        let weekStart = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 8)))
        let profile = runningProfileFixture(runningDays: [], longRunDay: .saturday)

        let request = makeCoachRequest(
            profile: profile,
            modelID: "gpt-5-mini",
            logs: [],
            sessions: [],
            raceGoal: raceGoalFixture(),
            runLogs: [],
            weekStart: weekStart
        )

        let running = try XCTUnwrap(request.running)
        XCTAssertEqual(running.runningDays, [])
        XCTAssertEqual(running.runningDayOffsets, [])
        XCTAssertNil(running.longRunDay)
        XCTAssertNil(running.longRunDayOffset)
    }

    func testMakeCoachRequestOmitsLongRunDayOutsideRunningDays() throws {
        let calendar = Calendar.current
        // 2026-06-08 is a Monday, so tuesday/saturday land on offsets 1/5.
        let weekStart = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 8)))
        let profile = runningProfileFixture(runningDays: [.tuesday, .saturday], longRunDay: .sunday)

        let request = makeCoachRequest(
            profile: profile,
            modelID: "gpt-5-mini",
            logs: [],
            sessions: [],
            raceGoal: raceGoalFixture(),
            runLogs: [],
            weekStart: weekStart
        )

        let running = try XCTUnwrap(request.running)
        XCTAssertEqual(running.runningDays, ["tuesday", "saturday"])
        XCTAssertEqual(running.runningDayOffsets, [1, 5])
        XCTAssertNil(running.longRunDay)
        XCTAssertNil(running.longRunDayOffset)
    }

    func testMakeCoachRequestWithoutRaceGoalLeavesRunningNil() throws {
        let profile = runningProfileFixture(runningDays: [.tuesday, .saturday], longRunDay: .saturday)

        let request = makeCoachRequest(
            profile: profile,
            modelID: "gpt-5-mini",
            logs: [],
            sessions: [],
            weekStart: currentWeekStart()
        )

        XCTAssertNil(request.running)
        let data = try JSONEncoder.coachEncoder.encode(request)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(object["running"])
    }

    func testRunningWeekValidatorRejectsInvalidTechnicalShape() {
        var week = RunningWeekResponse.ultraFixture()
        week.sessions[0].dayOffset = 0
        week.sessions[1].kind = "sprint"
        week.sessions[2].dayOffset = week.sessions[1].dayOffset
        week.sessions[2].target = RunTargetResponse(type: "pace", low: 420, high: 360)
        week.sessions[2].distanceKm = -2

        let result = RunningWeekValidator().validate(response: week, allowedDayOffsets: [])

        XCTAssertEqual(result.status, .rejected)
        XCTAssertTrue(result.messages.contains { $0.contains("day offset 0 is today") })
        XCTAssertTrue(result.messages.contains { $0.contains("unknown kind") })
        XCTAssertTrue(result.messages.contains { $0.contains("strictly increasing") })
        XCTAssertTrue(result.messages.contains { $0.contains("target range") })
        XCTAssertTrue(result.messages.contains { $0.contains("negative") })
    }

    func testRunningWeekValidatorRejectsRunsOutsideSelectedDays() {
        let week = RunningWeekResponse.ultraFixture()

        let result = RunningWeekValidator().validate(response: week, allowedDayOffsets: [1, 5])

        XCTAssertEqual(result.status, .rejected)
        XCTAssertTrue(result.messages.contains { $0.contains("non-running day") })
    }

    func testRunningWeekValidatorAcceptsValidWeekOnAllowedOffsets() {
        let week = RunningWeekResponse.ultraFixture()

        let result = RunningWeekValidator().validate(response: week, allowedDayOffsets: [1, 3, 5])

        XCTAssertEqual(result.status, .accepted)
        XCTAssertTrue(result.messages.isEmpty)
    }

    func testRunningWeekValidatorAcceptsValidWeekWithoutSelectedDays() {
        let week = RunningWeekResponse.ultraFixture()

        let result = RunningWeekValidator().validate(response: week, allowedDayOffsets: [])

        XCTAssertFalse(result.messages.contains { $0.contains("non-running day") })
        XCTAssertEqual(result.status, .accepted)
        XCTAssertTrue(result.messages.isEmpty)
    }

    func testCombinedWeekResponseDecodesProxyShape() throws {
        let json = """
        {
          "summary": "Running and strength stay coordinated.",
          "safetyFlags": ["hard_day_collision"],
          "runningWeek": {
            "summary": "Base week with one quality session.",
            "safetyFlags": [],
            "sessions": [
              {
                "title": "Easy aerobic run",
                "dayOffset": 1,
                "kind": "easy",
                "purpose": "Aerobic base without fatigue.",
                "distanceKm": 8.5,
                "durationMinutes": 55,
                "elevationMeters": 120,
                "target": { "type": "hr", "low": 130, "high": 145 },
                "zone": "Z2",
                "notes": ["Keep it conversational."]
              },
              {
                "title": "Hilly long run",
                "dayOffset": 5,
                "kind": "long",
                "purpose": "Time on feet with climbing.",
                "distanceKm": 22,
                "durationMinutes": 150,
                "elevationMeters": 800,
                "target": { "type": "pace", "low": 360, "high": 420 },
                "zone": "Z2",
                "notes": ["Hike the steep climbs."]
              }
            ]
          },
          "strengthWeek": {
            "summary": "Strength holds during the running build.",
            "contextState": "building",
            "safetyFlags": [],
            "sessions": [
              {
                "title": "Pull emphasis",
                "dayOffset": 2,
                "focus": "pull",
                "plannedEffort": { "label": "hard", "targetRPE": 7, "targetRIR": 3, "stimulus": "strength", "reason": "Build pull capacity." },
                "purpose": "Build strict pull-up capacity.",
                "estimatedDurationMinutes": 35,
                "progressionRationale": "Volume stays below the cap.",
                "safetyNotes": ["Stop before form breaks."],
                "loggingFieldsRequired": ["pullUps"],
                "exercises": [
                  {
                    "exercise": "pullUp",
                    "sets": 4,
                    "reps": 3,
                    "seconds": 0,
                    "restSeconds": 120,
                    "intensity": "Hard",
                    "plannedEffort": { "label": "hard", "targetRPE": 7, "targetRIR": 3, "stimulus": "strength", "reason": "Build pull capacity." }
                  }
                ]
              }
            ]
          }
        }
        """

        let combined = try JSONDecoder.coachDecoder.decode(CombinedWeekResponse.self, from: Data(json.utf8))

        XCTAssertEqual(combined.summary, "Running and strength stay coordinated.")
        XCTAssertEqual(combined.safetyFlags, ["hard_day_collision"])
        XCTAssertEqual(combined.runningWeek.summary, "Base week with one quality session.")
        XCTAssertEqual(combined.runningWeek.sessions.count, 2)
        XCTAssertEqual(combined.runningWeek.sessions[0].kind, "easy")
        XCTAssertEqual(combined.runningWeek.sessions[0].target, RunTargetResponse(type: "hr", low: 130, high: 145))
        XCTAssertEqual(combined.runningWeek.sessions[1].distanceKm, 22)
        XCTAssertEqual(combined.runningWeek.sessions[1].elevationMeters, 800)
        XCTAssertEqual(combined.runningWeek.sessions[1].notes, ["Hike the steep climbs."])
        XCTAssertEqual(combined.strengthWeek.contextState, "building")
        XCTAssertEqual(combined.strengthWeek.sessions.count, 1)
        XCTAssertEqual(combined.strengthWeek.sessions.first?.plannedEffort?.label, "hard")
        XCTAssertEqual(combined.strengthWeek.sessions.first?.exercises.first?.exercise, "pullUp")
    }

    func testGarminStatusResponseDecodesProxyShape() throws {
        let degradedJSON = """
        { "ok": false, "userId": "user-1", "loggedIn": true, "state": "connected", "connectedEmail": "runner@example.com", "lastError": "Garmin service timed out." }
        """

        let degraded = try JSONDecoder.coachDecoder.decode(GarminStatusResponse.self, from: Data(degradedJSON.utf8))

        XCTAssertFalse(degraded.ok)
        XCTAssertEqual(degraded.userId, "user-1")
        XCTAssertTrue(degraded.loggedIn)
        XCTAssertEqual(degraded.state, .connected)
        XCTAssertEqual(degraded.connectedEmail, "runner@example.com")
        XCTAssertEqual(degraded.lastError, "Garmin service timed out.")

        let healthyJSON = """
        { "ok": true, "loggedIn": false, "state": "mfa_required", "connectedEmail": null, "lastError": null }
        """

        let healthy = try JSONDecoder.coachDecoder.decode(GarminStatusResponse.self, from: Data(healthyJSON.utf8))

        XCTAssertTrue(healthy.ok)
        XCTAssertFalse(healthy.loggedIn)
        XCTAssertEqual(healthy.state, .mfaRequired)
        XCTAssertEqual(healthy.displayState.text, "MFA needed")
        XCTAssertNil(healthy.lastError)
    }

    func testGarminSnapshotResponseDecodesProxyShape() throws {
        let json = """
        {
          "status": { "ok": true, "loggedIn": true, "lastError": null },
          "wellness": [
            {
              "date": "2026-06-08",
              "sleepScore": 82,
              "sleepSeconds": 27360,
              "hrvStatus": "BALANCED",
              "hrvMs": 52,
              "bodyBattery": 71,
              "trainingReadiness": 64,
              "restingHr": 47
            }
          ],
          "activities": [
            {
              "garminActivityId": "19519498613",
              "startTime": "2026-06-08 07:01:33",
              "activityType": "trail_running",
              "distanceKm": 12.03,
              "movingSeconds": 4480,
              "elevationGainM": 156,
              "elevationLossM": 142,
              "averageHr": 148,
              "averagePaceSecPerKm": 374,
              "name": "Utrecht Hardlopen"
            }
          ]
        }
        """

        let snapshot = try JSONDecoder.coachDecoder.decode(GarminSnapshotResponse.self, from: Data(json.utf8))

        XCTAssertTrue(snapshot.status.ok)
        XCTAssertTrue(snapshot.status.loggedIn)
        XCTAssertNil(snapshot.status.lastError)
        XCTAssertEqual(snapshot.wellness.count, 1)
        let day = try XCTUnwrap(snapshot.wellness.first)
        XCTAssertEqual(day.date, "2026-06-08")
        XCTAssertEqual(day.sleepScore, 82)
        XCTAssertEqual(day.sleepSeconds, 27_360)
        XCTAssertEqual(day.hrvStatus, "BALANCED")
        XCTAssertEqual(day.hrvMs, 52)
        XCTAssertEqual(day.bodyBattery, 71)
        XCTAssertEqual(day.trainingReadiness, 64)
        XCTAssertEqual(day.restingHr, 47)
        XCTAssertEqual(snapshot.activities.count, 1)
        let activity = try XCTUnwrap(snapshot.activities.first)
        XCTAssertEqual(activity.garminActivityId, "19519498613")
        XCTAssertEqual(activity.startTime, "2026-06-08 07:01:33")
        XCTAssertEqual(activity.activityType, "trail_running")
        XCTAssertEqual(activity.distanceKm, 12.03)
        XCTAssertEqual(activity.movingSeconds, 4_480)
        XCTAssertEqual(activity.elevationGainM, 156)
        XCTAssertEqual(activity.elevationLossM, 142)
        XCTAssertEqual(activity.averageHr, 148)
        XCTAssertEqual(activity.averagePaceSecPerKm, 374)
        XCTAssertEqual(activity.name, "Utrecht Hardlopen")
    }

    func testGarminSnapshotResponseDecodesTruncatedWellness() throws {
        let json = """
        {
          "status": { "ok": false, "loggedIn": true, "lastError": "throttled" },
          "wellness": [],
          "activities": []
        }
        """

        let snapshot = try JSONDecoder.coachDecoder.decode(GarminSnapshotResponse.self, from: Data(json.utf8))

        XCTAssertFalse(snapshot.status.ok)
        XCTAssertEqual(snapshot.status.lastError, "throttled")
        XCTAssertTrue(snapshot.wellness.isEmpty)
        XCTAssertTrue(snapshot.activities.isEmpty)
    }

    func testGarminPushWorkoutsBuildsSidecarPayloadFromPlannedRunningSessions() throws {
        let calendar = Calendar.current
        let runDate = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 13, hour: 9)))
        let plannedRun = WorkoutSession(
            scheduledDate: runDate,
            title: "Hilly long run",
            weekIndex: 0,
            focus: .mixed,
            summary: "AI: Build durability on climbs.",
            estimatedDurationMinutes: 150,
            discipline: .running,
            runKind: .long,
            plannedDistanceKm: 22,
            plannedElevationM: 800,
            runTargetType: .pace,
            runTargetLow: 360,
            runTargetHigh: 390,
            runZone: "Z2"
        )
        let completedRun = WorkoutSession(
            scheduledDate: runDate,
            title: "Already done run",
            weekIndex: 0,
            focus: .mixed,
            status: .completed,
            summary: "AI: Done.",
            discipline: .running,
            runKind: .easy
        )
        let plannedStrength = WorkoutSession(
            scheduledDate: runDate,
            title: "Pull day",
            weekIndex: 0,
            focus: .pull,
            summary: "AI: Strength."
        )

        let workouts = garminPushWorkouts(from: [plannedStrength, completedRun, plannedRun])

        XCTAssertEqual(workouts.count, 1, "Only planned running sessions are pushable")
        let workout = try XCTUnwrap(workouts.first)
        XCTAssertEqual(workout.sessionId, plannedRun.id.uuidString)
        XCTAssertEqual(workout.title, "Hilly long run")
        XCTAssertEqual(workout.date, "2026-06-13", "The sidecar schedules by calendar date")
        XCTAssertEqual(workout.kind, "long")
        XCTAssertEqual(workout.distanceKm, 22)
        XCTAssertEqual(workout.durationMinutes, 150)
        XCTAssertEqual(workout.target, GarminPushTarget(type: "pace", low: 360, high: 390))
        XCTAssertEqual(workout.notes, "Z2")
    }

    func testGarminPushWorkoutsKeepsUnsetTargetEmptyForSidecar() throws {
        // build_workout treats an empty target type as no.target, so an unset
        // app-side target must stay empty instead of inventing a pace range.
        let zonelessEasyRun = WorkoutSession(
            scheduledDate: Date(),
            title: "Easy shakeout",
            weekIndex: 0,
            focus: .mixed,
            summary: "AI: Keep it light.",
            estimatedDurationMinutes: 30,
            discipline: .running,
            runKind: .easy
        )

        let workout = try XCTUnwrap(garminPushWorkouts(from: [zonelessEasyRun]).first)

        XCTAssertEqual(workout.target, GarminPushTarget(type: "", low: 0, high: 0))
        XCTAssertEqual(workout.notes, "")
    }

    func testGarminPushRequestEncodesSidecarContract() throws {
        let request = GarminPushRequest(workouts: [
            GarminPushWorkout(
                sessionId: "9E5B2C1A-0000-0000-0000-000000000001",
                title: "Tempo run",
                date: "2026-06-12",
                kind: "tempo",
                distanceKm: 8,
                durationMinutes: 45,
                target: GarminPushTarget(type: "hr", low: 150, high: 162),
                notes: "Z3"
            )
        ])

        let data = try JSONEncoder.coachEncoder.encode(request)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let workouts = try XCTUnwrap(object["workouts"] as? [[String: Any]])
        let workout = try XCTUnwrap(workouts.first)

        XCTAssertEqual(workout["sessionId"] as? String, "9E5B2C1A-0000-0000-0000-000000000001")
        XCTAssertEqual(workout["title"] as? String, "Tempo run")
        XCTAssertEqual(workout["date"] as? String, "2026-06-12")
        XCTAssertEqual(workout["kind"] as? String, "tempo")
        XCTAssertEqual(workout["distanceKm"] as? Double, 8)
        XCTAssertEqual(workout["durationMinutes"] as? Int, 45)
        XCTAssertEqual(workout["notes"] as? String, "Z3")
        let target = try XCTUnwrap(workout["target"] as? [String: Any])
        XCTAssertEqual(target["type"] as? String, "hr")
        XCTAssertEqual(target["low"] as? Int, 150)
        XCTAssertEqual(target["high"] as? Int, 162)
    }

    func testGarminPushResponseDecodesProxyShape() throws {
        let json = """
        {
          "results": [
            { "sessionId": "A", "garminWorkoutId": "1290881234", "scheduled": true, "error": null },
            { "sessionId": "B", "garminWorkoutId": null, "scheduled": false, "error": "not logged in" }
          ]
        }
        """

        let response = try JSONDecoder.coachDecoder.decode(GarminPushResponse.self, from: Data(json.utf8))

        XCTAssertNil(response.error)
        XCTAssertEqual(response.results.count, 2)
        XCTAssertEqual(response.results[0].sessionId, "A")
        XCTAssertEqual(response.results[0].garminWorkoutId, "1290881234")
        XCTAssertTrue(response.results[0].scheduled)
        XCTAssertNil(response.results[0].error)
        XCTAssertNil(response.results[1].garminWorkoutId)
        XCTAssertFalse(response.results[1].scheduled)
        XCTAssertEqual(response.results[1].error, "not logged in")

        let degradedJSON = """
        { "results": [], "error": "Garmin service is not reachable." }
        """

        let degraded = try JSONDecoder.coachDecoder.decode(GarminPushResponse.self, from: Data(degradedJSON.utf8))

        XCTAssertTrue(degraded.results.isEmpty)
        XCTAssertEqual(degraded.error, "Garmin service is not reachable.")
    }

    func testApplyGarminPushResultsStampsOnlyScheduledMatches() {
        let scheduledRun = WorkoutSession(
            scheduledDate: Date(),
            title: "Tempo run",
            weekIndex: 0,
            focus: .mixed,
            summary: "AI: Quality.",
            discipline: .running,
            runKind: .tempo
        )
        let failedRun = WorkoutSession(
            scheduledDate: Date(),
            title: "Easy run",
            weekIndex: 0,
            focus: .mixed,
            summary: "AI: Recovery.",
            discipline: .running,
            runKind: .easy
        )
        let stampDate = Date(timeIntervalSince1970: 1_750_000_000)
        let results = [
            GarminPushResultItem(sessionId: scheduledRun.id.uuidString, garminWorkoutId: "1290881234", scheduled: true, error: nil),
            GarminPushResultItem(sessionId: failedRun.id.uuidString, garminWorkoutId: nil, scheduled: false, error: "not logged in"),
            GarminPushResultItem(sessionId: UUID().uuidString, garminWorkoutId: "777", scheduled: true, error: nil)
        ]

        let applied = applyGarminPushResults(results, to: [scheduledRun, failedRun], at: stampDate)

        XCTAssertEqual(applied, 1, "Only the scheduled result with a matching session is applied")
        XCTAssertEqual(scheduledRun.garminWorkoutId, "1290881234")
        XCTAssertEqual(scheduledRun.pushedToGarminAt, stampDate)
        XCTAssertTrue(failedRun.garminWorkoutId.isEmpty, "Failed results must not stamp the session")
        XCTAssertNil(failedRun.pushedToGarminAt)
    }

    func testGarminSyncWorkoutsIncludesExistingGarminWorkoutIdForAdoption() throws {
        let runDate = try XCTUnwrap(Calendar.current.date(from: DateComponents(year: 2026, month: 6, day: 16, hour: 9)))
        let plannedRun = WorkoutSession(
            scheduledDate: runDate,
            title: "Steady run",
            weekIndex: 0,
            focus: .mixed,
            summary: "AI: Keep it smooth.",
            estimatedDurationMinutes: 50,
            discipline: .running,
            runKind: .easy,
            plannedDistanceKm: 8,
            garminWorkoutId: "existing-9001",
            pushedToGarminAt: Date(timeIntervalSince1970: 1_750_000_000)
        )

        let workout = try XCTUnwrap(garminSyncWorkouts(from: [plannedRun]).first)

        XCTAssertEqual(workout.sessionId, plannedRun.id.uuidString)
        XCTAssertEqual(workout.existingGarminWorkoutId, "existing-9001")
        XCTAssertEqual(workout.date, "2026-06-16")
    }

    func testGarminSyncResponseDecodesProxyShape() throws {
        let json = """
        {
          "userId": "user-1",
          "planRevisionId": "plan-1",
          "status": "blocked_on_delete",
          "message": "Replacing Garmin workouts after old ones are removed.",
          "workouts": [
            { "sessionId": "A", "status": "synced", "garminWorkoutId": "1290881234", "error": null, "pushedAt": "2026-06-13T09:30:00.000Z" },
            { "sessionId": "B", "status": "failed", "garminWorkoutId": null, "error": "not logged in", "pushedAt": null }
          ],
          "pendingDeleteCount": 1,
          "failedDeleteCount": 0,
          "nextRetryAt": null,
          "lastError": "Old Garmin workouts must be removed before replacements can be created."
        }
        """

        let response = try JSONDecoder.coachDecoder.decode(GarminSyncPlanResponse.self, from: Data(json.utf8))

        XCTAssertEqual(response.status, .blockedOnDelete)
        XCTAssertEqual(response.workouts.count, 2)
        XCTAssertEqual(response.workouts[0].status, .synced)
        XCTAssertEqual(response.workouts[1].status, .failed)
        XCTAssertEqual(response.pendingDeleteCount, 1)
    }

    func testApplyGarminSyncResultsStampsSyncedAndFailedStatuses() {
        let syncedRun = WorkoutSession(
            scheduledDate: Date(),
            title: "Tempo run",
            weekIndex: 0,
            focus: .mixed,
            summary: "AI: Quality.",
            discipline: .running,
            runKind: .tempo
        )
        let failedRun = WorkoutSession(
            scheduledDate: Date(),
            title: "Easy run",
            weekIndex: 0,
            focus: .mixed,
            summary: "AI: Recovery.",
            discipline: .running,
            runKind: .easy
        )
        let stampDate = Date(timeIntervalSince1970: 1_750_100_000)
        let results = [
            GarminSyncWorkoutStatus(
                sessionId: syncedRun.id.uuidString,
                status: .synced,
                garminWorkoutId: "1290881234",
                error: nil,
                pushedAt: "2026-06-13T09:30:00Z"
            ),
            GarminSyncWorkoutStatus(
                sessionId: failedRun.id.uuidString,
                status: .failed,
                garminWorkoutId: nil,
                error: "not logged in",
                pushedAt: nil
            )
        ]

        let applied = applyGarminSyncResults(results, to: [syncedRun, failedRun], at: stampDate)

        XCTAssertEqual(applied, 2)
        XCTAssertEqual(syncedRun.garminWorkoutId, "1290881234")
        XCTAssertEqual(syncedRun.garminSyncStatus, .synced)
        XCTAssertNotNil(syncedRun.pushedToGarminAt)
        XCTAssertEqual(failedRun.garminSyncStatus, .failed)
        XCTAssertEqual(failedRun.garminSyncError, "not logged in")
        XCTAssertTrue(failedRun.garminWorkoutId.isEmpty)
    }

    func testGarminDeleteResponseDecodesProxyShape() throws {
        let json = """
        {
          "results": [
            { "workoutId": "1290881234", "deleted": true, "error": null },
            { "workoutId": "1290889999", "deleted": false, "error": "API Error 500" }
          ]
        }
        """

        let response = try JSONDecoder.coachDecoder.decode(GarminDeleteResponse.self, from: Data(json.utf8))

        XCTAssertNil(response.error)
        XCTAssertEqual(response.results.count, 2)
        XCTAssertEqual(response.results[0].workoutId, "1290881234")
        XCTAssertTrue(response.results[0].deleted)
        XCTAssertNil(response.results[0].error)
        XCTAssertFalse(response.results[1].deleted)
        XCTAssertEqual(response.results[1].error, "API Error 500")

        let degradedJSON = """
        { "results": [], "error": "Garmin service timed out." }
        """

        let degraded = try JSONDecoder.coachDecoder.decode(GarminDeleteResponse.self, from: Data(degradedJSON.utf8))

        XCTAssertTrue(degraded.results.isEmpty)
        XCTAssertEqual(degraded.error, "Garmin service timed out.")
    }

    func testMakeCoachRequestMapsRunFeelScoreToCoachSummaries() throws {
        let calendar = Calendar.current
        let weekStart = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 8)))
        let profile = runningProfileFixture(runningDays: [.tuesday, .saturday], longRunDay: .saturday)
        let runLogs = [
            RunLog(completedAt: weekStart.addingTimeInterval(-2 * 86_400), distanceKm: 30, movingSeconds: 12_000, rpe: 9, feelScore: 1),
            RunLog(completedAt: weekStart.addingTimeInterval(-86_400), distanceKm: 6, movingSeconds: 2_400, feelScore: 0)
        ]

        let request = makeCoachRequest(
            profile: profile,
            modelID: "gpt-5-mini",
            logs: [],
            sessions: [],
            raceGoal: raceGoalFixture(),
            runLogs: runLogs,
            weekStart: weekStart
        )

        let running = try XCTUnwrap(request.running)
        XCTAssertEqual(running.recentRuns.count, 2)
        XCTAssertEqual(running.recentRuns[0].feelScore, 1, "A catastrophic run feel must reach the coach")
        XCTAssertNil(running.recentRuns[1].feelScore, "Unset feel (0) is omitted instead of sent as 0")
    }
}

private func coachVerdictFixture(sourceLogId: UUID?, createdAt: Date) -> CoachVerdict {
    CoachVerdict(
        createdAt: createdAt,
        sourceLogId: sourceLogId,
        headline: "Current",
        summary: "Summary",
        latestChange: "Latest change",
        recommendation: "Recommendation",
        shouldUpdatePlan: false,
        contextState: "building",
        safetyFlags: []
    )
}

private func previousCoachSession(scheduledDate: Date) -> CoachPlannedSession {
    CoachPlannedSession(
        id: UUID().uuidString,
        scheduledDate: scheduledDate,
        title: "Previous flat work",
        focus: "mixed",
        status: "completed",
        exercises: [
            CoachPlannedExercisePrescription(
                exercise: "pullUp",
                sets: 4,
                targetReps: 3,
                targetSeconds: 0,
                plannedEffortLabel: "hard",
                plannedEffortStimulus: "strength"
            ),
            CoachPlannedExercisePrescription(
                exercise: "pushUp",
                sets: 3,
                targetReps: 10,
                targetSeconds: 0,
                plannedEffortLabel: "medium",
                plannedEffortStimulus: "volume"
            )
        ]
    )
}

private func cleanCoachLog(completedAt: Date) -> CoachLog {
    CoachLog(
        id: UUID().uuidString,
        sessionId: UUID().uuidString,
        completedAt: completedAt,
        pullUps: 5,
        pushUps: 20,
        plankSeconds: 60,
        loggedPullUps: true,
        loggedPushUps: true,
        loggedPlankSeconds: true,
        rpe: 6,
        painLevel: 0,
        fatigueLevel: 5,
        notes: "",
        plannedRPE: 7,
        actualRPE: 6,
        rpeDelta: -1,
        rpeSummary: "RPE - Planned 7 | Actual 6",
        plannedEffortLabel: "hard",
        plannedEffortReason: "Clean build work."
    )
}

private func runningProfileFixture(runningDays: Set<TrainingWeekday>, longRunDay: TrainingWeekday?) -> UserProfile {
    let profile = UserProfile(
        targetDate: Date(timeIntervalSince1970: 86_400),
        weeklySessions: 2,
        equipment: [.pullUpBar],
        baselinePullUps: 3,
        baselinePushUps: 15,
        baselinePlankSeconds: 45
    )
    profile.runningDays = runningDays
    profile.longRunDay = longRunDay
    return profile
}

private func raceGoalFixture() -> RaceGoal {
    RaceGoal(
        name: "Mozart 100",
        raceDate: Date(timeIntervalSince1970: 1_789_776_000),
        distanceKm: 104,
        elevationGainM: 5_000,
        baselineWeeklyKm: 42,
        longestRecentRunKm: 24
    )
}

extension RunningWeekResponse {
    static func ultraFixture() -> RunningWeekResponse {
        RunningWeekResponse(
            summary: "Base week with one quality session.",
            safetyFlags: [],
            sessions: [
                .runFixture(title: "Easy aerobic run", dayOffset: 1, kind: "easy"),
                .runFixture(title: "Hill strides", dayOffset: 3, kind: "hills"),
                .runFixture(title: "Hilly long run", dayOffset: 5, kind: "long")
            ]
        )
    }
}

extension RunSessionResponse {
    static func runFixture(title: String, dayOffset: Int, kind: String) -> RunSessionResponse {
        RunSessionResponse(
            title: title,
            dayOffset: dayOffset,
            kind: kind,
            purpose: "Build aerobic capacity toward the race.",
            distanceKm: 10,
            durationMinutes: 60,
            elevationMeters: 150,
            target: RunTargetResponse(type: "hr", low: 130, high: 148),
            zone: "Z2",
            notes: ["Keep it conversational."]
        )
    }
}

extension CoachPlanResponse {
    static func balancedFixture() -> CoachPlanResponse {
        CoachPlanResponse(
            summary: "Balanced AI week",
            contextState: "building",
            safetyFlags: [],
            sessions: [
                mixedFixture(title: "Full-body base", dayOffset: 1),
                CoachSessionResponse(
                    title: "Pull emphasis",
                    dayOffset: 3,
                    focus: "pull",
                    plannedEffort: .effort(label: "hard", targetRPE: 7, targetRIR: 3, stimulus: "strength"),
                    purpose: "Build strict pull-up capacity with core support.",
                    estimatedDurationMinutes: 35,
                    progressionRationale: "Pull volume stays below the strict cap.",
                    safetyNotes: ["Stop before form breaks."],
                    loggingFieldsRequired: ["pullUps", "plankSeconds"],
                    exercises: [
                        CoachExerciseResponse(exercise: "pullUp", sets: 4, reps: 3, seconds: 0, restSeconds: 120, intensity: "Hard", plannedEffort: .effort(label: "hard", targetRPE: 7, targetRIR: 3, stimulus: "strength")),
                        CoachExerciseResponse(exercise: "plank", sets: 3, reps: 0, seconds: 30, restSeconds: 75, intensity: "Medium", plannedEffort: .effort(label: "medium", targetRPE: 6, targetRIR: 4, stimulus: "volume"))
                    ]
                ),
                mixedFixture(title: "Full-body practice", dayOffset: 5),
                CoachSessionResponse(
                    title: "Core and push support",
                    dayOffset: 6,
                    focus: "core",
                    plannedEffort: .effort(label: "medium", targetRPE: 6, targetRIR: 4, stimulus: "volume"),
                    purpose: "Keep trunk endurance moving while adding light push support.",
                    estimatedDurationMinutes: 30,
                    progressionRationale: "Core work is submaximal and supported by easy push volume.",
                    safetyNotes: ["Keep breathing steady."],
                    loggingFieldsRequired: ["pushUps", "plankSeconds"],
                    exercises: [
                        CoachExerciseResponse(exercise: "plank", sets: 4, reps: 0, seconds: 30, restSeconds: 90, intensity: "Medium", plannedEffort: .effort(label: "medium", targetRPE: 6, targetRIR: 4, stimulus: "volume")),
                        CoachExerciseResponse(exercise: "pushUp", sets: 3, reps: 8, seconds: 0, restSeconds: 75, intensity: "Light", plannedEffort: .effort(label: "light", targetRPE: 4, targetRIR: 5, stimulus: "technique"))
                    ]
                )
            ]
        )
    }

    static func mixedFixture(title: String, dayOffset: Int) -> CoachSessionResponse {
        CoachSessionResponse(
            title: title,
            dayOffset: dayOffset,
            focus: "mixed",
            plannedEffort: .effort(label: "hard", targetRPE: 7, targetRIR: 3, stimulus: "volume"),
            purpose: "Train pull, push, and core without chasing failure.",
            estimatedDurationMinutes: 40,
            progressionRationale: "All goal movements stay below current working caps.",
            safetyNotes: ["Leave clean reps in reserve."],
            loggingFieldsRequired: ["pullUps", "pushUps", "plankSeconds"],
            exercises: [
                CoachExerciseResponse(exercise: "pullUp", sets: 3, reps: 3, seconds: 0, restSeconds: 120, intensity: "Hard", plannedEffort: .effort(label: "hard", targetRPE: 7, targetRIR: 3, stimulus: "strength")),
                CoachExerciseResponse(exercise: "pushUp", sets: 3, reps: 10, seconds: 0, restSeconds: 90, intensity: "Medium", plannedEffort: .effort(label: "medium", targetRPE: 6, targetRIR: 4, stimulus: "volume")),
                CoachExerciseResponse(exercise: "plank", sets: 3, reps: 0, seconds: 30, restSeconds: 75, intensity: "Medium", plannedEffort: .effort(label: "medium", targetRPE: 6, targetRIR: 4, stimulus: "volume"))
            ]
        )
    }
}

private extension CoachPlannedEffortResponse {
    static func effort(label: String, targetRPE: Int, targetRIR: Int, stimulus: String) -> CoachPlannedEffortResponse {
        CoachPlannedEffortResponse(
            label: label,
            targetRPE: targetRPE,
            targetRIR: targetRIR,
            stimulus: stimulus,
            reason: "\(label) \(stimulus) work"
        )
    }
}
