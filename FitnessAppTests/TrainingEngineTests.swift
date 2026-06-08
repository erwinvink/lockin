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
        XCTAssertTrue(plan.sessions.allSatisfy { $0.estimatedDurationMinutes > 0 })
        XCTAssertTrue(plan.sessions.flatMap(\.blocks).flatMap(\.sets).contains { $0.exercise == .pullUp })
    }

    func testWorkoutDurationEstimateIncludesTimedWorkRepWorkAndRests() {
        let sessionId = UUID()
        let blockId = UUID()
        let prescriptions = [
            SetPrescription(
                sessionId: sessionId,
                blockId: blockId,
                orderIndex: 0,
                exercise: .pushUp,
                sets: 3,
                targetReps: 20,
                restSeconds: 60,
                intensity: "Hard"
            ),
            SetPrescription(
                sessionId: sessionId,
                blockId: blockId,
                orderIndex: 1,
                exercise: .plank,
                sets: 2,
                targetSeconds: 45,
                restSeconds: 30,
                intensity: "Moderate"
            )
        ]

        XCTAssertEqual(estimatedWorkoutDurationMinutes(for: prescriptions), 9)
    }

    func testFallbackProgressesPullAndPushWithinThreeWeeks() {
        let engine = TrainingEngine()
        let preferences = TrainingPreferences(
            weeklySessions: 4,
            equipment: [.pullUpBar, .yogaMat],
            targetDate: Date(timeIntervalSinceNow: 365 * 24 * 60 * 60)
        )
        let baseline = Baseline(pullUps: 5, pushUps: 20, plankSeconds: 60)

        let firstBuildWeek = engine.generateWeek(
            start: Date(timeIntervalSince1970: 0),
            weekIndex: 1,
            baseline: baseline,
            preferences: preferences
        )
        let thirdBuildWeek = engine.generateWeek(
            start: Date(timeIntervalSince1970: 14 * 24 * 60 * 60),
            weekIndex: 3,
            baseline: baseline,
            preferences: preferences
        )

        XCTAssertGreaterThan(maxReps(for: .pullUp, in: thirdBuildWeek), maxReps(for: .pullUp, in: firstBuildWeek))
        XCTAssertGreaterThan(maxReps(for: .pushUp, in: thirdBuildWeek), maxReps(for: .pushUp, in: firstBuildWeek))
    }

    func testPainSignalTriggersDeloadScoring() {
        let outcome = TrainingEngine().score(
            log: SessionLogInput(completed: true, pullUps: 4, pushUps: 15, plankSeconds: 45, rpe: 6, painLevel: 5, fatigueLevel: 6),
            plannedSession: nil
        )

        XCTAssertTrue(outcome.didTriggerDeload)
        XCTAssertGreaterThanOrEqual(outcome.consistencyDelta, 0)
        XCTAssertEqual(outcome.penaltyDelta, 0)
    }

    func testMissedSessionCreatesScorePenaltyWithoutExtraLoad() {
        let outcome = TrainingEngine().score(
            log: SessionLogInput(completed: false, pullUps: 0, pushUps: 0, plankSeconds: 0, rpe: 1, painLevel: 0, fatigueLevel: 1),
            plannedSession: nil
        )

        XCTAssertLessThan(outcome.consistencyDelta, 0)
        XCTAssertEqual(outcome.penaltyDelta, TrainingEngine.missedSessionPenaltyPoints)
        XCTAssertFalse(outcome.didTriggerDeload)
    }

    func testMissedSessionResetsConsistencyStreakImmediately() {
        let rank = RankState(consistencyScore: 40, streak: 6, bestStreak: 6)
        let outcome = TrainingEngine().score(
            log: SessionLogInput(completed: false, pullUps: 0, pushUps: 0, plankSeconds: 0, rpe: 1, painLevel: 0, fatigueLevel: 1),
            plannedSession: nil
        )

        applyScoreOutcome(outcome, to: rank)

        XCTAssertEqual(rank.streak, 0)
        XCTAssertEqual(rank.penaltyPoints, TrainingEngine.missedSessionPenaltyPoints)
        XCTAssertEqual(rank.consistencyScore, 28)
    }

    func testDisplayedBestStreakNeverTrailsCurrentStreak() {
        let rank = RankState(streak: 5, bestStreak: 2)

        XCTAssertEqual(rank.displayedBestStreak, 5)
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

    func testWorkoutReminderDateUsesSelectedTimeOnWorkoutDay() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 5, hour: 12)))
        let scheduledDate = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 6, hour: 9)))
        let selectedTime = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 5, hour: 18, minute: 30)))

        let reminderDate = try XCTUnwrap(workoutReminderDate(for: scheduledDate, at: selectedTime, now: now, calendar: calendar))
        let components = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: reminderDate)

        XCTAssertEqual(components.year, 2026)
        XCTAssertEqual(components.month, 6)
        XCTAssertEqual(components.day, 6)
        XCTAssertEqual(components.hour, 18)
        XCTAssertEqual(components.minute, 30)
    }

    func testWorkoutReminderDateSkipsPastReminderTimes() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 5, hour: 12)))
        let scheduledDate = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 5, hour: 9)))
        let selectedTime = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 5, hour: 8)))

        XCTAssertNil(workoutReminderDate(for: scheduledDate, at: selectedTime, now: now, calendar: calendar))
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

    private func maxReps(for exercise: ExerciseKind, in plan: WeeklyPlan) -> Int {
        plan.sessions
            .flatMap(\.blocks)
            .flatMap(\.sets)
            .filter { $0.exercise == exercise }
            .map(\.reps)
            .max() ?? 0
    }
}
