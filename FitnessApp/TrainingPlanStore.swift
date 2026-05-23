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
            summary: sessionPlan.summary
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
                    intensity: setPlan.intensity
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
    rank.xp = max(0, rank.xp + outcome.xpDelta)
    rank.consistencyScore = max(0, rank.consistencyScore + outcome.consistencyDelta)
    rank.penaltyPoints = max(0, rank.penaltyPoints + outcome.penaltyDelta)
    if outcome.streakDelta < 0 {
        rank.streak = 0
    } else {
        rank.streak = max(0, rank.streak + outcome.streakDelta)
    }
    rank.rank = TrainingEngine().rank(for: rank.xp)
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

func workoutInstruction(_ item: SetPrescription) -> String {
    "Do \(workoutTargetText(item)). Rest \(durationText(seconds: item.restSeconds)) after each set. Keep the effort at \(item.intensity.lowercased())."
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

func exerciseCue(_ exercise: ExerciseKind) -> String {
    switch exercise {
    case .pullUp:
        "Start from a dead hang, pull until your chin clearly passes the bar, then lower under control to straight arms. No kipping or half reps."
    case .pushUp:
        "Keep one locked body line, lower to full depth, and press to full lockout. Stop the set when hips sag or range shortens."
    case .plank:
        "Hold ribs down, glutes tight, and shoulders stacked. End the set when hips sag, form shakes apart, or you have to hold your breath."
    case .scapularPull:
        "Hang with straight arms, pull the shoulder blades down and back without bending the elbows, pause, then release under control."
    case .hollowHold:
        "Press the low back into the floor and keep ribs down. Extend arms and legs only as far as you can control."
    case .inclinePushUp:
        "Place hands on the raised surface, keep a straight body line, touch chest to the surface, and finish each rep at lockout."
    case .pikePushUp:
        "Keep hips high, send the head between the hands, and press through the shoulders without collapsing the neck."
    case .deadHang:
        "Hang with straight arms and active shoulders. Stop before grip slips or shoulder pain appears."
    case .shoulderMobility:
        "Move slowly through a comfortable range. This is preparation work, not a max-effort drill."
    }
}

func workoutLoggingNote(_ exercise: ExerciseKind) -> String {
    switch exercise {
    case .pullUp:
        "Log pull-ups after this session because this workout trains the exact goal movement."
    case .pushUp:
        "Log push-ups after this session because this workout trains the exact goal movement."
    case .plank:
        "Log plank time after this session because this workout trains the exact goal hold."
    default:
        "This is support work. Do it as prescribed, but it does not replace a goal max test."
    }
}
