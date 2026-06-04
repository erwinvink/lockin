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

    let rank = RankState()
    modelContext.insert(rank)

    let completedSeed: [(offset: Int, title: String, focus: SessionFocus, pullUps: Int, pushUps: Int, plank: Int, rpe: Int, pain: Int, fatigue: Int, notes: String)] = [
        (-14, "Pull Baseline Build", .pull, 5, 20, 60, 7, 0, 5, "Clean reps. Grip felt solid."),
        (-12, "Push Volume", .push, 5, 22, 65, 7, 0, 5, "Push-ups moved easier than expected."),
        (-11, "Core Control", .core, 5, 22, 72, 8, 0, 6, "Plank stayed strict."),
        (-7, "Recovery Deload", .recovery, 6, 22, 72, 5, 4, 8, "Shoulder felt cranky, kept it light."),
        (-5, "Pull Capacity", .pull, 7, 24, 78, 8, 0, 5, "First set had more pop."),
        (-4, "Mixed Support", .mixed, 7, 26, 88, 7, 0, 5, "Smooth circuit. No pain."),
        (-2, "Push + Core", .push, 8, 28, 95, 8, 0, 6, "Good session, little tired after work.")
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
            in: modelContext
        )
        let log = PerformanceLog(
            sessionId: session.id,
            completedAt: day(seed.offset, hour: 19),
            pullUps: seed.pullUps,
            pushUps: seed.pushUps,
            plankSeconds: seed.plank,
            rpe: seed.rpe,
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
    in modelContext: ModelContext
) -> WorkoutSession {
    let session = WorkoutSession(
        scheduledDate: date,
        title: title,
        weekIndex: weekIndex,
        focus: focus,
        status: status,
        scoreImpact: scoreImpact,
        summary: summary
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
        intensity: "Easy"
    ))
    modelContext.insert(SetPrescription(
        sessionId: session.id,
        blockId: warmup.id,
        orderIndex: 1,
        exercise: .hollowHold,
        sets: 2,
        targetSeconds: 20,
        restSeconds: 30,
        intensity: "Controlled"
    ))

    switch focus {
    case .pull:
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 100, exercise: .pullUp, sets: 5, targetReps: pullTarget, restSeconds: 120, intensity: "Hard"))
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 101, exercise: .deadHang, sets: 3, targetSeconds: 25, restSeconds: 60, intensity: "Support"))
    case .push:
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 100, exercise: .pushUp, sets: 5, targetReps: pushTarget, restSeconds: 90, intensity: "Hard"))
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 101, exercise: .pikePushUp, sets: 3, targetReps: max(3, pushTarget / 2), restSeconds: 75, intensity: "Support"))
    case .core:
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 100, exercise: .plank, sets: 5, targetSeconds: plankTarget, restSeconds: 90, intensity: "Hard"))
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 101, exercise: .hollowHold, sets: 4, targetSeconds: max(20, plankTarget / 2), restSeconds: 60, intensity: "Support"))
    case .mixed:
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 100, exercise: .pullUp, sets: 4, targetReps: pullTarget, restSeconds: 90, intensity: "Moderate"))
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 101, exercise: .pushUp, sets: 4, targetReps: pushTarget, restSeconds: 75, intensity: "Moderate"))
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 102, exercise: .plank, sets: 3, targetSeconds: plankTarget, restSeconds: 60, intensity: "Moderate"))
    case .recovery:
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 100, exercise: .shoulderMobility, sets: 3, targetReps: 10, restSeconds: 30, intensity: "Easy"))
        modelContext.insert(SetPrescription(sessionId: session.id, blockId: main.id, orderIndex: 101, exercise: .hollowHold, sets: 3, targetSeconds: 20, restSeconds: 45, intensity: "Easy"))
    }

    return session
}
#endif
