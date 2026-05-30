import XCTest
@testable import FitnessApp

final class TrainingEngineTests: XCTestCase {
    func testGeneratesExactWeeklySessionsFromPreferences() {
        let engine = TrainingEngine()
        let plan = engine.generateWeek(
            start: Date(timeIntervalSince1970: 0),
            weekIndex: 1,
            baseline: Baseline(pullUps: 5, pushUps: 20, plankSeconds: 60),
            preferences: TrainingPreferences(
                weeklySessions: 4,
                equipment: [.pullUpBar, .yogaMat],
                targetDate: Date(timeIntervalSinceNow: 365 * 24 * 60 * 60)
            )
        )

        XCTAssertEqual(plan.sessions.count, 4)
        XCTAssertTrue(plan.sessions.allSatisfy { !$0.blocks.isEmpty })
        XCTAssertTrue(plan.sessions.flatMap(\.blocks).flatMap(\.sets).contains { $0.exercise == .pullUp })
    }

    func testPainSignalTriggersDeloadScoring() {
        let outcome = TrainingEngine().score(
            log: SessionLogInput(completed: true, pullUps: 4, pushUps: 15, plankSeconds: 45, rpe: 6, painLevel: 5, fatigueLevel: 6),
            plannedSession: nil
        )

        XCTAssertTrue(outcome.didTriggerDeload)
        XCTAssertGreaterThanOrEqual(outcome.xpDelta, 0)
        XCTAssertEqual(outcome.penaltyDelta, 0)
    }

    func testMissedSessionCreatesScorePenaltyWithoutExtraLoad() {
        let outcome = TrainingEngine().score(
            log: SessionLogInput(completed: false, pullUps: 0, pushUps: 0, plankSeconds: 0, rpe: 1, painLevel: 0, fatigueLevel: 1),
            plannedSession: nil
        )

        XCTAssertLessThan(outcome.xpDelta, 0)
        XCTAssertEqual(outcome.penaltyDelta, TrainingEngine.missedSessionPenaltyPoints)
        XCTAssertFalse(outcome.didTriggerDeload)
    }

    func testMissedSessionResetsConsistencyStreakImmediately() {
        let rank = RankState(xp: 500, consistencyScore: 40, streak: 6)
        let outcome = TrainingEngine().score(
            log: SessionLogInput(completed: false, pullUps: 0, pushUps: 0, plankSeconds: 0, rpe: 1, painLevel: 0, fatigueLevel: 1),
            plannedSession: nil
        )

        applyScoreOutcome(outcome, to: rank)

        XCTAssertEqual(rank.streak, 0)
        XCTAssertEqual(rank.penaltyPoints, TrainingEngine.missedSessionPenaltyPoints)
    }

    func testTodayOnlyTreatsCurrentDaySessionsAsDue() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 5, day: 22, hour: 12)))
        let today = calendar.startOfDay(for: now)
        let yesterday = try XCTUnwrap(calendar.date(byAdding: .day, value: -1, to: today))
        let tomorrow = try XCTUnwrap(calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)))

        let overdue = WorkoutSession(scheduledDate: yesterday, title: "Overdue", weekIndex: 1, focus: .pull, summary: "Past")
        let dueToday = WorkoutSession(scheduledDate: today, title: "Today", weekIndex: 1, focus: .mixed, summary: "Current")
        let future = WorkoutSession(scheduledDate: tomorrow, title: "Tomorrow", weekIndex: 1, focus: .push, summary: "Future")

        XCTAssertNil(duePlannedSession(from: [future], now: now, calendar: calendar))
        XCTAssertEqual(nextFuturePlannedSession(from: [future], now: now, calendar: calendar)?.id, future.id)
        XCTAssertNil(duePlannedSession(from: [overdue], now: now, calendar: calendar))
        XCTAssertEqual(overduePlannedSessions(from: [future, dueToday, overdue], now: now, calendar: calendar).map(\.id), [overdue.id])
        XCTAssertEqual(duePlannedSession(from: [future, dueToday, overdue], now: now, calendar: calendar)?.id, dueToday.id)
    }

    func testWorkoutTimerPhasesIncludeManualRepSetsAndFinalRest() {
        let prescription = SetPrescription(
            sessionId: UUID(),
            blockId: UUID(),
            orderIndex: 0,
            exercise: .pushUp,
            sets: 3,
            targetReps: 20,
            restSeconds: 60,
            intensity: "Hard"
        )

        let phases = workoutTimerPhases(for: prescription)

        XCTAssertEqual(phases.map(\.kind), [.work, .rest, .work, .rest, .work, .rest])
        XCTAssertEqual(phases.map(\.target), [.reps(20), .seconds(60), .reps(20), .seconds(60), .reps(20), .seconds(60)])
        XCTAssertTrue(phases[0].isManual)
        XCTAssertFalse(phases[1].isManual)
        XCTAssertEqual(phases.last?.setNumber, 3)
    }

    func testWorkoutTimerPhasesKeepTimedWorkForHolds() {
        let prescription = SetPrescription(
            sessionId: UUID(),
            blockId: UUID(),
            orderIndex: 0,
            exercise: .plank,
            sets: 2,
            targetSeconds: 45,
            restSeconds: 30,
            intensity: "Moderate"
        )

        let phases = workoutTimerPhases(for: prescription)

        XCTAssertEqual(phases.map(\.kind), [.work, .rest, .work, .rest])
        XCTAssertEqual(phases.map(\.target), [.seconds(45), .seconds(30), .seconds(45), .seconds(30)])
        XCTAssertTrue(phases.allSatisfy { !$0.isManual })
    }

    func testUltraRunningEngineBuildsConservativeWeekForStrugglingRunner() {
        let profile = RunningTrainingProfile(
            userProfileId: UUID(),
            weeklyRunSessions: 4,
            currentWeeklyDistanceKm: 25,
            currentLongRunKm: 10,
            easyPaceSecondsPerKm: 420,
            easyHeartRate: 140,
            thresholdHeartRate: 165,
            ability: .struggling,
            terrain: .mixed
        )

        let plan = UltraRunningEngine().generateWeek(
            start: Date(timeIntervalSince1970: 0),
            weekIndex: 1,
            profile: profile,
            recentRunLogs: []
        )

        XCTAssertEqual(plan.sessions.count, 4)
        XCTAssertTrue(plan.sessions.contains { $0.runType == .long })
        XCTAssertTrue(plan.sessions.contains { $0.runType == .hillHike })
        XCTAssertTrue(plan.sessions.allSatisfy { $0.targetHeartRateHigh < profile.thresholdHeartRate })
        XCTAssertLessThanOrEqual(plan.sessions.first(where: { $0.runType == .long })?.targetDistanceKm ?? 100, 10.6)
        XCTAssertTrue(plan.summary.contains("easy volume"))
    }

    func testUltraRunningEngineDeloadsAfterRunPainOrGIFlag() {
        let profile = RunningTrainingProfile(
            userProfileId: UUID(),
            weeklyRunSessions: 4,
            currentWeeklyDistanceKm: 40,
            currentLongRunKm: 18,
            ability: .struggling
        )
        let flaggedLog = RunningLog(
            sessionId: UUID(),
            durationMinutes: 120,
            distanceKm: 14,
            elevationGainMeters: 100,
            averageHeartRate: 148,
            maxHeartRate: 172,
            averagePaceSecondsPerKm: 510,
            rpe: 8,
            painLevel: 4,
            fatigueLevel: 6,
            carbsPerHour: 35,
            fluidMlPerHour: 500,
            sodiumMgPerHour: 400,
            hadGIIssues: true,
            notes: "Knee got ugly."
        )

        let plan = UltraRunningEngine().generateWeek(
            start: Date(timeIntervalSince1970: 0),
            weekIndex: 1,
            profile: profile,
            recentRunLogs: [flaggedLog]
        )

        XCTAssertEqual(plan.readiness, "Recovery needed")
        XCTAssertTrue(plan.summary.contains("deload"))
        XCTAssertLessThan(plan.sessions.map(\.targetDistanceKm).reduce(0, +), 40)
    }
}
