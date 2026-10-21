import SwiftData
import XCTest
@testable import FitnessApp

/// "Start a new plan": history stays, the open plan goes, the coach gets the
/// new inputs and the block start.
@MainActor
final class NewPlanTests: XCTestCase {
    private let calendar = Calendar.current
    private var now: Date!
    private var queueDefaults: UserDefaults!
    private var queueSuiteName: String!

    override func setUp() {
        super.setUp()
        // Mid-morning, so "earlier today" and "later today" are both today.
        now = calendar.date(bySettingHour: 10, minute: 0, second: 0, of: Date())
        queueSuiteName = "NewPlanTests-\(UUID().uuidString)"
        queueDefaults = UserDefaults(suiteName: queueSuiteName)
    }

    override func tearDown() {
        queueDefaults.removePersistentDomain(forName: queueSuiteName)
        super.tearDown()
    }

    func testStartNewPlanKeepsHistoryAndReplacesTheOpenPlan() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext
        let profile = profileFixture()
        modelContext.insert(profile)
        let rank = RankState(consistencyScore: 42, streak: 3, bestStreak: 5)
        modelContext.insert(rank)

        let completed = insertSession("Pull Capacity", day: -3, status: .completed, in: modelContext)
        let missed = insertSession("Mixed Session", day: -2, status: .missed, in: modelContext)
        let overdue = insertSession("Core Control", day: -1, status: .planned, in: modelContext)
        let doneToday = insertSession("Easy Run", day: 0, status: .completed, discipline: .running, in: modelContext)
        let openToday = insertSession("Push Volume", day: 0, status: .planned, in: modelContext)
        let pushedRun = insertSession("Long Run", day: 2, status: .planned, discipline: .running, garminWorkoutId: "garmin-123", in: modelContext)
        let unpushedRun = insertSession("Easy Run", day: 3, status: .planned, discipline: .running, in: modelContext)
        let futureStrength = insertSession("Pull Capacity", day: 4, status: .planned, in: modelContext)

        let log = PerformanceLog(sessionId: completed.id, completedAt: day(-3), pullUps: 8, pushUps: 28, plankSeconds: 95, rpe: 7, painLevel: 0, fatigueLevel: 5, notes: "Kept")
        modelContext.insert(log)
        modelContext.insert(RunLog(sessionId: doneToday.id, completedAt: day(0), distanceKm: 8, movingSeconds: 2_800))
        modelContext.insert(GarminDailySnapshot(date: calendar.startOfDay(for: now), sleepScore: 80))
        modelContext.insert(CoachChatMessage(role: .user, text: "How is my week?"))
        let plan = CoachPlan(weekStart: calendar.startOfDay(for: now), summary: "Old plan", source: .ai, validationStatus: .accepted)
        modelContext.insert(plan)
        modelContext.insert(CoachDecision(planId: plan.id, rationale: "Old plan", safetyFlags: []))
        modelContext.insert(CoachVerdict(sourceLogId: log.id, headline: "Back on track", summary: "", latestChange: "", recommendation: "", shouldUpdatePlan: false, contextState: "building", safetyFlags: []))
        let raceGoal = RaceGoal(name: "Eiger Ultra 51K", raceDate: day(98), distanceKm: 51, elevationGainM: 3_100, baselineWeeklyKm: 35, longestRecentRunKm: 16.4)
        modelContext.insert(raceGoal)
        try modelContext.save()

        var inputs = PlanInputs(profile: profile, raceGoal: raceGoal, current: StrengthNumbers(pullUps: 8, pushUps: 28, plankSeconds: 95))
        inputs.goalPullUps = 30
        inputs.targetDate = day(200)
        inputs.trainingDays = [.monday, .thursday, .saturday]
        inputs.sessionMinutes = 45
        inputs.equipment = [.pullUpBar, .resistanceBand]
        inputs.painNotes = "  Left knee after long descents.  "
        inputs.raceName = "Lavaredo 80K"
        inputs.raceDate = day(140)
        inputs.raceDistanceKm = 80
        inputs.raceElevationGainM = 4_600
        inputs.runningDays = [.wednesday, .sunday]
        inputs.longRunDay = .saturday // not a running day: moves to Sunday

        let queue = GarminStaleWorkoutQueue(defaults: queueDefaults)
        let reset = try startNewPlan(with: inputs, profile: profile, in: modelContext, staleWorkoutQueue: queue, now: now)

        // The open plan from today on is gone, with its blocks and sets.
        let removedIds: Set<UUID> = [openToday.id, pushedRun.id, unpushedRun.id, futureStrength.id]
        XCTAssertEqual(reset.removedSessionCount, 4)
        let sessionIds = Set(try modelContext.fetch(FetchDescriptor<WorkoutSession>()).map(\.id))
        XCTAssertEqual(sessionIds, [completed.id, missed.id, overdue.id, doneToday.id])
        let blocks = try modelContext.fetch(FetchDescriptor<WorkoutBlock>())
        let prescriptions = try modelContext.fetch(FetchDescriptor<SetPrescription>())
        XCTAssertTrue(blocks.allSatisfy { !removedIds.contains($0.sessionId) })
        XCTAssertTrue(prescriptions.allSatisfy { !removedIds.contains($0.sessionId) })
        XCTAssertEqual(Set(blocks.map(\.sessionId)), [completed.id, missed.id, overdue.id, doneToday.id])
        XCTAssertEqual(Set(prescriptions.map(\.sessionId)), [completed.id, missed.id, overdue.id, doneToday.id])

        // Only the pushed watch workout needs deleting on Garmin.
        XCTAssertEqual(reset.stalePushedGarminIds, ["garmin-123"])
        XCTAssertEqual(queue.pending, ["garmin-123"])

        // History stays.
        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<PerformanceLog>()).map(\.id), [log.id])
        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<RunLog>()).count, 1)
        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<GarminDailySnapshot>()).count, 1)
        XCTAssertEqual(try modelContext.fetch(FetchDescriptor<CoachChatMessage>()).map(\.text), ["How is my week?"])
        let ranks = try modelContext.fetch(FetchDescriptor<RankState>())
        XCTAssertEqual(ranks.map(\.consistencyScore), [42])
        XCTAssertEqual(ranks.map(\.bestStreak), [5])

        // The old plan, its decisions and the read that judged it are cleared.
        XCTAssertTrue(try modelContext.fetch(FetchDescriptor<CoachPlan>()).isEmpty)
        XCTAssertTrue(try modelContext.fetch(FetchDescriptor<CoachDecision>()).isEmpty)
        XCTAssertTrue(try modelContext.fetch(FetchDescriptor<CoachVerdict>()).isEmpty)

        // The profile carries the new inputs and a new block start.
        XCTAssertEqual(profile.baselinePullUps, 8)
        XCTAssertEqual(profile.baselinePushUps, 28)
        XCTAssertEqual(profile.baselinePlankSeconds, 95)
        XCTAssertEqual(profile.goalPullUps, 30)
        XCTAssertEqual(profile.targetDate, day(200))
        XCTAssertEqual(profile.trainingDays, [.monday, .thursday, .saturday])
        XCTAssertEqual(profile.weeklySessions, 3)
        XCTAssertEqual(profile.sessionMinutes, 45)
        XCTAssertEqual(profile.equipment, [.pullUpBar, .resistanceBand])
        XCTAssertEqual(profile.painNotes, "Left knee after long descents.")
        XCTAssertEqual(profile.runningDays, [.wednesday, .sunday])
        XCTAssertEqual(profile.longRunDay, .sunday)
        XCTAssertEqual(profile.planBlockStartedAt, now)

        // The race goal is edited in place; run-history baselines stay.
        let goals = try modelContext.fetch(FetchDescriptor<RaceGoal>())
        XCTAssertEqual(goals.map(\.id), [raceGoal.id])
        XCTAssertEqual(raceGoal.name, "Lavaredo 80K")
        XCTAssertEqual(raceGoal.raceDate, day(140))
        XCTAssertEqual(raceGoal.distanceKm, 80)
        XCTAssertEqual(raceGoal.elevationGainM, 4_600)
        XCTAssertEqual(raceGoal.baselineWeeklyKm, 35)
        XCTAssertEqual(raceGoal.longestRecentRunKm, 16.4)
    }

    func testStartNewPlanWithoutARaceRemovesTheRaceGoal() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext
        let profile = profileFixture()
        modelContext.insert(profile)
        let raceGoal = RaceGoal(name: "Eiger Ultra 51K", raceDate: day(98), distanceKm: 51)
        modelContext.insert(raceGoal)
        try modelContext.save()

        var inputs = PlanInputs(profile: profile, raceGoal: raceGoal, current: StrengthNumbers(pullUps: 5, pushUps: 20, plankSeconds: 60))
        inputs.isTrainingForRace = false
        let reset = try startNewPlan(with: inputs, profile: profile, in: modelContext, staleWorkoutQueue: GarminStaleWorkoutQueue(defaults: queueDefaults), now: now)

        XCTAssertEqual(reset, NewPlanReset(removedSessionCount: 0, stalePushedGarminIds: []))
        XCTAssertTrue(try modelContext.fetch(FetchDescriptor<RaceGoal>()).isEmpty)
        XCTAssertTrue(GarminStaleWorkoutQueue(defaults: queueDefaults).pending.isEmpty)
    }

    func testStartNewPlanAddsARaceGoalWhenThereWasNone() throws {
        let container = try ModelContainerFactory.make(inMemory: true)
        let modelContext = container.mainContext
        let profile = profileFixture()
        profile.runningDays = []
        modelContext.insert(profile)
        try modelContext.save()

        var inputs = PlanInputs(profile: profile, raceGoal: nil, current: StrengthNumbers(pullUps: 5, pushUps: 20, plankSeconds: 60))
        XCTAssertFalse(inputs.isTrainingForRace)
        XCTAssertEqual(inputs.runningDays, [.tuesday, .thursday, .saturday])
        inputs.isTrainingForRace = true
        inputs.raceName = " Zugspitz Trail "
        inputs.raceDate = day(70)
        try startNewPlan(with: inputs, profile: profile, in: modelContext, staleWorkoutQueue: GarminStaleWorkoutQueue(defaults: queueDefaults), now: now)

        let goal = try XCTUnwrap(try modelContext.fetch(FetchDescriptor<RaceGoal>()).first)
        XCTAssertEqual(goal.name, "Zugspitz Trail")
        XCTAssertEqual(goal.raceDate, day(70))
        XCTAssertEqual(goal.distanceKm, 50)
        XCTAssertEqual(profile.runningDays, [.tuesday, .thursday, .saturday])
        XCTAssertEqual(profile.longRunDay, .saturday)
    }

    func testPlanBlockStartReadsAsCreationDateUntilANewPlanStarts() {
        let createdAt = day(-40)
        let profile = profileFixture(createdAt: createdAt)

        XCTAssertNil(profile.planBlockStartedAtRaw)
        XCTAssertEqual(profile.planBlockStartedAt, createdAt)

        profile.planBlockStartedAt = now
        XCTAssertEqual(profile.planBlockStartedAtRaw, now)
        XCTAssertEqual(profile.planBlockStartedAt, now)
    }

    func testCurrentNumbersPreferRecentBestThenLatestThenProfile() {
        let profile = profileFixture()
        let logs = [
            // Recent: the best counts, not the latest.
            logFixture(day: -3, pullUps: 7, pushUps: 0, plankSeconds: 0, logged: (true, false, false)),
            logFixture(day: -10, pullUps: 9, pushUps: 0, plankSeconds: 0, logged: (true, false, false)),
            // Older than four weeks: only the latest counts.
            logFixture(day: -40, pullUps: 20, pushUps: 31, plankSeconds: 0, logged: (true, true, false)),
            logFixture(day: -60, pullUps: 20, pushUps: 40, plankSeconds: 0, logged: (true, true, false))
        ]

        let numbers = currentStrengthNumbers(profile: profile, logs: logs, now: now)

        XCTAssertEqual(numbers, StrengthNumbers(pullUps: 9, pushUps: 31, plankSeconds: 60))
    }

    func testPlanInputsPrefillFromProfileAndRaceGoal() {
        let profile = profileFixture()
        profile.sessionMinutes = 60
        let raceGoal = RaceGoal(name: "Eiger Ultra 51K", raceDate: day(98), distanceKm: 51.4, elevationGainM: 3_100)

        let inputs = PlanInputs(profile: profile, raceGoal: raceGoal, current: StrengthNumbers(pullUps: 8, pushUps: 28, plankSeconds: 95))

        XCTAssertEqual(inputs.pullUps, 8)
        XCTAssertEqual(inputs.pushUps, 28)
        XCTAssertEqual(inputs.plankSeconds, 95)
        XCTAssertEqual(inputs.goalPullUps, 50)
        XCTAssertEqual(inputs.targetDate, profile.targetDate)
        XCTAssertEqual(inputs.trainingDays, [.monday, .wednesday, .friday, .saturday])
        XCTAssertEqual(inputs.sessionMinutes, 60)
        XCTAssertEqual(inputs.equipment, [.pullUpBar, .yogaMat])
        XCTAssertEqual(inputs.painNotes, "Keep shoulders warm before pull work.")
        XCTAssertTrue(inputs.isTrainingForRace)
        XCTAssertEqual(inputs.raceName, "Eiger Ultra 51K")
        XCTAssertEqual(inputs.raceDistanceKm, 51)
        XCTAssertEqual(inputs.raceElevationGainM, 3_100)
        XCTAssertEqual(inputs.runningDays, [.tuesday, .thursday, .saturday])
        XCTAssertEqual(inputs.longRunDay, .saturday)
        XCTAssertNil(inputs.blockingReason)
        XCTAssertEqual(
            inputs.applyingStrengthNumbers(StrengthNumbers(pullUps: 1, pushUps: 2, plankSeconds: 3)).pullUps,
            1
        )
    }

    // MARK: Fixtures

    private func day(_ offset: Int) -> Date {
        calendar.date(byAdding: .day, value: offset, to: now) ?? now
    }

    private func profileFixture(createdAt: Date? = nil) -> UserProfile {
        let profile = UserProfile(
            createdAt: createdAt ?? day(-30),
            name: LockinCurrentUser.displayName,
            targetDate: day(365),
            weeklySessions: 4,
            trainingDays: [.monday, .wednesday, .friday, .saturday],
            equipment: [.pullUpBar, .yogaMat],
            baselinePullUps: 5,
            baselinePushUps: 20,
            baselinePlankSeconds: 60,
            painNotes: "Keep shoulders warm before pull work."
        )
        profile.runningDays = [.tuesday, .thursday, .saturday]
        profile.longRunDay = .saturday
        return profile
    }

    @discardableResult
    private func insertSession(
        _ title: String,
        day offset: Int,
        status: SessionStatus,
        discipline: Discipline = .strength,
        garminWorkoutId: String = "",
        in modelContext: ModelContext
    ) -> WorkoutSession {
        let session = WorkoutSession(
            scheduledDate: day(offset),
            title: title,
            weekIndex: 0,
            focus: .mixed,
            status: status,
            summary: "AI: \(title)",
            discipline: discipline,
            garminWorkoutId: garminWorkoutId
        )
        modelContext.insert(session)
        let block = WorkoutBlock(sessionId: session.id, orderIndex: 0, name: "Main", detail: title)
        modelContext.insert(block)
        modelContext.insert(SetPrescription(
            sessionId: session.id,
            blockId: block.id,
            orderIndex: 0,
            exercise: .pullUp,
            sets: 3,
            targetReps: 5,
            restSeconds: 90,
            intensity: "Moderate"
        ))
        return session
    }

    private func logFixture(day offset: Int, pullUps: Int, pushUps: Int, plankSeconds: Int, logged: (Bool, Bool, Bool)) -> PerformanceLog {
        PerformanceLog(
            sessionId: UUID(),
            completedAt: day(offset),
            pullUps: pullUps,
            pushUps: pushUps,
            plankSeconds: plankSeconds,
            loggedPullUps: logged.0,
            loggedPushUps: logged.1,
            loggedPlankSeconds: logged.2,
            rpe: 7,
            painLevel: 0,
            fatigueLevel: 5,
            notes: ""
        )
    }
}
