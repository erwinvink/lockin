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

    let calendar = Calendar.current
    let replacementStart = replacingFuturePlannedSessions
        ? calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: Date()))
        : nil
    let sessionPlans = maxSessions.map { Array(plan.sessions.prefix($0)) } ?? plan.sessions
    for sessionPlan in sessionPlans {
        if let replacementStart, sessionPlan.date < replacementStart {
            continue
        }

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

func persistRunningPlan(
    response: RunningWeekResponse,
    weekStart: Date,
    in modelContext: ModelContext,
    replacingFuturePlannedRuns: Bool = true
) throws {
    if replacingFuturePlannedRuns {
        try deleteFuturePlannedRuns(in: modelContext, for: weekStart)
    }

    let calendar = Calendar.current
    let replacementStart = replacingFuturePlannedRuns
        ? calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: Date()))
        : nil
    for session in response.sessions {
        let scheduledDate = calendar.date(byAdding: .day, value: session.dayOffset, to: calendar.startOfDay(for: weekStart)) ?? weekStart
        if let replacementStart, scheduledDate < replacementStart {
            continue
        }

        modelContext.insert(RunningWorkout(
            scheduledDate: scheduledDate,
            title: session.title,
            kind: RunningWorkoutKind(rawValue: session.kind) ?? .easy,
            distanceKm: session.distanceKm,
            durationSeconds: session.durationMinutes * 60,
            elevationMeters: session.elevationMeters,
            zone: session.zone,
            notes: ([session.purpose] + session.notes).joined(separator: " ")
        ))
    }
}

@discardableResult
func deleteNonAIPlannedSessions(from sessions: [WorkoutSession], in modelContext: ModelContext) throws -> Int {
    let sessionsToDelete = sessions.filter { $0.status == .planned && !isCoachGeneratedSummary($0.summary) }
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

func isCoachGeneratedSummary(_ summary: String) -> Bool {
    let trimmed = summary.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.hasPrefix("Coach:") || trimmed.hasPrefix("AI:")
}

func displayPlanSummary(_ summary: String) -> String {
    let trimmed = summary.trimmingCharacters(in: .whitespacesAndNewlines)
    for prefix in ["Coach:", "AI:"] where trimmed.hasPrefix(prefix) {
        return trimmed.dropFirst(prefix.count).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return summary
}

private func deleteFuturePlannedRuns(in modelContext: ModelContext, for weekStart: Date) throws {
    let calendar = Calendar.current
    let start = calendar.startOfDay(for: weekStart)
    let end = calendar.date(byAdding: .day, value: 7, to: start) ?? start
    let today = calendar.startOfDay(for: Date())
    let tomorrow = calendar.date(byAdding: .day, value: 1, to: today) ?? today

    let runs = try modelContext.fetch(FetchDescriptor<RunningWorkout>())
    for run in runs where run.status == .planned && run.scheduledDate >= start && run.scheduledDate < end && run.scheduledDate >= tomorrow {
        modelContext.delete(run)
    }
}

private func deleteFuturePlannedSessions(in modelContext: ModelContext, for weekStart: Date) throws {
    let calendar = Calendar.current
    let start = calendar.startOfDay(for: weekStart)
    let end = calendar.date(byAdding: .day, value: 7, to: start) ?? start
    let today = calendar.startOfDay(for: Date())
    let tomorrow = calendar.date(byAdding: .day, value: 1, to: today) ?? today

    let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())
    let sessionsToDelete = sessions.filter {
        $0.status == .planned &&
        $0.scheduledDate >= start &&
        $0.scheduledDate < end &&
        $0.scheduledDate >= tomorrow
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
    try deleteAll(AchievementState.self, in: modelContext)
    try deleteAll(RunningLog.self, in: modelContext)
    try deleteAll(RunningWorkout.self, in: modelContext)
    try deleteAll(RunningProfile.self, in: modelContext)
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

func ensureAchievementStates(_ states: [AchievementState], in modelContext: ModelContext) -> [AchievementState] {
    var existing = Dictionary(uniqueKeysWithValues: states.map { ($0.kind, $0) })
    for kind in LockinAchievementKind.allCases where existing[kind] == nil {
        let state = AchievementState(kind: kind)
        modelContext.insert(state)
        existing[kind] = state
    }
    return LockinAchievementKind.allCases.compactMap { existing[$0] }
}

func updateAchievements(
    after log: PerformanceLog,
    rank: RankState,
    states: [AchievementState],
    in modelContext: ModelContext,
    calendar: Calendar = .current
) {
    let achievements = ensureAchievementStates(states, in: modelContext)

    for achievement in achievements {
        switch achievement.kind {
        case .consistencyKing:
            achievement.progress = max(achievement.progress, rank.streak)
        case .earlyRiser:
            if calendar.component(.hour, from: log.completedAt) < 8 {
                achievement.progress = 1
            }
        case .unbroken:
            if log.loggedPullUps {
                achievement.progress = max(achievement.progress, log.pullUps)
            }
        case .plankMaster:
            if log.loggedPlankSeconds {
                achievement.progress = max(achievement.progress, log.plankSeconds)
            }
        }

        if achievement.completedAt == nil && achievement.progress >= achievement.kind.target {
            achievement.completedAt = Date()
        }
        achievement.updatedAt = Date()
    }
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

func format(kilometers: Double) -> String {
    if kilometers.rounded() == kilometers {
        return "\(Int(kilometers))"
    }
    return String(format: "%.1f", kilometers)
}

func paceText(distanceKm: Double, durationSeconds: Int) -> String {
    guard distanceKm > 0, durationSeconds > 0 else { return "--" }
    return "\(format(seconds: Int(Double(durationSeconds) / distanceKm))) /km"
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

func exerciseWorkoutContext(_ exercise: ExerciseKind, block: WorkoutBlock?) -> String {
    let context = switch exercise {
    case .pullUp:
        "This is goal work for your pull-up number. Keep every rep strict enough to count."
    case .pushUp:
        "This is goal work for your push-up number. Stop before speed or depth turns sloppy."
    case .plank:
        "This is goal work for your plank time. Quality of the hold matters more than surviving ugly seconds."
    case .scapularPull:
        "This builds active shoulder position for stronger pull-up work."
    case .hollowHold:
        "This supports plank control and the body line you need in pull-ups and push-ups."
    case .inclinePushUp:
        "This builds push-up volume with less load than floor reps."
    case .pikePushUp:
        "This adds shoulder pressing strength to support harder push sessions."
    case .deadHang:
        "This builds grip and shoulder tolerance for pull-up work."
    case .shoulderMobility:
        "This prepares or restores your shoulders so the strength work stays clean."
    }

    guard let block else { return context }
    return "\(context) It sits in the \(block.name) block."
}

#if DEBUG
func seedLockinPreviewData(in modelContext: ModelContext) throws {
    try wipeAllData(in: modelContext)

    let calendar = Calendar.current
    let today = calendar.startOfDay(for: Date())

    func day(_ offset: Int, hour: Int = 9, minute: Int = 0) -> Date {
        let base = calendar.date(byAdding: .day, value: offset, to: today) ?? today
        var components = calendar.dateComponents([.year, .month, .day], from: base)
        components.hour = hour
        components.minute = minute
        return calendar.date(from: components) ?? base
    }

    let profile = UserProfile(
        name: "Alex Morgan",
        targetDate: calendar.date(byAdding: .month, value: 6, to: today) ?? today,
        weeklySessions: 4,
        equipment: [.pullUpBar, .resistanceBand, .dumbbells, .yogaMat],
        baselinePullUps: 12,
        baselinePushUps: 42,
        baselinePlankSeconds: 150,
        goalPullUps: 50,
        goalPushUps: 100,
        goalPlankSeconds: 300,
        strictFormAccepted: true,
        remindersEnabled: true,
        painNotes: "Left elbow can get irritated after high pull volume. Keep one rep in reserve."
    )
    modelContext.insert(profile)

    let runningProfile = RunningProfile(
        targetRaceName: "Comrades Marathon",
        raceDate: calendar.date(byAdding: .day, value: 7, to: today) ?? today,
        weeklyDistanceTargetKm: 42,
        longRunTargetKm: 28,
        easyPaceSecondsPerKm: 347,
        preferredTerrain: "Road and trail",
        injuryNotes: "Watch calves after hill sessions."
    )
    modelContext.insert(runningProfile)

    let rank = RankState(consistencyScore: 72, streak: 12, bestStreak: 28, penaltyPoints: 0)
    modelContext.insert(rank)

    modelContext.insert(AchievementState(kind: .consistencyKing, progress: 14, completedAt: day(-2, hour: 7)))
    modelContext.insert(AchievementState(kind: .earlyRiser, progress: 1, completedAt: day(-9, hour: 7)))
    modelContext.insert(AchievementState(kind: .unbroken, progress: 32))
    modelContext.insert(AchievementState(kind: .plankMaster, progress: 200))

    @discardableResult
    func addStrengthSession(
        offset: Int,
        hour: Int,
        title: String,
        focus: SessionFocus,
        status: SessionStatus = .planned,
        summary: String,
        prescriptions: [(ExerciseKind, Int, Int, Int, Int, String)]
    ) -> WorkoutSession {
        let session = WorkoutSession(
            scheduledDate: day(offset, hour: hour),
            title: title,
            weekIndex: 0,
            focus: focus,
            status: status,
            summary: summary
        )
        modelContext.insert(session)

        let block = WorkoutBlock(
            sessionId: session.id,
            orderIndex: 0,
            name: "Main Work",
            detail: "Leave one clean rep in reserve. Form decides the score."
        )
        modelContext.insert(block)

        for (index, item) in prescriptions.enumerated() {
            modelContext.insert(SetPrescription(
                sessionId: session.id,
                blockId: block.id,
                orderIndex: index,
                exercise: item.0,
                sets: item.1,
                targetReps: item.2,
                targetSeconds: item.3,
                restSeconds: item.4,
                intensity: item.5
            ))
        }

        return session
    }

    let todayPull = addStrengthSession(
        offset: 0,
        hour: 9,
        title: "Pull Strength",
        focus: .pull,
        summary: "Coach: Last week was strong. Leave one rep in reserve today.",
        prescriptions: [
            (.pullUp, 5, 5, 0, 120, "Strict"),
            (.deadHang, 3, 0, 30, 60, "Support")
        ]
    )

    _ = addStrengthSession(
        offset: 0,
        hour: 14,
        title: "Plank",
        focus: .core,
        summary: "Coach: Core stamina without fatigue.",
        prescriptions: [
            (.plank, 3, 0, 60, 75, "Controlled")
        ]
    )

    _ = addStrengthSession(
        offset: 1,
        hour: 18,
        title: "Mobility",
        focus: .recovery,
        summary: "Coach: Recovery work to keep shoulders clean.",
        prescriptions: [
            (.shoulderMobility, 2, 8, 0, 30, "Easy")
        ]
    )

    _ = addStrengthSession(
        offset: 2,
        hour: 9,
        title: "Push Strength",
        focus: .push,
        summary: "Coach: Build pushing volume without chasing failure.",
        prescriptions: [
            (.pushUp, 5, 14, 0, 90, "Moderate"),
            (.pikePushUp, 3, 6, 0, 90, "Support")
        ]
    )

    let completedStrength = [
        (-28, "Pull Strength", SessionFocus.pull, 18, 50, 155),
        (-21, "Push Strength", SessionFocus.push, 22, 54, 165),
        (-14, "Mixed Technique", SessionFocus.mixed, 25, 58, 176),
        (-7, "Pull Density", SessionFocus.pull, 29, 64, 190),
        (-3, "Push Strength", SessionFocus.push, 30, 66, 196),
        (-1, "Mixed technique and density", SessionFocus.mixed, 32, 68, 200)
    ]

    var latestLogId: UUID?
    for (offset, title, focus, pullUps, pushUps, plankSeconds) in completedStrength {
        let session = addStrengthSession(
            offset: offset,
            hour: offset == -1 ? 7 : 9,
            title: title,
            focus: focus,
            status: .completed,
            summary: "Completed strength session.",
            prescriptions: [
                (.pullUp, 4, max(3, pullUps / 8), 0, 120, "Strict"),
                (.pushUp, 4, max(8, pushUps / 5), 0, 90, "Moderate"),
                (.plank, 3, 0, max(45, plankSeconds / 3), 75, "Controlled")
            ]
        )
        let log = PerformanceLog(
            sessionId: session.id,
            completedAt: day(offset, hour: offset == -1 ? 7 : 9, minute: 30),
            pullUps: pullUps,
            pushUps: pushUps,
            plankSeconds: plankSeconds,
            rpe: 7,
            painLevel: 0,
            fatigueLevel: 5,
            notes: offset == -1 ? "Felt strong and steady. Hot conditions. Focused on fueling." : "Clean reps. No pain."
        )
        latestLogId = log.id
        modelContext.insert(log)
    }

    let missed = addStrengthSession(
        offset: -5,
        hour: 9,
        title: "Core Support",
        focus: .core,
        status: .missed,
        summary: "Missed session.",
        prescriptions: [
            (.plank, 3, 0, 50, 75, "Controlled")
        ]
    )
    missed.scoreImpact = -70

    let plannedRun = RunningWorkout(
        scheduledDate: day(0, hour: 17),
        title: "Zone 2 Easy Run",
        kind: .easy,
        distanceKm: 8,
        durationSeconds: 2_760,
        elevationMeters: 80,
        zone: "Zone 2",
        notes: "Keep cadence relaxed."
    )
    modelContext.insert(plannedRun)

    let upcomingRuns = [
        (1, "Hill Session", RunningWorkoutKind.hills, 12.0, 4_200, 420, "Zone 3"),
        (3, "Recovery Run", RunningWorkoutKind.recovery, 7.0, 2_700, 40, "Zone 1"),
        (5, "Long Run", RunningWorkoutKind.long, 28.6, 9_912, 620, "Zone 2")
    ]
    for run in upcomingRuns {
        modelContext.insert(RunningWorkout(
            scheduledDate: day(run.0, hour: 8),
            title: run.1,
            kind: run.2,
            distanceKm: run.3,
            durationSeconds: run.4,
            elevationMeters: run.5,
            zone: run.6,
            notes: "Manual-first planned running session."
        ))
    }

    let completedRuns = [
        (-42, "Easy Run", RunningWorkoutKind.easy, 12.0, 4_200, 120, 136),
        (-35, "Long Run", RunningWorkoutKind.long, 18.0, 6_300, 260, 140),
        (-28, "Tempo Run", RunningWorkoutKind.tempo, 14.0, 4_860, 160, 148),
        (-21, "Long Run", RunningWorkoutKind.long, 24.0, 8_280, 420, 142),
        (-14, "Hill Session", RunningWorkoutKind.hills, 16.0, 5_760, 540, 150),
        (-7, "Long Run", RunningWorkoutKind.long, 28.6, 9_912, 620, 142),
        (-2, "Recovery Run", RunningWorkoutKind.recovery, 7.0, 2_700, 40, 128)
    ]

    for (offset, title, kind, distance, duration, elevation, heartRate) in completedRuns {
        let workout = RunningWorkout(
            scheduledDate: day(offset, hour: 8),
            title: title,
            kind: kind,
            status: .completed,
            distanceKm: distance,
            durationSeconds: duration,
            elevationMeters: elevation,
            zone: kind == .tempo ? "Zone 3" : "Zone 2",
            notes: "Completed manual running log."
        )
        modelContext.insert(workout)
        modelContext.insert(RunningLog(
            workoutId: workout.id,
            completedAt: day(offset, hour: 8, minute: 30),
            distanceKm: distance,
            durationSeconds: duration,
            elevationMeters: elevation,
            averageHeartRate: heartRate,
            calories: Int(distance * 74),
            carbsGrams: Int(distance * 4),
            fluidMl: Int(distance * 28),
            sodiumMg: Int(distance * 42),
            notes: offset == -7 ? "Felt strong and steady. Hot conditions. Focused on fueling." : "Smooth manual run."
        ))
    }

    let plan = CoachPlan(
        weekStart: rollingPlanStart(),
        summary: "A steady strength week with pull quality first, enough push/core support, and running kept manual-first.",
        source: .ai,
        validationStatus: .accepted
    )
    modelContext.insert(plan)
    modelContext.insert(CoachDecision(
        planId: plan.id,
        rationale: "Strength density is progressing. Keep today's pull work strict and avoid adding failure reps.",
        safetyFlags: ["Leave one rep in reserve", "Monitor left elbow after pull volume"]
    ))
    modelContext.insert(CoachVerdict(
        sourceLogId: latestLogId,
        headline: "You are building real consistency.",
        summary: "Pull-ups are trending up, plank is moving, and your running volume is high enough to respect recovery. Today is quality work, not a max test.",
        latestChange: "Pull-up work moved from 29 to 32 clean reps while fatigue stayed controlled.",
        recommendation: "Start the pull session, keep rests honest, then log RPE and any elbow feedback.",
        shouldUpdatePlan: false,
        contextState: "building",
        safetyFlags: ["Leave one rep in reserve today."]
    ))

    try modelContext.save()

    // Keep Today deterministic for screenshots and manual QA.
    _ = todayPull
}
#endif
