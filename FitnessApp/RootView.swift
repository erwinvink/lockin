import SwiftData
import SwiftUI

struct RootView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \UserProfile.createdAt) private var profiles: [UserProfile]
    #if DEBUG
    @State private var didSeedPreviewData = false
    #endif

    var body: some View {
        ZStack {
            AppTheme.background.ignoresSafeArea()
            if let profile = profiles.first {
                AppShellView(profile: profile)
            } else {
                OnboardingView()
            }
        }
        .foregroundStyle(AppTheme.text)
        // Premium Flat Gold is a dark-only visual identity: forcing the
        // scheme keeps system chrome (alerts, sheets, keyboard, glass tab
        // bar) on the same canvas in every light setting.
        .preferredColorScheme(.dark)
        .task {
            #if DEBUG
            seedPreviewDataIfRequested()
            #endif
        }
    }

    #if DEBUG
    private func seedPreviewDataIfRequested() {
        let arguments = ProcessInfo.processInfo.arguments
        guard !didSeedPreviewData,
              arguments.contains("UITesting"),
              arguments.contains("SeedTwoWeeksActivity")
        else { return }

        didSeedPreviewData = true
        try? seedTwoWeekActivityPreview(in: modelContext)
    }
    #endif
}

#if DEBUG
private func seedTwoWeekActivityPreview(in modelContext: ModelContext, now: Date = Date(), calendar: Calendar = .current) throws {
    try wipeAllData(in: modelContext)

    let startOfToday = calendar.startOfDay(for: now)
    func day(_ offset: Int, hour: Int = 9) -> Date {
        let date = calendar.date(byAdding: .day, value: offset, to: startOfToday) ?? startOfToday
        return calendar.date(byAdding: .hour, value: hour, to: date) ?? date
    }

    let profile = UserProfile(
        createdAt: day(-15),
        name: "Erwin",
        targetDate: calendar.date(byAdding: .year, value: 1, to: now) ?? now,
        weeklySessions: 4,
        trainingDays: [.monday, .wednesday, .friday, .saturday],
        equipment: [.pullUpBar, .resistanceBand, .yogaMat],
        baselinePullUps: 5,
        baselinePushUps: 20,
        baselinePlankSeconds: 60,
        goalPullUps: 50,
        goalPushUps: 100,
        goalPlankSeconds: 300,
        strictFormAccepted: true,
        painNotes: "Keep shoulders warm before pull work."
    )
    modelContext.insert(profile)
    profile.runningDays = [.tuesday, .thursday, .saturday]
    profile.longRunDay = .saturday

    let rank = RankState()
    modelContext.insert(rank)

    let completedSeed: [(offset: Int, title: String, focus: SessionFocus, pullUps: Int, pushUps: Int, plank: Int, plannedRPE: Int, rpe: Int, pain: Int, fatigue: Int, notes: String)] = [
        (-14, "Pull Baseline Build", .pull, 5, 20, 60, 7, 7, 0, 5, "Clean reps. Grip felt solid."),
        (-12, "Push Volume", .push, 5, 22, 65, 8, 7, 0, 5, "Push-ups moved easier than expected."),
        (-11, "Core Control", .core, 5, 22, 72, 6, 8, 0, 6, "Plank stayed strict."),
        (-7, "Recovery Deload", .recovery, 6, 22, 72, 4, 5, 4, 8, "Shoulder felt cranky, kept it light."),
        (-5, "Pull Capacity", .pull, 7, 24, 78, 7, 8, 0, 5, "First set had more pop."),
        (-4, "Mixed Support", .mixed, 7, 26, 88, 7, 7, 0, 5, "Smooth circuit. No pain."),
        (-2, "Push + Core", .push, 8, 28, 95, 6, 8, 0, 6, "Good session, little tired after work.")
    ]

    let missedSession = insertPreviewSession(
        date: day(-9),
        title: "Mixed Session",
        weekIndex: 1,
        focus: .mixed,
        status: .missed,
        scoreImpact: TrainingEngine.missedSessionConsistencyDelta,
        summary: "AI: Missed because the day got away. Counted as a missed training, not extra volume.",
        pullTarget: 5,
        pushTarget: 18,
        plankTarget: 55,
        in: modelContext
    )

    var latestLogID: UUID?
    var latestLog: PerformanceLog?
    for (index, seed) in completedSeed.enumerated() {
        let status: SessionStatus = seed.pain >= 4 || seed.fatigue >= 9 ? .deload : .completed
        let session = insertPreviewSession(
            date: day(seed.offset),
            title: seed.title,
            weekIndex: index < 3 ? 0 : 1,
            focus: seed.focus,
            status: status,
            scoreImpact: 0,
            summary: status == .deload ? "AI: Deloaded from readiness signal." : "AI: Completed strict work from generated week.",
            pullTarget: max(1, seed.pullUps - 1),
            pushTarget: max(3, seed.pushUps - 4),
            plankTarget: max(20, seed.plank - 12),
            plannedRPE: seed.plannedRPE,
            in: modelContext
        )
        let log = PerformanceLog(
            sessionId: session.id,
            completedAt: day(seed.offset, hour: 19),
            pullUps: seed.pullUps,
            pushUps: seed.pushUps,
            plankSeconds: seed.plank,
            rpe: seed.rpe,
            plannedRPE: session.plannedEffortTargetRPE,
            plannedEffortLabelAtLog: session.plannedEffortLabel,
            plannedEffortReasonAtLog: session.plannedEffortReason,
            painLevel: seed.pain,
            fatigueLevel: seed.fatigue,
            notes: seed.notes
        )
        modelContext.insert(log)
        latestLogID = log.id
        latestLog = log

        let outcome = TrainingEngine().score(
            log: SessionLogInput(
                completed: true,
                pullUps: seed.pullUps,
                pushUps: seed.pushUps,
                plankSeconds: seed.plank,
                rpe: seed.rpe,
                painLevel: seed.pain,
                fatigueLevel: seed.fatigue
            ),
            plannedSession: nil
        )
        session.scoreImpact = outcome.consistencyDelta
        applyScoreOutcome(outcome, to: rank)

        if index == 2 {
            applyScoreOutcome(missedSessionOutcome(profile: profile, latestLog: latestLog), to: rank)
            missedSession.scoreImpact = TrainingEngine.missedSessionConsistencyDelta
        }
    }

    _ = insertPreviewSession(
        date: day(0),
        title: "Today Simulation",
        weekIndex: 2,
        focus: .mixed,
        status: .planned,
        scoreImpact: 0,
        summary: "AI: Today preview session for simulation. Log this one from Today.",
        pullTarget: 4,
        pushTarget: 24,
        plankTarget: 85,
        plannedRPE: 5,
        in: modelContext
    )

    _ = insertPreviewSession(
        date: day(2),
        title: "Pull Capacity",
        weekIndex: 2,
        focus: .pull,
        status: .planned,
        scoreImpact: 0,
        summary: "AI: Future open pull session. Today stays untouched.",
        pullTarget: 4,
        pushTarget: 22,
        plankTarget: 75,
        in: modelContext
    )
    _ = insertPreviewSession(
        date: day(3),
        title: "Core Control",
        weekIndex: 2,
        focus: .core,
        status: .planned,
        scoreImpact: 0,
        summary: "AI: Future open core session. Today stays untouched.",
        pullTarget: 4,
        pushTarget: 22,
        plankTarget: 80,
        in: modelContext
    )

    modelContext.insert(RaceGoal(
        name: "Eiger Ultra 51K",
        raceDate: calendar.date(byAdding: .weekOfYear, value: 14, to: startOfToday) ?? startOfToday,
        distanceKm: 51,
        elevationGainM: 3100,
        baselineWeeklyKm: 35,
        longestRecentRunKm: 16.4,
        createdAt: day(-15)
    ))

    modelContext.insert(GarminDailySnapshot(
        date: calendar.date(byAdding: .day, value: -1, to: startOfToday) ?? startOfToday,
        sleepScore: 82,
        sleepSeconds: 27_000,
        hrvStatus: "BALANCED",
        hrvMs: 52,
        bodyBattery: 61,
        trainingReadiness: 74,
        restingHr: 47,
        fetchedAt: day(0, hour: 7)
    ))

    let easyRun = WorkoutSession(
        scheduledDate: day(-6, hour: 7),
        title: "Easy Run",
        weekIndex: 1,
        focus: .mixed,
        status: .completed,
        summary: "AI: Easy aerobic run from the generated running week.",
        estimatedDurationMinutes: 55,
        discipline: .running,
        runKind: .easy,
        plannedDistanceKm: 8,
        plannedElevationM: 100,
        runTargetType: .pace,
        runTargetLow: 360,
        runTargetHigh: 390,
        runZone: "Z2"
    )
    modelContext.insert(easyRun)
    modelContext.insert(RunLog(
        sessionId: easyRun.id,
        completedAt: day(-6, hour: 8),
        distanceKm: 8.2,
        movingSeconds: 52 * 60,
        elevationGainM: 120,
        averageHr: 142,
        averagePaceSecPerKm: 380,
        rpe: 5,
        feelScore: 3,
        notes: "Legs felt easy after the rest day.",
        needsConfirmation: false
    ))

    let longRun = WorkoutSession(
        scheduledDate: day(-2, hour: 8),
        title: "Long Run",
        weekIndex: 1,
        focus: .mixed,
        status: .completed,
        summary: "AI: Long endurance run with steady climbing.",
        estimatedDurationMinutes: 110,
        discipline: .running,
        runKind: .long,
        plannedDistanceKm: 16,
        plannedElevationM: 400,
        runTargetType: .hr,
        runTargetLow: 130,
        runTargetHigh: 150,
        runZone: "Z2"
    )
    modelContext.insert(longRun)
    modelContext.insert(RunLog(
        sessionId: longRun.id,
        completedAt: day(-2, hour: 10),
        distanceKm: 16.4,
        movingSeconds: 108 * 60,
        elevationGainM: 420,
        averageHr: 149,
        averagePaceSecPerKm: 395,
        rpe: 6,
        feelScore: 4,
        notes: "Strong long run. Fueling every 40 minutes worked.",
        garminActivityId: "preview-long-run",
        source: .garmin,
        needsConfirmation: false
    ))

    let upcomingEasyRun = WorkoutSession(
        scheduledDate: day(1, hour: 7),
        title: "Easy Run",
        weekIndex: 2,
        focus: .mixed,
        status: .planned,
        summary: "AI: Easy aerobic volume ahead of the weekend long run.",
        estimatedDurationMinutes: 75,
        discipline: .running,
        runKind: .easy,
        plannedDistanceKm: 12,
        plannedElevationM: 150,
        runTargetType: .pace,
        runTargetLow: 360,
        runTargetHigh: 390,
        runZone: "Z2"
    )
    modelContext.insert(upcomingEasyRun)
    // Pending Garmin auto-match awaiting athlete confirmation: exercises the
    // Today confirm card and locks in Progress excluding unconfirmed volume.
    modelContext.insert(RunLog(
        sessionId: upcomingEasyRun.id,
        completedAt: day(1, hour: 8),
        distanceKm: 5.5,
        movingSeconds: 33 * 60,
        elevationGainM: 60,
        averageHr: 138,
        averagePaceSecPerKm: 360,
        rpe: 0,
        feelScore: 3,
        garminActivityId: "preview-pending-easy-run",
        source: .garmin,
        needsConfirmation: true
    ))

    let plan = CoachPlan(
        weekStart: rollingPlanStart(date: now, calendar: calendar),
        summary: "Two-week preview: streak recovered after one miss, with the next AI sessions still open.",
        source: .ai,
        validationStatus: .accepted,
        generatedAt: day(-1, hour: 20)
    )
    modelContext.insert(plan)
    modelContext.insert(CoachVerdict(
        createdAt: day(-1, hour: 21),
        sourceLogId: latestLogID,
        headline: "Back on track",
        summary: "Seven sessions logged over two weeks. One missed day reset the streak, but the last four sessions rebuilt momentum.",
        latestChange: "Pull-ups moved from 5 to 8, push-ups from 20 to 28, and plank from 1:00 to 1:35.",
        recommendation: "Keep Friday as pull capacity and Saturday as core control. Do not add make-up volume for the missed session.",
        shouldUpdatePlan: false,
        contextState: "building",
        safetyFlags: ["shoulder warmed up before pull work"]
    ))

    try modelContext.save()
}

@discardableResult
private func insertPreviewSession(
    date: Date,
    title: String,
    weekIndex: Int,
    focus: SessionFocus,
    status: SessionStatus,
    scoreImpact: Int,
    summary: String,
    pullTarget: Int,
    pushTarget: Int,
    plankTarget: Int,
    plannedRPE: Int? = nil,
    in modelContext: ModelContext
) -> WorkoutSession {
    let sessionEffort = previewPlannedEffort(
        plannedRPE: plannedRPE,
        status: status,
        focus: focus
    )
    let session = WorkoutSession(
        scheduledDate: date,
        title: title,
        weekIndex: weekIndex,
        focus: focus,
        status: status,
        scoreImpact: scoreImpact,
        summary: summary,
        plannedEffort: sessionEffort
    )
    modelContext.insert(session)

    let warmup = WorkoutBlock(sessionId: session.id, orderIndex: 0, name: "Warm-up", detail: "Joint prep and strict-form rehearsal.")
    let main = WorkoutBlock(sessionId: session.id, orderIndex: 1, name: focus.title, detail: "Keep reps clean and stop before form breaks.")
    modelContext.insert(warmup)
    modelContext.insert(main)

    modelContext.insert(SetPrescription(
        sessionId: session.id,
        blockId: warmup.id,
        orderIndex: 0,
        exercise: .shoulderMobility,
        sets: 2,
        targetReps: 8,
        restSeconds: 30,
        intensity: "Easy",
        plannedEffort: .light("Warm-up effort.")
    ))
    modelContext.insert(SetPrescription(
        sessionId: session.id,
        blockId: warmup.id,
        orderIndex: 1,
        exercise: .hollowHold,
        sets: 2,
        targetSeconds: 20,
        restSeconds: 30,
        intensity: "Controlled",
        plannedEffort: .light("Controlled prep work.")
    ))

    switch focus {
    case .pull:
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 100, exercise: .pullUp, sets: 5, targetReps: pullTarget, restSeconds: 120, intensity: "Hard", plannedEffort: sessionEffort))
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 101, exercise: .deadHang, sets: 3, targetSeconds: 25, restSeconds: 60, intensity: "Support", plannedEffort: .medium("Grip and shoulder support.")))
    case .push:
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 100, exercise: .pushUp, sets: 5, targetReps: pushTarget, restSeconds: 90, intensity: "Hard", plannedEffort: sessionEffort))
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 101, exercise: .pikePushUp, sets: 3, targetReps: max(3, pushTarget / 2), restSeconds: 75, intensity: "Support", plannedEffort: .medium("Shoulder support volume.")))
    case .core:
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 100, exercise: .plank, sets: 5, targetSeconds: plankTarget, restSeconds: 90, intensity: "Hard", plannedEffort: sessionEffort))
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 101, exercise: .hollowHold, sets: 4, targetSeconds: max(20, plankTarget / 2), restSeconds: 60, intensity: "Support", plannedEffort: .medium("Core support volume.")))
    case .mixed:
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 100, exercise: .pullUp, sets: 4, targetReps: pullTarget, restSeconds: 90, intensity: "Moderate", plannedEffort: .medium("Mixed-session pull volume.")))
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 101, exercise: .pushUp, sets: 4, targetReps: pushTarget, restSeconds: 75, intensity: "Moderate", plannedEffort: .medium("Mixed-session push volume.")))
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 102, exercise: .plank, sets: 3, targetSeconds: plankTarget, restSeconds: 60, intensity: "Moderate", plannedEffort: .medium("Mixed-session core volume.")))
    case .recovery:
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 100, exercise: .shoulderMobility, sets: 3, targetReps: 10, restSeconds: 30, intensity: "Easy", plannedEffort: .light("Recovery mobility.")))
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 101, exercise: .hollowHold, sets: 3, targetSeconds: 20, restSeconds: 45, intensity: "Easy", plannedEffort: .light("Easy recovery core.")))
    }

    return session
}

private func previewPlannedEffort(plannedRPE: Int?, status: SessionStatus, focus: SessionFocus) -> PlannedEffort {
    if let plannedRPE {
        return plannedEffort(targetRPE: plannedRPE, reason: "Preview planned RPE snapshot for \(focus.title.lowercased()) work.")
    }
    if status == .deload || focus == .recovery {
        return .light("Preview recovery or deload work.")
    }
    return .hard("Preview goal stimulus.")
}

private func plannedEffort(targetRPE: Int, reason: String) -> PlannedEffort {
    let normalizedRPE = min(10, max(1, targetRPE))
    let label = PlannedEffortLabel.fromRPE(normalizedRPE)
    let targetRIR: Int
    let stimulus: EffortStimulus

    switch label {
    case .light:
        targetRIR = 6
        stimulus = .technique
    case .medium:
        targetRIR = 4
        stimulus = .volume
    case .hard:
        targetRIR = 3
        stimulus = .strength
    case .veryHard:
        targetRIR = 1
        stimulus = .strength
    case .maxOutput:
        targetRIR = 0
        stimulus = .test
    }

    return PlannedEffort(
        label: label,
        targetRPE: normalizedRPE,
        targetRIR: targetRIR,
        stimulus: stimulus,
        reason: reason
    )
}
#endif
