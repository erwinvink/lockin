import XCTest
@testable import FitnessApp

final class CoachValidationTests: XCTestCase {
    func testProxyUnavailableErrorExplainsHostedProxyChecks() throws {
        let endpoint = try XCTUnwrap(URL(string: LocalCoachClient.defaultEndpointString))
        let error = CoachClientError.proxyUnavailable(endpoint, URLError(.cannotConnectToHost))
        let message = try XCTUnwrap(error.errorDescription)

        XCTAssertTrue(message.contains("hosted coach proxy is not reachable"))
        XCTAssertTrue(message.contains("Coolify deployment"))
        XCTAssertTrue(message.contains("https://lockin.elevenfactor.com"))
    }

    func testMissingAPIKeyErrorExplainsProxyEnvironment() {
        let error = CoachClientError.invalidStatus(500, "OPENAI_API_KEY is not set")
        let message = error.localizedDescription

        XCTAssertTrue(message.contains("OPENAI_API_KEY is not set"))
        XCTAssertTrue(message.contains("Coolify environment variables"))
    }

    func testCoachClientDefaultsToHostedProxy() throws {
        let client = try LocalCoachClient()

        XCTAssertEqual(client.endpoint.absoluteString, "https://lockin.elevenfactor.com/generate-week-plan")
    }

    func testCoachClientNormalizesBareHostedProxyHost() throws {
        let client = try LocalCoachClient(endpointString: "lockin.elevenfactor.com")

        XCTAssertEqual(client.endpoint.absoluteString, "https://lockin.elevenfactor.com/generate-week-plan")
    }

    func testCoachClientRejectsNonHostedProxyHosts() {
        XCTAssertThrowsError(try LocalCoachClient(endpointString: "127.0.0.1:8787"))
        XCTAssertThrowsError(try LocalCoachClient(endpointString: "http://localhost:8787/generate-week-plan"))
        XCTAssertThrowsError(try LocalCoachClient(endpointString: "http://172.20.10.3:8790/generate-week-plan"))
        XCTAssertThrowsError(try LocalCoachClient(endpointString: "http://lockin.elevenfactor.com/generate-week-plan"))
    }

    func testCoachPlanRequestEncodesSelectedModel() throws {
        let request = CoachPlanRequest(
            model: "gpt-5.5",
            baseline: CoachBaseline(pullUps: 1, pushUps: 2, plankSeconds: 30),
            goals: CoachGoals(pullUps: 10, pushUps: 20, plankSeconds: 120),
            profileNotes: "Left elbow gets cranky after high pull volume.",
            weekStart: Date(timeIntervalSince1970: 0),
            weeklySessions: 3,
            trainingDays: ["monday", "wednesday", "saturday"],
            trainingDayOffsets: [3, 5, 1],
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
        XCTAssertEqual(object["profileNotes"] as? String, "Left elbow gets cranky after high pull volume.")
        XCTAssertEqual(object["trainingDays"] as? [String], ["monday", "wednesday", "saturday"])
        XCTAssertEqual(object["trainingDayOffsets"] as? [Int], [3, 5, 1])
        let logs = try XCTUnwrap(object["trainingLogs"] as? [[String: Any]])
        XCTAssertEqual(logs.first?["notes"] as? String, "Felt shoulder tightness near the end.")
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

    func testAcceptsAIPlanAboveFormerProgressionCapsWhenTechnicallyValid() {
        let response = CoachPlanResponse(
            summary: "Too hot",
            contextState: "building",
            safetyFlags: [],
            sessions: [
                CoachSessionResponse(
                    title: "Bad pull day",
                    dayOffset: 1,
                    focus: "pull",
                    purpose: "Too much work",
                    estimatedDurationMinutes: 20,
                    progressionRationale: "Unsafe",
                    safetyNotes: [],
                    loggingFieldsRequired: ["pullUps"],
                    exercises: [
                        CoachExerciseResponse(exercise: "pullUp", sets: 8, reps: 20, seconds: 0, restSeconds: 30, intensity: "Max")
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

        XCTAssertEqual(result.status, .accepted)
        XCTAssertTrue(result.messages.isEmpty)
    }

    func testAcceptsAIPlanWithoutLocalMovementBalancePolicy() {
        let response = CoachPlanResponse(
            summary: "Too narrow",
            contextState: "building",
            safetyFlags: [],
            sessions: (0..<4).map {
                CoachSessionResponse(
                    title: "Pull only \($0 + 1)",
                    dayOffset: $0 + 1,
                    focus: "pull",
                    purpose: "Only pull",
                    estimatedDurationMinutes: 20,
                    progressionRationale: "No balance",
                    safetyNotes: [],
                    loggingFieldsRequired: ["pullUps"],
                    exercises: [
                        CoachExerciseResponse(exercise: "pullUp", sets: 3, reps: 3, seconds: 0, restSeconds: 120, intensity: "Moderate"),
                        CoachExerciseResponse(exercise: "deadHang", sets: 2, reps: 0, seconds: 20, restSeconds: 60, intensity: "Support")
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

    func testRejectsAIPlanThatSchedulesAnUnselectedTrainingDay() throws {
        let calendar = Calendar.current
        let weekStart = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 1)))
        let response = CoachPlanResponse.balancedFixture()

        let result = CoachPlanValidator().validate(
            response: response,
            baseline: Baseline(pullUps: 5, pushUps: 20, plankSeconds: 60),
            preferences: TrainingPreferences(
                weeklySessions: 4,
                equipment: [.pullUpBar],
                targetDate: Date(timeIntervalSinceNow: 365 * 24 * 60 * 60),
                trainingDays: [.tuesday, .thursday, .saturday, .sunday]
            ),
            weekStart: weekStart
        )

        XCTAssertEqual(result.status, .rejected)
        XCTAssertTrue(result.messages.contains { $0.contains("rest day") })
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
        XCTAssertEqual(plan.sessions[2].date, Calendar.current.date(byAdding: .day, value: 4, to: Calendar.current.startOfDay(for: weekStart)))
        XCTAssertTrue(plan.sessions.allSatisfy { isCoachGeneratedSummary($0.summary) })
        XCTAssertTrue(plan.sessions.allSatisfy { !$0.summary.contains("AI:") })
    }

    func testAcceptedAIPlanUsesRollingUpcomingWindow() throws {
        let calendar = Calendar.current
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 5, day: 22, hour: 13)))
        let windowStart = rollingPlanStart(date: now, calendar: calendar)
        let windowEnd = rollingPlanEnd(date: now, calendar: calendar)
        let plan = CoachPlanResponse.balancedFixture().weeklyPlan(weekStart: windowStart)

        XCTAssertEqual(plan.weekStart, windowStart)
        XCTAssertTrue(plan.sessions.allSatisfy { $0.date >= windowStart && $0.date < windowEnd })
        XCTAssertTrue(plan.sessions.allSatisfy { $0.date > windowStart })
    }

    func testRunningCoachRequestEncodesProfileLogsAndPlannedRuns() throws {
        let raceDate = Date(timeIntervalSince1970: 200_000)
        let profile = RunningProfile(
            targetRaceName: "Comrades Marathon",
            raceDate: raceDate,
            weeklyDistanceTargetKm: 42,
            longRunTargetKm: 28,
            easyPaceSecondsPerKm: 345,
            preferredTerrain: "Road and trail",
            injuryNotes: "Watch the left calf.",
            runningDays: [.tuesday, .friday, .sunday]
        )
        let workout = RunningWorkout(
            scheduledDate: Date(timeIntervalSince1970: 100_000),
            title: "Long Run",
            kind: .long,
            distanceKm: 28,
            durationSeconds: 9_600,
            elevationMeters: 620,
            zone: "Zone 2"
        )
        let log = RunningLog(
            workoutId: workout.id,
            completedAt: Date(timeIntervalSince1970: 110_000),
            distanceKm: 21.1,
            durationSeconds: 7_200,
            elevationMeters: 240,
            averageHeartRate: 142,
            notes: "Felt steady."
        )

        let request = makeRunningCoachRequest(
            profile: profile,
            modelID: " gpt-5 ",
            logs: [log],
            workouts: [workout],
            weekStart: try XCTUnwrap(Calendar.current.date(from: DateComponents(year: 2026, month: 6, day: 1)))
        )
        let data = try JSONEncoder.coachEncoder.encode(request)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let encodedProfile = try XCTUnwrap(object["profile"] as? [String: Any])
        let logs = try XCTUnwrap(object["runningLogs"] as? [[String: Any]])
        let plannedRuns = try XCTUnwrap(object["plannedRuns"] as? [[String: Any]])

        XCTAssertEqual(object["model"] as? String, "gpt-5")
        XCTAssertEqual(encodedProfile["targetRaceName"] as? String, "Comrades Marathon")
        XCTAssertEqual(encodedProfile["injuryNotes"] as? String, "Watch the left calf.")
        XCTAssertEqual(encodedProfile["trainingDays"] as? [String], ["tuesday", "friday", "sunday"])
        XCTAssertEqual(encodedProfile["trainingDayOffsets"] as? [Int], [1, 4, 6])
        XCTAssertEqual(logs.first?["distanceKm"] as? Double, 21.1)
        XCTAssertEqual(plannedRuns.first?["kind"] as? String, "long")
    }

    func testRunningWeekValidationRejectsInvalidGeneratedShape() {
        let response = RunningWeekResponse(
            summary: "Invalid running week",
            safetyFlags: [],
            sessions: [
                RunningWeekSessionResponse(
                    title: "Broken run",
                    dayOffset: 7,
                    kind: "mountain",
                    purpose: "Invalid",
                    distanceKm: -1,
                    durationMinutes: -20,
                    elevationMeters: -10,
                    zone: "Zone 9",
                    notes: []
                )
            ]
        )

        let messages = validateRunningWeek(response, allowedDayOffsets: [1, 4, 6])

        XCTAssertTrue(messages.contains { $0.contains("day offset") })
        XCTAssertTrue(messages.contains { $0.contains("exactly 3") })
        XCTAssertTrue(messages.contains { $0.contains("unknown kind") })
        XCTAssertTrue(messages.contains { $0.contains("negative") })
    }

    func testRunningWeekValidationRejectsTodayOffset() {
        let response = RunningWeekResponse(
            summary: "Invalid running week",
            safetyFlags: [],
            sessions: [
                RunningWeekSessionResponse(
                    title: "Today Run",
                    dayOffset: 0,
                    kind: "easy",
                    purpose: "Should not be scheduled today.",
                    distanceKm: 5,
                    durationMinutes: 30,
                    elevationMeters: 0,
                    zone: "Zone 2",
                    notes: []
                )
            ]
        )

        let messages = validateRunningWeek(response, allowedDayOffsets: [1])

        XCTAssertTrue(messages.contains { $0.contains("today") })
    }

    func testRunningWeekValidationRejectsUnselectedRunningDay() {
        let response = RunningWeekResponse(
            summary: "Wrong day",
            safetyFlags: [],
            sessions: [
                RunningWeekSessionResponse(
                    title: "Easy Run",
                    dayOffset: 2,
                    kind: "easy",
                    purpose: "Should use selected days.",
                    distanceKm: 5,
                    durationMinutes: 30,
                    elevationMeters: 0,
                    zone: "Zone 2",
                    notes: []
                )
            ]
        )

        let messages = validateRunningWeek(response, allowedDayOffsets: [1])

        XCTAssertTrue(messages.contains { $0.contains("unselected running day") })
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

extension CoachPlanResponse {
    static func balancedFixture() -> CoachPlanResponse {
        CoachPlanResponse(
            summary: "Balanced coach week",
            contextState: "building",
            safetyFlags: [],
            sessions: [
                mixedFixture(title: "Full-body base", dayOffset: 1),
                CoachSessionResponse(
                    title: "Pull emphasis",
                    dayOffset: 2,
                    focus: "pull",
                    purpose: "Build strict pull-up capacity with core support.",
                    estimatedDurationMinutes: 35,
                    progressionRationale: "Pull volume stays below the strict cap.",
                    safetyNotes: ["Stop before form breaks."],
                    loggingFieldsRequired: ["pullUps", "plankSeconds"],
                    exercises: [
                        CoachExerciseResponse(exercise: "pullUp", sets: 4, reps: 3, seconds: 0, restSeconds: 120, intensity: "Moderate"),
                        CoachExerciseResponse(exercise: "plank", sets: 3, reps: 0, seconds: 30, restSeconds: 75, intensity: "Support")
                    ]
                ),
                mixedFixture(title: "Full-body practice", dayOffset: 4),
                CoachSessionResponse(
                    title: "Core and push support",
                    dayOffset: 6,
                    focus: "core",
                    purpose: "Keep trunk endurance moving while adding light push support.",
                    estimatedDurationMinutes: 30,
                    progressionRationale: "Core work is submaximal and supported by easy push volume.",
                    safetyNotes: ["Keep breathing steady."],
                    loggingFieldsRequired: ["pushUps", "plankSeconds"],
                    exercises: [
                        CoachExerciseResponse(exercise: "plank", sets: 4, reps: 0, seconds: 30, restSeconds: 90, intensity: "Moderate"),
                        CoachExerciseResponse(exercise: "pushUp", sets: 3, reps: 8, seconds: 0, restSeconds: 75, intensity: "Support")
                    ]
                )
            ]
        )
    }

    private static func mixedFixture(title: String, dayOffset: Int) -> CoachSessionResponse {
        CoachSessionResponse(
            title: title,
            dayOffset: dayOffset,
            focus: "mixed",
            purpose: "Train pull, push, and core without chasing failure.",
            estimatedDurationMinutes: 40,
            progressionRationale: "All goal movements stay below current working caps.",
            safetyNotes: ["Leave clean reps in reserve."],
            loggingFieldsRequired: ["pullUps", "pushUps", "plankSeconds"],
            exercises: [
                CoachExerciseResponse(exercise: "pullUp", sets: 3, reps: 3, seconds: 0, restSeconds: 120, intensity: "Moderate"),
                CoachExerciseResponse(exercise: "pushUp", sets: 3, reps: 10, seconds: 0, restSeconds: 90, intensity: "Moderate"),
                CoachExerciseResponse(exercise: "plank", sets: 3, reps: 0, seconds: 30, restSeconds: 75, intensity: "Moderate")
            ]
        )
    }
}
