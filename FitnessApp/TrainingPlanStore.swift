import Foundation
import SwiftData

func currentWeekStart(date: Date = Date(), calendar: Calendar = .current) -> Date {
    calendar.startOfDay(for: calendar.dateInterval(of: .weekOfYear, for: date)?.start ?? date)
}

func rollingPlanStart(date: Date = Date(), calendar: Calendar = .current) -> Date {
    calendar.startOfDay(for: date)
}

func rollingPlanEnd(date: Date = Date(), calendar: Calendar = .current) -> Date {
    calendar.date(byAdding: .day, value: 7, to: rollingPlanStart(date: date, calendar: calendar)) ?? rollingPlanStart(date: date, calendar: calendar)
}

func duePlannedSession(from sessions: [WorkoutSession], now: Date = Date(), calendar: Calendar = .current) -> WorkoutSession? {
    let startOfToday = calendar.startOfDay(for: now)
    let endOfToday = calendar.dateInterval(of: .day, for: now)?.end ?? now
    return sessions
        .filter { $0.status == .planned && $0.scheduledDate >= startOfToday && $0.scheduledDate < endOfToday }
        .sorted { $0.scheduledDate < $1.scheduledDate }
        .first
}

func overduePlannedSessions(from sessions: [WorkoutSession], now: Date = Date(), calendar: Calendar = .current) -> [WorkoutSession] {
    let startOfToday = calendar.startOfDay(for: now)
    return sessions
        .filter { $0.status == .planned && $0.scheduledDate < startOfToday }
        .sorted { $0.scheduledDate < $1.scheduledDate }
}

func nextFuturePlannedSession(from sessions: [WorkoutSession], now: Date = Date(), calendar: Calendar = .current) -> WorkoutSession? {
    let endOfToday = calendar.dateInterval(of: .day, for: now)?.end ?? now
    return sessions
        .filter { $0.status == .planned && $0.scheduledDate >= endOfToday }
        .sorted { $0.scheduledDate < $1.scheduledDate }
        .first
}

@discardableResult
func markOverduePlannedSessionsMissed(
    from sessions: [WorkoutSession],
    logs: [PerformanceLog],
    profile: UserProfile,
    ranks: [RankState],
    in modelContext: ModelContext,
    now: Date = Date(),
    calendar: Calendar = .current
) throws -> Int {
    let overdueSessions = overduePlannedSessions(from: sessions, now: now, calendar: calendar)
    guard !overdueSessions.isEmpty else { return 0 }

    let latestLog = logs.sorted { $0.completedAt > $1.completedAt }.first
    let rank = ranks.first ?? RankState()
    if ranks.isEmpty {
        modelContext.insert(rank)
    }

    for session in overdueSessions {
        session.status = .missed
        applyScoreOutcome(missedSessionOutcome(profile: profile, latestLog: latestLog), to: rank)
    }

    try modelContext.save()
    return overdueSessions.count
}

func missedSessionOutcome(profile: UserProfile, latestLog: PerformanceLog?) -> ScoreOutcome {
    TrainingEngine().score(
        log: SessionLogInput(
            completed: false,
            pullUps: latestLog?.pullUps ?? profile.baselinePullUps,
            pushUps: latestLog?.pushUps ?? profile.baselinePushUps,
            plankSeconds: latestLog?.plankSeconds ?? profile.baselinePlankSeconds,
            rpe: 1,
            painLevel: 0,
            fatigueLevel: 1
        ),
        plannedSession: nil
    )
}

func persist(
    plan: WeeklyPlan,
    in modelContext: ModelContext,
    source: PlanSource = .rules,
    replacingFuturePlannedSessions: Bool = false,
    maxSessions: Int? = nil
) throws {
    if replacingFuturePlannedSessions {
        try deleteFuturePlannedSessions(in: modelContext, for: plan.weekStart)
    }

    let coachPlan = CoachPlan(weekStart: plan.weekStart, summary: plan.summary, source: source, validationStatus: .accepted)
    modelContext.insert(coachPlan)

    let sessionPlans = maxSessions.map { Array(plan.sessions.prefix($0)) } ?? plan.sessions
    for sessionPlan in sessionPlans {
        let session = WorkoutSession(
            id: sessionPlan.id,
            scheduledDate: sessionPlan.date,
            title: sessionPlan.title,
            weekIndex: sessionPlan.weekIndex,
            focus: sessionPlan.focus,
            summary: sessionPlan.summary,
            plannedEffort: sessionPlan.plannedEffort
        )
        modelContext.insert(session)

        for (blockIndex, blockPlan) in sessionPlan.blocks.enumerated() {
            let block = WorkoutBlock(sessionId: session.id, orderIndex: blockIndex, name: blockPlan.name, detail: blockPlan.detail)
            modelContext.insert(block)

            for (setIndex, setPlan) in blockPlan.sets.enumerated() {
                modelContext.insert(SetPrescription(
                    sessionId: session.id,
                    blockId: block.id,
                    orderIndex: blockIndex * 100 + setIndex,
                    exercise: setPlan.exercise,
                    sets: setPlan.sets,
                    targetReps: setPlan.reps,
                    targetSeconds: setPlan.seconds,
                    restSeconds: setPlan.restSeconds,
                    intensity: setPlan.intensity,
                    plannedEffort: setPlan.plannedEffort
                ))
            }
        }
    }
}

@discardableResult
func deleteNonAIPlannedSessions(from sessions: [WorkoutSession], in modelContext: ModelContext) throws -> Int {
    let sessionsToDelete = sessions.filter { $0.status == .planned && !$0.summary.hasPrefix("AI:") }
    guard !sessionsToDelete.isEmpty else { return 0 }

    let sessionIds = Set(sessionsToDelete.map(\.id))
    let prescriptions = try modelContext.fetch(FetchDescriptor<SetPrescription>())
    for prescription in prescriptions where sessionIds.contains(prescription.sessionId) {
        modelContext.delete(prescription)
    }

    let blocks = try modelContext.fetch(FetchDescriptor<WorkoutBlock>())
    for block in blocks where sessionIds.contains(block.sessionId) {
        modelContext.delete(block)
    }

    for session in sessionsToDelete {
        modelContext.delete(session)
    }

    try modelContext.save()
    return sessionsToDelete.count
}

private func deleteFuturePlannedSessions(in modelContext: ModelContext, for weekStart: Date) throws {
    let calendar = Calendar.current
    let start = calendar.startOfDay(for: weekStart)
    let end = calendar.date(byAdding: .day, value: 7, to: start) ?? start
    let today = calendar.startOfDay(for: Date())

    let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())
    let sessionsToDelete = sessions.filter {
        $0.status == .planned &&
        $0.scheduledDate >= start &&
        $0.scheduledDate < end &&
        $0.scheduledDate >= today
    }

    let sessionIds = Set(sessionsToDelete.map(\.id))
    let prescriptions = try modelContext.fetch(FetchDescriptor<SetPrescription>())
    for prescription in prescriptions where sessionIds.contains(prescription.sessionId) {
        modelContext.delete(prescription)
    }

    let blocks = try modelContext.fetch(FetchDescriptor<WorkoutBlock>())
    for block in blocks where sessionIds.contains(block.sessionId) {
        modelContext.delete(block)
    }

    for session in sessionsToDelete {
        modelContext.delete(session)
    }
}

func wipeAllData(in modelContext: ModelContext) throws {
    try deleteAll(CoachVerdict.self, in: modelContext)
    try deleteAll(CoachDecision.self, in: modelContext)
    try deleteAll(CoachPlan.self, in: modelContext)
    try deleteAll(PerformanceLog.self, in: modelContext)
    try deleteAll(SetPrescription.self, in: modelContext)
    try deleteAll(WorkoutBlock.self, in: modelContext)
    try deleteAll(WorkoutSession.self, in: modelContext)
    try deleteAll(RankState.self, in: modelContext)
    try deleteAll(UserProfile.self, in: modelContext)
}

func applyScoreOutcome(_ outcome: ScoreOutcome, to rank: RankState) {
    rank.consistencyScore = max(0, rank.consistencyScore + outcome.consistencyDelta)
    rank.penaltyPoints = max(0, rank.penaltyPoints + outcome.penaltyDelta)
    if outcome.streakDelta < 0 {
        rank.streak = 0
    } else {
        rank.streak = max(0, rank.streak + outcome.streakDelta)
    }
    rank.bestStreak = max(rank.bestStreak, rank.streak)
    rank.updatedAt = Date()
}

private func deleteAll<T: PersistentModel>(_ modelType: T.Type, in modelContext: ModelContext) throws {
    let items = try modelContext.fetch(FetchDescriptor<T>())
    for item in items {
        modelContext.delete(item)
    }
}

func prescriptionText(_ item: SetPrescription) -> String {
    if item.targetSeconds > 0 {
        return "\(item.sets) x \(format(seconds: item.targetSeconds))"
    }
    return "\(item.sets) x \(item.targetReps)"
}

func workoutTargetText(_ item: SetPrescription) -> String {
    if item.targetSeconds > 0 {
        return "\(item.sets) sets of \(durationText(seconds: item.targetSeconds)) each"
    }
    return "\(item.sets) sets of \(item.targetReps) strict reps each"
}

func durationText(seconds: Int) -> String {
    if seconds < 60 {
        return "\(seconds) sec"
    }
    let minutes = seconds / 60
    let remainingSeconds = seconds % 60
    if remainingSeconds == 0 {
        return "\(minutes) min"
    }
    return "\(minutes) min \(remainingSeconds) sec"
}

func format(seconds: Int) -> String {
    let minutes = seconds / 60
    let seconds = seconds % 60
    return "\(minutes):" + String(format: "%02d", seconds)
}

func exerciseMovementDescription(_ exercise: ExerciseKind) -> String {
    switch exercise {
    case .pullUp:
        "A vertical pull on a bar: start hanging with straight arms, pull until your chin clears the bar, then lower back to straight arms."
    case .pushUp:
        "A floor press: keep your body in one straight line, lower your chest toward the floor, then press back to locked arms."
    case .plank:
        "A timed front hold: brace your abs and glutes, keep ribs down, and hold a straight line from shoulders to heels."
    case .scapularPull:
        "A small pull from a dead hang: keep elbows straight, pull the shoulder blades down and back, pause, then release."
    case .hollowHold:
        "A floor core hold: lie on your back, press your low back into the floor, lift shoulders and legs, and hold the hollow shape."
    case .inclinePushUp:
        "A push-up with hands on a raised surface: lower your chest to the surface, then press back up with a straight body line."
    case .pikePushUp:
        "A shoulder-focused push-up: keep hips high, lower your head between your hands, then press back up without losing the pike shape."
    case .deadHang:
        "A timed hang from a bar: grip the bar, keep arms straight, keep shoulders active, and hold without swinging."
    case .shoulderMobility:
        "Slow arm circles: raise both arms forward to overhead, sweep them out and down, then reverse the direction. Stay pain-free."
    }
}
