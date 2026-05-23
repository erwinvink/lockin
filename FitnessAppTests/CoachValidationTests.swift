import XCTest
@testable import FitnessApp

final class CoachValidationTests: XCTestCase {
    func testProxyUnavailableErrorExplainsHowToStartLocalProxy() throws {
        let endpoint = try XCTUnwrap(URL(string: "http://127.0.0.1:8787/generate-week-plan"))
        let error = CoachClientError.proxyUnavailable(endpoint, URLError(.cannotConnectToHost))
        let message = try XCTUnwrap(error.errorDescription)

        XCTAssertTrue(message.contains("local coach proxy is not running"))
        XCTAssertTrue(message.contains("cd Proxy"))
        XCTAssertTrue(message.contains("OPENAI_API_KEY"))
    }

    func testMissingAPIKeyErrorExplainsProxyEnvironment() {
        let error = CoachClientError.invalidStatus(500, "OPENAI_API_KEY is not set")
        let message = error.localizedDescription

        XCTAssertTrue(message.contains("OPENAI_API_KEY is not set"))
        XCTAssertTrue(message.contains("Restart it with"))
    }

    func testCoachClientNormalizesBareProxyHost() throws {
        let client = try LocalCoachClient(endpointString: "127.0.0.1:8787")

        XCTAssertEqual(client.endpoint.absoluteString, "http://127.0.0.1:8787/generate-week-plan")
    }

    func testRejectsAIPlanAboveStrictProgressionCaps() {
        let response = CoachPlanResponse(
            summary: "Too hot",
            contextState: "building",
            safetyFlags: [],
            sessions: [
                CoachSessionResponse(
                    title: "Bad pull day",
                    dayOffset: 0,
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
                weeklySessions: 4,
                equipment: [.pullUpBar],
                targetDate: Date(timeIntervalSinceNow: 365 * 24 * 60 * 60)
            ),
            weekStart: Date()
        )

        XCTAssertEqual(result.status, .rejected)
        XCTAssertFalse(result.messages.isEmpty)
    }

    func testRejectsAIPlanWithoutWeeklyMovementBalance() {
        let response = CoachPlanResponse(
            summary: "Too narrow",
            contextState: "building",
            safetyFlags: [],
            sessions: (0..<4).map {
                CoachSessionResponse(
                    title: "Pull only \($0 + 1)",
                    dayOffset: $0,
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

        XCTAssertEqual(result.status, .rejected)
        XCTAssertTrue(result.messages.contains { $0.contains("push exposure") || $0.contains("core exposure") })
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
        XCTAssertTrue(plan.sessions.allSatisfy { $0.summary.contains("AI:") })
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
}

extension CoachPlanResponse {
    static func balancedFixture() -> CoachPlanResponse {
        CoachPlanResponse(
            summary: "Balanced AI week",
            contextState: "building",
            safetyFlags: [],
            sessions: [
                mixedFixture(title: "Full-body base", dayOffset: 0),
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
