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
        let rank = RankState(consistencyScore: 10)
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
        let firstAISession = try XCTUnwrap(sessions.first { $0.title == "Full-body base" })
        XCTAssertEqual(firstAISession.estimatedDurationMinutes, 40)
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
        let rank = RankState(consistencyScore: 30, streak: 4, bestStreak: 4)
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
        XCTAssertEqual(rank.consistencyScore, 18)
    }

    func testOverduePlannedRunningSessionIsMarkedMissedWithSameRankPenalty() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 10, hour: 12)))
        let today = calendar.startOfDay(for: now)
        let yesterday = try XCTUnwrap(calendar.date(byAdding: .day, value: -1, to: today))
        let profile = UserProfile(
            targetDate: now,
            weeklySessions: 4,
            equipment: [.pullUpBar, .yogaMat],
            baselinePullUps: 3,
            baselinePushUps: 12,
            baselinePlankSeconds: 45
        )
        let rank = RankState(consistencyScore: 30, streak: 4, bestStreak: 4)
        let overdueRun = WorkoutSession(
            scheduledDate: yesterday,
            title: "Skipped easy run",
            weekIndex: 0,
            focus: .mixed,
            summary: "AI: Easy aerobic run",
            discipline: .running,
            runKind: .easy,
            plannedDistanceKm: 8
        )

        modelContext.insert(profile)
        modelContext.insert(rank)
        modelContext.insert(overdueRun)
        try modelContext.save()

        let processed = try markOverduePlannedSessionsMissed(
            from: [overdueRun],
            logs: [],
            profile: profile,
            ranks: [rank],
            in: modelContext,
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(processed, 1)
        XCTAssertEqual(overdueRun.status, .missed)
        XCTAssertEqual(rank.streak, 0)
        XCTAssertEqual(rank.penaltyPoints, TrainingEngine.missedSessionPenaltyPoints)
        XCTAssertEqual(rank.consistencyScore, 30 + TrainingEngine.missedSessionConsistencyDelta)
    }

    func testWipeAllDataDeletesRunningModels() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext

        let raceGoal = RaceGoal(
            name: "Temporary 100K",
            raceDate: Date(),
            distanceKm: 100,
            elevationGainM: 4500,
            baselineWeeklyKm: 40,
            longestRecentRunKm: 25
        )
        let runLog = RunLog(
            sessionId: UUID(),
            distanceKm: 12.5,
            movingSeconds: 4200,
            elevationGainM: 180,
            averageHr: 152,
            averagePaceSecPerKm: 336,
            rpe: 6,
            feelScore: 4,
            notes: "Temporary"
        )
        let snapshot = GarminDailySnapshot(
            date: Calendar.current.startOfDay(for: Date()),
            sleepScore: 82,
            sleepSeconds: 27000,
            hrvStatus: "balanced",
            hrvMs: 52,
            bodyBattery: 70,
            trainingReadiness: 65,
            restingHr: 48
        )

        modelContext.insert(raceGoal)
        modelContext.insert(runLog)
        modelContext.insert(snapshot)
        try modelContext.save()

        try wipeAllData(in: modelContext)
        try modelContext.save()

        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<RaceGoal>()).count, 0)
        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<RunLog>()).count, 0)
        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<GarminDailySnapshot>()).count, 0)
    }

    func testDefaultWorkoutSessionDisciplineIsStrength() throws {
        let session = WorkoutSession(
            scheduledDate: Date(),
            title: "Strength default",
            weekIndex: 1,
            focus: .pull,
            summary: "No discipline specified"
        )

        XCTAssertEqual(session.discipline, .strength)
        XCTAssertFalse(session.isRun)
        XCTAssertNil(session.runKind)
    }

    func testRunningSessionRoundTripsRunFields() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext

        let session = WorkoutSession(
            scheduledDate: Date(),
            title: "Long run",
            weekIndex: 1,
            focus: .mixed,
            summary: "Aerobic endurance",
            discipline: .running,
            runKind: .long,
            plannedDistanceKm: 28.5,
            plannedElevationM: 950,
            runTargetType: .pace,
            runTargetLow: 315,
            runTargetHigh: 345,
            runZone: "Z2"
        )
        modelContext.insert(session)
        try modelContext.save()

        let fetched = try XCTUnwrap(
            modelContext.fetch(FetchDescriptor<WorkoutSession>()).first { $0.id == session.id }
        )
        XCTAssertEqual(fetched.discipline, .running)
        XCTAssertTrue(fetched.isRun)
        XCTAssertEqual(fetched.runKind, .long)
        XCTAssertEqual(fetched.plannedDistanceKm, 28.5)
        XCTAssertEqual(fetched.plannedElevationM, 950)
        XCTAssertEqual(fetched.runTargetTypeRaw, RunTargetType.pace.rawValue)
        XCTAssertEqual(fetched.runTargetType, .pace)
        XCTAssertEqual(fetched.runTargetLow, 315)
        XCTAssertEqual(fetched.runTargetHigh, 345)
        XCTAssertEqual(fetched.runZone, "Z2")
    }

    func testPersistRunningWeekCreatesRunningSessions() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext
        let calendar = Calendar.current
        let weekStart = Date()
        let week = RunningWeekResponse.ultraFixture()

        try persist(runningWeek: week, weekStart: weekStart, in: modelContext)
        try modelContext.save()

        let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())
        XCTAssertEqual(sessions.count, week.sessions.count)

        for run in week.sessions {
            let session = try XCTUnwrap(sessions.first { $0.title == run.title })
            let expectedDate = try XCTUnwrap(
                calendar.date(byAdding: .day, value: run.dayOffset, to: calendar.startOfDay(for: weekStart))
            )
            XCTAssertEqual(session.discipline, .running)
            XCTAssertTrue(session.isRun)
            XCTAssertEqual(session.status, .planned)
            XCTAssertEqual(session.scheduledDate, expectedDate)
            XCTAssertNotNil(session.runKind)
            XCTAssertEqual(session.runKind, RunKind(rawValue: run.kind))
            XCTAssertEqual(session.plannedDistanceKm, run.distanceKm)
            XCTAssertEqual(session.plannedElevationM, run.elevationMeters)
            XCTAssertNotNil(session.runTargetType)
            XCTAssertEqual(session.runTargetType, RunTargetType(rawValue: run.target.type))
            XCTAssertEqual(session.runTargetLow, run.target.low)
            XCTAssertEqual(session.runTargetHigh, run.target.high)
            XCTAssertEqual(session.runZone, run.zone)
            XCTAssertTrue(session.summary.hasPrefix("AI: "))
            XCTAssertEqual(session.summary, "AI: \(run.purpose)")
            XCTAssertEqual(session.estimatedDurationMinutes, run.durationMinutes)
        }
    }

    func testPersistRunningWeekReplacesOnlyFuturePlannedRunningSessions() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let weekStart = try XCTUnwrap(calendar.date(byAdding: .day, value: -3, to: today))
        let yesterday = try XCTUnwrap(calendar.date(byAdding: .day, value: -1, to: today))
        let tomorrow = try XCTUnwrap(calendar.date(byAdding: .day, value: 1, to: today))

        let overduePlannedRun = WorkoutSession(
            scheduledDate: yesterday,
            title: "Overdue run",
            weekIndex: 0,
            focus: .mixed,
            summary: "AI: Overdue easy run",
            discipline: .running,
            runKind: .easy
        )
        let completedTodayRun = WorkoutSession(
            scheduledDate: today,
            title: "Completed today run",
            weekIndex: 0,
            focus: .mixed,
            status: .completed,
            summary: "AI: Logged easy run",
            discipline: .running,
            runKind: .easy
        )
        let futurePlannedRun = WorkoutSession(
            scheduledDate: tomorrow,
            title: "Stale future run",
            weekIndex: 0,
            focus: .mixed,
            summary: "AI: Stale future run",
            discipline: .running,
            runKind: .long
        )
        let futurePlannedStrength = WorkoutSession(
            scheduledDate: tomorrow,
            title: "Strength keeper",
            weekIndex: 0,
            focus: .pull,
            summary: "AI: Strength session"
        )

        modelContext.insert(overduePlannedRun)
        modelContext.insert(completedTodayRun)
        modelContext.insert(futurePlannedRun)
        modelContext.insert(futurePlannedStrength)
        try modelContext.save()

        let week = RunningWeekResponse.ultraFixture()
        try persist(runningWeek: week, weekStart: weekStart, in: modelContext, replacingFuturePlannedSessions: true)
        try modelContext.save()

        let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())
        XCTAssertTrue(sessions.contains { $0.id == overduePlannedRun.id }, "Planned sessions before today are locked history")
        XCTAssertTrue(sessions.contains { $0.id == completedTodayRun.id }, "Completed sessions must never be deleted")
        XCTAssertFalse(sessions.contains { $0.id == futurePlannedRun.id }, "Future planned running sessions are replaced")
        XCTAssertTrue(sessions.contains { $0.id == futurePlannedStrength.id }, "Running re-persist must not delete strength sessions")
        XCTAssertEqual(sessions.count, 3 + week.sessions.count, "Exactly one stale session should be replaced")
    }

    func testPersistStrengthPlanKeepsPlannedRunningSessions() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext
        let calendar = Calendar.current
        let weekStart = calendar.startOfDay(for: Date())
        let tomorrow = try XCTUnwrap(calendar.date(byAdding: .day, value: 1, to: weekStart))

        let plannedRun = WorkoutSession(
            scheduledDate: tomorrow,
            title: "Run keeper",
            weekIndex: 0,
            focus: .mixed,
            summary: "AI: Easy aerobic run",
            discipline: .running,
            runKind: .easy
        )
        let plannedStrength = WorkoutSession(
            scheduledDate: tomorrow,
            title: "Stale strength",
            weekIndex: 0,
            focus: .pull,
            summary: "AI: Stale strength session"
        )
        modelContext.insert(plannedRun)
        modelContext.insert(plannedStrength)
        try modelContext.save()

        let aiPlan = CoachPlanResponse.balancedFixture().weeklyPlan(weekStart: weekStart)
        try persist(plan: aiPlan, in: modelContext, source: .ai, replacingFuturePlannedSessions: true)
        try modelContext.save()

        let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())
        XCTAssertTrue(sessions.contains { $0.id == plannedRun.id }, "Strength re-persist must not delete planned running sessions")
        XCTAssertFalse(sessions.contains { $0.id == plannedStrength.id }, "Future planned strength sessions are replaced")
    }

    func testPersistStrengthPlanKeepsPlannedSessionScheduledToday() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext
        let calendar = Calendar.current
        let weekStart = calendar.startOfDay(for: Date())

        let plannedToday = WorkoutSession(
            scheduledDate: weekStart,
            title: "Today strength keeper",
            weekIndex: 0,
            focus: .pull,
            summary: "AI: Today strength session"
        )
        modelContext.insert(plannedToday)
        try modelContext.save()

        let aiPlan = CoachPlanResponse.balancedFixture().weeklyPlan(weekStart: weekStart)
        try persist(plan: aiPlan, in: modelContext, source: .ai, replacingFuturePlannedSessions: true)
        try modelContext.save()

        let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())
        XCTAssertTrue(sessions.contains { $0.id == plannedToday.id }, "A planned session scheduled today is locked and must survive a replan")
    }

    func testPersistRunningWeekKeepsPlannedRunningSessionScheduledToday() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext
        let calendar = Calendar.current
        let weekStart = calendar.startOfDay(for: Date())
        let tomorrow = try XCTUnwrap(calendar.date(byAdding: .day, value: 1, to: weekStart))

        let plannedTodayRun = WorkoutSession(
            scheduledDate: weekStart,
            title: "Today run keeper",
            weekIndex: 0,
            focus: .mixed,
            summary: "AI: Today easy run",
            discipline: .running,
            runKind: .easy
        )
        let plannedTomorrowRun = WorkoutSession(
            scheduledDate: tomorrow,
            title: "Stale tomorrow run",
            weekIndex: 0,
            focus: .mixed,
            summary: "AI: Stale tomorrow run",
            discipline: .running,
            runKind: .long
        )
        modelContext.insert(plannedTodayRun)
        modelContext.insert(plannedTomorrowRun)
        try modelContext.save()

        let week = RunningWeekResponse.ultraFixture()
        try persist(runningWeek: week, weekStart: weekStart, in: modelContext, replacingFuturePlannedSessions: true)
        try modelContext.save()

        let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())
        XCTAssertTrue(sessions.contains { $0.id == plannedTodayRun.id }, "A planned run scheduled today is locked and must survive a replan")
        XCTAssertFalse(sessions.contains { $0.id == plannedTomorrowRun.id }, "Planned runs scheduled after today are still replaced")
    }

    func testDeleteNonAIPlannedSessionsKeepsAIRunningSessions() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext

        let aiPlannedRun = WorkoutSession(
            scheduledDate: Date(),
            title: "AI run keeper",
            weekIndex: 0,
            focus: .mixed,
            summary: "AI: Easy aerobic run",
            discipline: .running,
            runKind: .easy
        )
        let legacyPlannedRun = WorkoutSession(
            scheduledDate: Date(),
            title: "Legacy run",
            weekIndex: 0,
            focus: .mixed,
            summary: "Rules-generated run",
            discipline: .running,
            runKind: .easy
        )
        modelContext.insert(aiPlannedRun)
        modelContext.insert(legacyPlannedRun)
        try modelContext.save()

        let deleted = try deleteNonAIPlannedSessions(from: [aiPlannedRun, legacyPlannedRun], in: modelContext)

        let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())
        XCTAssertEqual(deleted, 1)
        XCTAssertTrue(sessions.contains { $0.id == aiPlannedRun.id })
        XCTAssertFalse(sessions.contains { $0.id == legacyPlannedRun.id })
    }

    func testRunningDaysEmptySetRoundTripsThroughPersistence() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext

        let profile = UserProfile(
            targetDate: Date(),
            weeklySessions: 3,
            equipment: [.pullUpBar],
            baselinePullUps: 0,
            baselinePushUps: 0,
            baselinePlankSeconds: 0
        )
        profile.runningDays = []
        modelContext.insert(profile)
        try modelContext.save()

        let fetched = try XCTUnwrap(
            modelContext.fetch(FetchDescriptor<UserProfile>()).first { $0.id == profile.id }
        )
        XCTAssertEqual(fetched.runningDaysRaw, "")
        XCTAssertEqual(fetched.runningDays, [])
    }

    func testRunningDaysCanonicalizeToAllCasesOrder() throws {
        let profile = UserProfile(
            targetDate: Date(),
            weeklySessions: 3,
            equipment: [.pullUpBar],
            baselinePullUps: 0,
            baselinePushUps: 0,
            baselinePlankSeconds: 0
        )

        profile.runningDays = [.saturday, .monday, .wednesday]

        XCTAssertEqual(profile.runningDaysRaw, "monday,wednesday,saturday")
        XCTAssertEqual(profile.runningDays, [.monday, .wednesday, .saturday])
    }

    func testLongRunDayNilRoundTripsThroughPersistence() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext

        let profile = UserProfile(
            targetDate: Date(),
            weeklySessions: 3,
            equipment: [.pullUpBar],
            baselinePullUps: 0,
            baselinePushUps: 0,
            baselinePlankSeconds: 0
        )
        profile.longRunDay = .sunday
        profile.longRunDay = nil
        modelContext.insert(profile)
        try modelContext.save()

        let fetched = try XCTUnwrap(
            modelContext.fetch(FetchDescriptor<UserProfile>()).first { $0.id == profile.id }
        )
        XCTAssertEqual(fetched.longRunDayRaw, "")
        XCTAssertNil(fetched.longRunDay)
    }

    func testUnknownDisciplineRawFallsBackToStrength() throws {
        let session = WorkoutSession(
            scheduledDate: Date(),
            title: "Mystery discipline",
            weekIndex: 0,
            focus: .mixed,
            summary: "Unknown raw value"
        )

        session.disciplineRaw = "cycling"

        XCTAssertEqual(session.discipline, .strength)
        XCTAssertFalse(session.isRun)
    }

    func testIngestWellnessUpsertsOneSnapshotPerCalendarDay() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))

        try ingest(
            wellness: [
                wellnessDayFixture(date: "2026-06-08", sleepScore: 70),
                wellnessDayFixture(date: "2026-06-09", sleepScore: 80)
            ],
            in: modelContext,
            calendar: calendar
        )
        try modelContext.save()

        let firstPass = try modelContext.fetch(FetchDescriptor<GarminDailySnapshot>())
        XCTAssertEqual(firstPass.count, 2, "Days missing from the response stay absent instead of being zero-filled")
        let monday = try XCTUnwrap(firstPass.first { calendar.component(.day, from: $0.date) == 8 })
        XCTAssertEqual(monday.date, try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 8))))
        XCTAssertEqual(monday.sleepScore, 70)
        XCTAssertEqual(monday.sleepSeconds, 27_360)
        XCTAssertEqual(monday.hrvStatus, "BALANCED")
        XCTAssertEqual(monday.hrvMs, 52)
        XCTAssertEqual(monday.bodyBattery, 71)
        XCTAssertEqual(monday.trainingReadiness, 64)
        XCTAssertEqual(monday.restingHr, 47)

        let beforeSecondIngest = Date()
        try ingest(
            wellness: [wellnessDayFixture(date: "2026-06-08T00:00:00Z", sleepScore: 75, restingHr: 51)],
            in: modelContext,
            calendar: calendar
        )
        try modelContext.save()

        let secondPass = try modelContext.fetch(FetchDescriptor<GarminDailySnapshot>())
        XCTAssertEqual(secondPass.count, 2, "Re-ingesting an existing day updates it instead of duplicating it")
        let updatedMonday = try XCTUnwrap(secondPass.first { calendar.component(.day, from: $0.date) == 8 })
        XCTAssertEqual(updatedMonday.id, monday.id)
        XCTAssertEqual(updatedMonday.sleepScore, 75)
        XCTAssertEqual(updatedMonday.restingHr, 51)
        XCTAssertGreaterThanOrEqual(updatedMonday.fetchedAt, beforeSecondIngest)
    }

    func testMatchGarminActivitiesCreatesPendingRunLogForSameDayPlannedRun() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let runDay = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 8, hour: 9)))
        let plannedRun = plannedRunFixture(scheduledDate: runDay, distanceKm: 12)
        modelContext.insert(plannedRun)
        try modelContext.save()

        let matched = try matchGarminActivities(
            [garminActivityFixture(startTime: "2026-06-08 07:01:33")],
            sessions: [plannedRun],
            existingRunLogs: [],
            in: modelContext,
            calendar: calendar
        )
        try modelContext.save()

        XCTAssertEqual(matched, 1)
        let logs = try modelContext.fetch(FetchDescriptor<RunLog>())
        XCTAssertEqual(logs.count, 1)
        let log = try XCTUnwrap(logs.first)
        XCTAssertEqual(log.sessionId, plannedRun.id)
        XCTAssertEqual(log.garminActivityId, "19519498613")
        XCTAssertEqual(log.source, .garmin)
        XCTAssertTrue(log.needsConfirmation)
        XCTAssertEqual(log.distanceKm, 12.03)
        XCTAssertEqual(log.movingSeconds, 4_480)
        XCTAssertEqual(log.elevationGainM, 156)
        XCTAssertEqual(log.averageHr, 148)
        XCTAssertEqual(log.averagePaceSecPerKm, 374)
        XCTAssertEqual(log.rpe, 0)
        XCTAssertEqual(log.feelScore, 3)
        XCTAssertEqual(
            log.completedAt,
            try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 8, hour: 7, minute: 1, second: 33)))
        )
        XCTAssertEqual(plannedRun.status, .planned, "Confirmation, not sync, flips the session to completed")
    }

    func testMatchGarminActivitiesSkipsAlreadyIngestedActivityIds() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let runDay = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 8, hour: 9)))
        let plannedRun = plannedRunFixture(scheduledDate: runDay, distanceKm: 12)
        // The earlier ingest may have matched a different (since replanned) session;
        // the activity id alone must block a duplicate log.
        let alreadyIngested = RunLog(
            sessionId: UUID(),
            completedAt: runDay,
            distanceKm: 12.03,
            garminActivityId: "19519498613",
            source: .garmin,
            needsConfirmation: true
        )
        modelContext.insert(plannedRun)
        modelContext.insert(alreadyIngested)
        try modelContext.save()

        let matched = try matchGarminActivities(
            [garminActivityFixture(startTime: "2026-06-08 07:01:33")],
            sessions: [plannedRun],
            existingRunLogs: [alreadyIngested],
            in: modelContext,
            calendar: calendar
        )
        try modelContext.save()

        XCTAssertEqual(matched, 0)
        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<RunLog>()).count, 1)
        XCTAssertEqual(plannedRun.status, .planned)
    }

    func testMatchGarminActivitiesMatchesClosestPlannedDistance() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let runDay = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 8, hour: 9)))
        let shortRun = plannedRunFixture(scheduledDate: runDay, distanceKm: 8, title: "Easy shakeout")
        let longRun = plannedRunFixture(scheduledDate: runDay, distanceKm: 21, title: "Long run")
        modelContext.insert(shortRun)
        modelContext.insert(longRun)
        try modelContext.save()

        let matched = try matchGarminActivities(
            [garminActivityFixture(startTime: "2026-06-08 07:01:33", distanceKm: 20.5)],
            sessions: [shortRun, longRun],
            existingRunLogs: [],
            in: modelContext,
            calendar: calendar
        )
        try modelContext.save()

        XCTAssertEqual(matched, 1)
        let logs = try modelContext.fetch(FetchDescriptor<RunLog>())
        XCTAssertEqual(logs.count, 1)
        XCTAssertEqual(logs.first?.sessionId, longRun.id, "The closest planned distance wins")
        XCTAssertEqual(shortRun.status, .planned)
        XCTAssertEqual(longRun.status, .planned)
    }

    func testMatchGarminActivitiesIgnoresActivityWithoutSameDayPlannedRun() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let activityDay = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 8, hour: 9)))
        let dayAfter = try XCTUnwrap(calendar.date(byAdding: .day, value: 1, to: activityDay))
        let strengthToday = WorkoutSession(
            scheduledDate: activityDay,
            title: "Pull day",
            weekIndex: 0,
            focus: .pull,
            summary: "AI: Strength session"
        )
        let runTomorrow = plannedRunFixture(scheduledDate: dayAfter, distanceKm: 12)
        let completedRunToday = plannedRunFixture(scheduledDate: activityDay, distanceKm: 12, title: "Already logged run")
        completedRunToday.status = .completed
        modelContext.insert(strengthToday)
        modelContext.insert(runTomorrow)
        modelContext.insert(completedRunToday)
        try modelContext.save()

        let matched = try matchGarminActivities(
            [garminActivityFixture(startTime: "2026-06-08 07:01:33")],
            sessions: [strengthToday, runTomorrow, completedRunToday],
            existingRunLogs: [],
            in: modelContext,
            calendar: calendar
        )
        try modelContext.save()

        XCTAssertEqual(matched, 0, "Unplanned runs are ignored; only planned running sessions on the same day match")
        XCTAssertTrue(try modelContext.fetch(FetchDescriptor<RunLog>()).isEmpty)
    }

    func testMatchGarminActivitiesClaimsEachSessionOnceAndSkipsNonRunningTypes() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let runDay = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 6, day: 8, hour: 9)))
        let plannedRun = plannedRunFixture(scheduledDate: runDay, distanceKm: 12)
        modelContext.insert(plannedRun)
        try modelContext.save()

        let matched = try matchGarminActivities(
            [
                garminActivityFixture(id: "111", startTime: "2026-06-08 06:00:00", activityType: "cycling"),
                garminActivityFixture(id: "222", startTime: "2026-06-08 07:01:33"),
                garminActivityFixture(id: "333", startTime: "2026-06-08 18:30:00", distanceKm: 5.1)
            ],
            sessions: [plannedRun],
            existingRunLogs: [],
            in: modelContext,
            calendar: calendar
        )
        try modelContext.save()

        XCTAssertEqual(matched, 1, "One activity per session per batch; non-running types never match")
        let logs = try modelContext.fetch(FetchDescriptor<RunLog>())
        XCTAssertEqual(logs.count, 1)
        XCTAssertEqual(logs.first?.garminActivityId, "222")

        // A session already holding a pending log is not a candidate on later syncs either.
        let rematch = try matchGarminActivities(
            [garminActivityFixture(id: "444", startTime: "2026-06-08 19:00:00")],
            sessions: [plannedRun],
            existingRunLogs: logs,
            in: modelContext,
            calendar: calendar
        )

        XCTAssertEqual(rematch, 0)
        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<RunLog>()).count, 1)
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
        XCTAssertEqual(rank.consistencyScore, 90)
        XCTAssertEqual(rank.bestStreak, 9)
    }
}

private func wellnessDayFixture(
    date: String,
    sleepScore: Int = 82,
    sleepSeconds: Int = 27_360,
    hrvStatus: String = "BALANCED",
    hrvMs: Int = 52,
    bodyBattery: Int = 71,
    trainingReadiness: Int = 64,
    restingHr: Int = 47
) -> GarminWellnessDayResponse {
    GarminWellnessDayResponse(
        date: date,
        sleepScore: sleepScore,
        sleepSeconds: sleepSeconds,
        hrvStatus: hrvStatus,
        hrvMs: hrvMs,
        bodyBattery: bodyBattery,
        trainingReadiness: trainingReadiness,
        restingHr: restingHr
    )
}

private func garminActivityFixture(
    id: String = "19519498613",
    startTime: String,
    activityType: String = "running",
    distanceKm: Double = 12.03,
    movingSeconds: Int = 4_480,
    elevationGainM: Int = 156,
    averageHr: Int = 148,
    averagePaceSecPerKm: Int = 374,
    name: String = "Utrecht Hardlopen"
) -> GarminActivityResponse {
    GarminActivityResponse(
        garminActivityId: id,
        startTime: startTime,
        activityType: activityType,
        distanceKm: distanceKm,
        movingSeconds: movingSeconds,
        elevationGainM: elevationGainM,
        averageHr: averageHr,
        averagePaceSecPerKm: averagePaceSecPerKm,
        name: name
    )
}

private func plannedRunFixture(scheduledDate: Date, distanceKm: Double, title: String = "Easy run") -> WorkoutSession {
    WorkoutSession(
        scheduledDate: scheduledDate,
        title: title,
        weekIndex: 0,
        focus: .mixed,
        summary: "AI: Easy aerobic run",
        discipline: .running,
        runKind: .easy,
        plannedDistanceKm: distanceKm
    )
}
