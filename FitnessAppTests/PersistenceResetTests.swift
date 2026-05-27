import SwiftData
import XCTest
@testable import FitnessApp

@MainActor
final class PersistenceResetTests: XCTestCase {
    func testWipeAllDataDeletesEveryModel() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext

        let profile = UserProfile(
            targetDate: Date(),
            weeklySessions: 4,
            equipment: [.pullUpBar, .yogaMat],
            baselinePullUps: 0,
            baselinePushUps: 0,
            baselinePlankSeconds: 0
        )
        let session = WorkoutSession(
            scheduledDate: Date(),
            title: "Reset test",
            weekIndex: 1,
            focus: .pull,
            summary: "Temporary"
        )
        let block = WorkoutBlock(sessionId: session.id, orderIndex: 0, name: "Main", detail: "Temporary")
        let prescription = SetPrescription(
            sessionId: session.id,
            blockId: block.id,
            orderIndex: 0,
            exercise: .pullUp,
            sets: 1,
            targetReps: 1,
            restSeconds: 30,
            intensity: "Easy"
        )
        let log = PerformanceLog(
            sessionId: session.id,
            pullUps: 0,
            pushUps: 0,
            plankSeconds: 0,
            rpe: 5,
            painLevel: 0,
            fatigueLevel: 5,
            notes: "Temporary"
        )
        let rank = RankState(xp: 100)
        let plan = CoachPlan(weekStart: Date(), summary: "Temporary", source: .rules, validationStatus: .accepted)
        let decision = CoachDecision(planId: plan.id, rationale: "Temporary", safetyFlags: ["temporary"])
        let verdict = CoachVerdict(
            sourceLogId: log.id,
            headline: "Temporary",
            summary: "Temporary",
            latestChange: "Temporary",
            recommendation: "Temporary",
            shouldUpdatePlan: false,
            contextState: "building",
            safetyFlags: ["temporary"]
        )

        modelContext.insert(profile)
        modelContext.insert(session)
        modelContext.insert(block)
        modelContext.insert(prescription)
        modelContext.insert(log)
        modelContext.insert(rank)
        modelContext.insert(plan)
        modelContext.insert(decision)
        modelContext.insert(verdict)
        try modelContext.save()

        try wipeAllData(in: modelContext)
        try modelContext.save()

        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<UserProfile>()).count, 0)
        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<WorkoutSession>()).count, 0)
        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<WorkoutBlock>()).count, 0)
        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<SetPrescription>()).count, 0)
        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<PerformanceLog>()).count, 0)
        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<RankState>()).count, 0)
        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<CoachPlan>()).count, 0)
        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<CoachDecision>()).count, 0)
        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<CoachVerdict>()).count, 0)
    }

    func testPersistAIPlanReplacesOnlyFuturePlannedSessions() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext
        let calendar = Calendar.current
        let weekStart = currentWeekStart()
        let futureDate = try XCTUnwrap(calendar.date(byAdding: .day, value: 6, to: weekStart))

        let planned = WorkoutSession(
            scheduledDate: futureDate,
            title: "Old planned",
            weekIndex: 0,
            focus: .pull,
            summary: "Should be replaced"
        )
        let plannedBlock = WorkoutBlock(sessionId: planned.id, orderIndex: 0, name: "Old", detail: "Old")
        let plannedPrescription = SetPrescription(
            sessionId: planned.id,
            blockId: plannedBlock.id,
            orderIndex: 0,
            exercise: .pullUp,
            sets: 1,
            targetReps: 1,
            restSeconds: 30,
            intensity: "Easy"
        )
        let completed = WorkoutSession(
            scheduledDate: futureDate,
            title: "Completed keeper",
            weekIndex: 0,
            focus: .push,
            status: .completed,
            summary: "Must survive"
        )
        let completedLog = PerformanceLog(
            sessionId: completed.id,
            pullUps: 5,
            pushUps: 20,
            plankSeconds: 60,
            rpe: 7,
            painLevel: 0,
            fatigueLevel: 5,
            notes: "History"
        )

        modelContext.insert(planned)
        modelContext.insert(plannedBlock)
        modelContext.insert(plannedPrescription)
        modelContext.insert(completed)
        modelContext.insert(completedLog)
        try modelContext.save()

        let aiPlan = CoachPlanResponse.balancedFixture().weeklyPlan(weekStart: weekStart)
        try persist(plan: aiPlan, in: modelContext, source: .ai, replacingFuturePlannedSessions: true)
        try modelContext.save()

        let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())
        let blocks = try modelContext.fetch(FetchDescriptor<WorkoutBlock>())
        let prescriptions = try modelContext.fetch(FetchDescriptor<SetPrescription>())

        XCTAssertFalse(sessions.contains { $0.id == planned.id })
        XCTAssertTrue(sessions.contains { $0.id == completed.id })
        XCTAssertEqual(sessions.filter { $0.summary.contains("AI:") }.count, 4)
        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<PerformanceLog>()).count, 1)
        XCTAssertFalse(blocks.contains { $0.sessionId == planned.id })
        XCTAssertFalse(prescriptions.contains { $0.sessionId == planned.id })
    }

    func testDeleteNonAIPlannedSessionsKeepsAIAndHistory() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext

        let legacyPlanned = WorkoutSession(
            scheduledDate: Date(),
            title: "Legacy rules",
            weekIndex: 1,
            focus: .mixed,
            summary: "Rules-generated plan"
        )
        let legacyBlock = WorkoutBlock(sessionId: legacyPlanned.id, orderIndex: 0, name: "Legacy", detail: "Delete")
        let legacyPrescription = SetPrescription(
            sessionId: legacyPlanned.id,
            blockId: legacyBlock.id,
            orderIndex: 0,
            exercise: .pullUp,
            sets: 2,
            targetReps: 3,
            restSeconds: 60,
            intensity: "Moderate"
        )
        let aiPlanned = WorkoutSession(
            scheduledDate: Date(),
            title: "AI keeper",
            weekIndex: 1,
            focus: .pull,
            summary: "AI: Keep this session"
        )
        let completedLegacy = WorkoutSession(
            scheduledDate: Date(),
            title: "Completed history",
            weekIndex: 0,
            focus: .push,
            status: .completed,
            summary: "Rules-generated history"
        )

        modelContext.insert(legacyPlanned)
        modelContext.insert(legacyBlock)
        modelContext.insert(legacyPrescription)
        modelContext.insert(aiPlanned)
        modelContext.insert(completedLegacy)
        try modelContext.save()

        let deleted = try deleteNonAIPlannedSessions(from: [legacyPlanned, aiPlanned, completedLegacy], in: modelContext)

        let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())
        let blocks = try modelContext.fetch(FetchDescriptor<WorkoutBlock>())
        let prescriptions = try modelContext.fetch(FetchDescriptor<SetPrescription>())

        XCTAssertEqual(deleted, 1)
        XCTAssertFalse(sessions.contains { $0.id == legacyPlanned.id })
        XCTAssertTrue(sessions.contains { $0.id == aiPlanned.id })
        XCTAssertTrue(sessions.contains { $0.id == completedLegacy.id })
        XCTAssertFalse(blocks.contains { $0.sessionId == legacyPlanned.id })
        XCTAssertFalse(prescriptions.contains { $0.sessionId == legacyPlanned.id })
    }

    func testOverduePlannedSessionsAreAutomaticallyMarkedMissed() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 5, day: 22, hour: 12)))
        let today = calendar.startOfDay(for: now)
        let yesterday = try XCTUnwrap(calendar.date(byAdding: .day, value: -1, to: today))
        let tomorrow = try XCTUnwrap(calendar.date(byAdding: .day, value: 1, to: today))
        let profile = UserProfile(
            targetDate: tomorrow,
            weeklySessions: 4,
            equipment: [.pullUpBar, .yogaMat],
            baselinePullUps: 3,
            baselinePushUps: 12,
            baselinePlankSeconds: 45
        )
        let rank = RankState(xp: 500, consistencyScore: 30, streak: 4)
        let overdue = WorkoutSession(scheduledDate: yesterday, title: "Past work", weekIndex: 1, focus: .pull, summary: "Past")
        let dueToday = WorkoutSession(scheduledDate: today, title: "Today work", weekIndex: 1, focus: .mixed, summary: "Today")
        let future = WorkoutSession(scheduledDate: tomorrow, title: "Future work", weekIndex: 1, focus: .push, summary: "Future")

        modelContext.insert(profile)
        modelContext.insert(rank)
        modelContext.insert(overdue)
        modelContext.insert(dueToday)
        modelContext.insert(future)
        try modelContext.save()

        let processed = try markOverduePlannedSessionsMissed(
            from: [future, overdue, dueToday],
            logs: [],
            profile: profile,
            ranks: [rank],
            in: modelContext,
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(processed, 1)
        XCTAssertEqual(overdue.status, .missed)
        XCTAssertEqual(dueToday.status, .planned)
        XCTAssertEqual(future.status, .planned)
        XCTAssertEqual(rank.penaltyPoints, TrainingEngine.missedSessionPenaltyPoints)
        XCTAssertEqual(rank.streak, 0)
        XCTAssertEqual(rank.xp, 430)
    }

    func testZeroBaselineThreeWeekJourneyWithMissesAndCompletedDaysUpdatesRewards() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext
        let calendar = Calendar.current
        let weekStart = currentWeekStart()
        let profile = UserProfile(
            name: "ZeroPlan",
            targetDate: try XCTUnwrap(calendar.date(byAdding: .day, value: 21, to: weekStart)),
            weeklySessions: 4,
            equipment: [.pullUpBar, .yogaMat],
            baselinePullUps: 0,
            baselinePushUps: 0,
            baselinePlankSeconds: 0,
            goalPullUps: 10,
            goalPushUps: 30,
            goalPlankSeconds: 120
        )
        let rank = RankState()
        modelContext.insert(profile)
        modelContext.insert(rank)

        let engine = TrainingEngine()
        for weekIndex in 1...3 {
            let start = try XCTUnwrap(calendar.date(byAdding: .day, value: (weekIndex - 1) * 7, to: weekStart))
            let plan = engine.generateWeek(
                start: start,
                weekIndex: weekIndex,
                baseline: Baseline(pullUps: 0, pushUps: 0, plankSeconds: 0),
                goals: GoalTargets(pullUps: 10, pushUps: 30, plankSeconds: 120),
                preferences: TrainingPreferences(
                    weeklySessions: 4,
                    equipment: [.pullUpBar, .yogaMat],
                    targetDate: profile.targetDate
                )
            )
            try persist(plan: plan, in: modelContext, source: .rules)
        }
        try modelContext.save()

        let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())
            .sorted { $0.scheduledDate < $1.scheduledDate }
        XCTAssertEqual(sessions.count, 12)

        for session in sessions.prefix(3) {
            session.status = .missed
            let outcome = engine.score(
                log: SessionLogInput(completed: false, pullUps: 0, pushUps: 0, plankSeconds: 0, rpe: 1, painLevel: 0, fatigueLevel: 1),
                plannedSession: nil
            )
            applyScoreOutcome(outcome, to: rank)
        }

        for (index, session) in sessions.dropFirst(3).enumerated() {
            session.status = .completed
            let log = PerformanceLog(
                sessionId: session.id,
                pullUps: min(10, index + 1),
                pushUps: min(30, 8 + index * 2),
                plankSeconds: min(120, 30 + index * 10),
                rpe: 7,
                painLevel: 0,
                fatigueLevel: 5,
                notes: "Completed day \(index + 1)"
            )
            modelContext.insert(log)
            let outcome = engine.score(
                log: SessionLogInput(
                    completed: true,
                    pullUps: log.pullUps,
                    pushUps: log.pushUps,
                    plankSeconds: log.plankSeconds,
                    rpe: log.rpe,
                    painLevel: log.painLevel,
                    fatigueLevel: log.fatigueLevel
                ),
                plannedSession: nil
            )
            applyScoreOutcome(outcome, to: rank)
        }
        try modelContext.save()

        let updatedSessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())
        XCTAssertFalse(updatedSessions.contains { $0.status == .planned })
        XCTAssertEqual(updatedSessions.filter { $0.status == .missed }.count, 3)
        XCTAssertEqual(updatedSessions.filter { $0.status == .completed }.count, 9)
        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<PerformanceLog>()).count, 9)
        XCTAssertEqual(rank.penaltyPoints, 75)
        XCTAssertEqual(rank.streak, 9)
        XCTAssertEqual(rank.xp, 810)
        XCTAssertEqual(rank.rank, .grinder)
    }
}
