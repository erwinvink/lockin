import SwiftData
import SwiftUI

struct TodayView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \WorkoutBlock.orderIndex) private var blocks: [WorkoutBlock]
    @Query(sort: \SetPrescription.orderIndex) private var prescriptions: [SetPrescription]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query(sort: \RunningWorkout.scheduledDate) private var runningWorkouts: [RunningWorkout]
    @Query private var ranks: [RankState]

    var profile: UserProfile
    @State private var guidedSession: WorkoutSession?
    @State private var loggingSession: WorkoutSession?
    @State private var missedSession: WorkoutSession?

    private var dueSession: WorkoutSession? {
        duePlannedSession(from: sessions)
    }

    private var todayOtherStrengthSessions: [WorkoutSession] {
        let calendar = Calendar.current
        return sessions
            .filter { $0.status == .planned && calendar.isDateInToday($0.scheduledDate) && $0.id != dueSession?.id }
            .sorted { $0.scheduledDate < $1.scheduledDate }
    }

    private var todayRuns: [RunningWorkout] {
        runningWorkouts
            .filter { Calendar.current.isDateInToday($0.scheduledDate) && $0.status == .planned }
            .sorted { $0.scheduledDate < $1.scheduledDate }
    }

    private var futureSession: WorkoutSession? {
        nextFuturePlannedSession(from: sessions)
    }

    private var rank: RankState {
        ranks.first ?? RankState()
    }

    private var latestLog: PerformanceLog? {
        logs.first
    }

    private var latestPullUps: Int {
        logs.first(where: { $0.loggedPullUps })?.pullUps ?? profile.baselinePullUps
    }

    private var latestPushUps: Int {
        logs.first(where: { $0.loggedPushUps })?.pushUps ?? profile.baselinePushUps
    }

    private var latestPlankSeconds: Int {
        logs.first(where: { $0.loggedPlankSeconds })?.plankSeconds ?? profile.baselinePlankSeconds
    }

    private var nextRun: RunningWorkout? {
        runningWorkouts
            .filter { $0.status == .planned && $0.scheduledDate >= Calendar.current.startOfDay(for: Date()) }
            .sorted { $0.scheduledDate < $1.scheduledDate }
            .first
    }

    private var tomorrowSession: WorkoutSession? {
        let calendar = Calendar.current
        let startOfTomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: Date())) ?? Date()
        let endOfTomorrow = calendar.date(byAdding: .day, value: 1, to: startOfTomorrow) ?? startOfTomorrow
        return sessions
            .filter { $0.status == .planned && $0.scheduledDate >= startOfTomorrow && $0.scheduledDate < endOfTomorrow }
            .sorted { $0.scheduledDate < $1.scheduledDate }
            .first ?? futureSession
    }

    var body: some View {
        NavigationStack {
            ScreenBackground {
                TodayHeroHeader(initials: initials)
                todayWorkSurface
                TodayAtAGlanceCard(rank: rank)
                TodayDailyProgressCard(
                    pullUps: latestPullUps,
                    pushUps: latestPushUps,
                    plankSeconds: latestPlankSeconds,
                    goalPullUps: profile.goalPullUps,
                    goalPushUps: profile.goalPushUps,
                    goalPlankSeconds: profile.goalPlankSeconds
                )
                TodaySplitCard(nextRun: nextRun, tomorrowSession: tomorrowSession)
            }
            .navigationBarHidden(true)
            .fullScreenCover(item: $guidedSession) { session in
                GuidedSessionView(
                    session: session,
                    prescriptions: prescriptionsForSession(session),
                    blocks: blocksForSession(session),
                    onFinish: {
                        guidedSession = nil
                        loggingSession = session
                    },
                    onMarkMissed: {
                        guidedSession = nil
                        missedSession = session
                    }
                )
            }
            .sheet(item: $loggingSession) { session in
                LogWorkoutView(session: session, profile: profile)
            }
            .alert("Mark this session missed?", isPresented: missedConfirmationBinding) {
                Button("Cancel", role: .cancel) {
                    missedSession = nil
                }
                Button("Mark missed", role: .destructive) {
                    markMissed()
                }
            } message: {
                Text("This will reset the current streak and add the normal missed-session score pressure.")
            }
        }
    }

    @ViewBuilder
    private var todayWorkSurface: some View {
        if let session = dueSession {
            TodayWorkCard(
                session: session,
                prescriptions: prescriptionsForSession(session),
                coachNote: coachNote,
                onStart: { guidedSession = session }
            )
        } else if sessions.isEmpty {
            EmptyTodayCard()
        } else if let session = futureSession {
            UpcomingTodayCard(session: session)
        } else {
            WeekCompleteCard()
        }
    }

    private var missedConfirmationBinding: Binding<Bool> {
        Binding(
            get: { missedSession != nil },
            set: { if !$0 { missedSession = nil } }
        )
    }

    private var initials: String {
        let parts = profile.name.split(separator: " ")
        let first = parts.first?.prefix(1) ?? "A"
        let second = parts.dropFirst().first?.prefix(1) ?? ""
        return "\(first)\(second)".uppercased()
    }

    private var coachNote: String {
        if let latestLog {
            if latestLog.painLevel >= 4 || latestLog.fatigueLevel >= 9 {
                return "Keep the standard. Reduce stress if pain or fatigue is still high."
            }
            return "Last week was strong. Leave one rep in reserve today."
        }
        return "Start controlled. Clean reps count more than extra reps."
    }

    private func blocksForSession(_ session: WorkoutSession) -> [WorkoutBlock] {
        blocks
            .filter { $0.sessionId == session.id }
            .sorted { $0.orderIndex < $1.orderIndex }
    }

    private func prescriptionsForSession(_ session: WorkoutSession) -> [SetPrescription] {
        prescriptions
            .filter { $0.sessionId == session.id }
            .sorted { $0.orderIndex < $1.orderIndex }
    }

    private func markMissed() {
        guard let missedSession else { return }
        missedSession.status = .missed
        let rank = ranks.first ?? RankState()
        if ranks.isEmpty {
            modelContext.insert(rank)
        }
        applyScoreOutcome(missedSessionOutcome(profile: profile, latestLog: latestLog), to: rank)
        try? modelContext.save()
        self.missedSession = nil
    }
}

private struct TodayWorkCard: View {
    var session: WorkoutSession
    var prescriptions: [SetPrescription]
    var coachNote: String
    var onStart: () -> Void

    private var primaryPrescription: SetPrescription? {
        prescriptions.first
    }

    var body: some View {
        LockinCard(padding: 14) {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Today's work")

                HStack(alignment: .center, spacing: 12) {
                    ExerciseBadge(kind: primaryPrescription?.exercise ?? .pullUp, size: 36)

                    VStack(alignment: .leading, spacing: 8) {
                        Text(session.title)
                            .font(.system(size: 18, weight: .semibold, design: .serif))
                            .foregroundStyle(AppTheme.textPrimary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.78)
                        if let primaryPrescription {
                            Text(canonicalPrescriptionText(primaryPrescription))
                                .font(.system(size: 15, weight: .regular))
                                .foregroundStyle(AppTheme.textPrimary)
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                            Text("Rest \(format(seconds: primaryPrescription.restSeconds))")
                                .font(.system(size: 13))
                                .foregroundStyle(AppTheme.textSecondary)
                        } else {
                            Text(displayPlanSummary(session.summary))
                                .font(.system(size: 13))
                                .foregroundStyle(AppTheme.textSecondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    PullUpIllustration()
                        .frame(width: 88, height: 96)
                }

                VStack(alignment: .leading, spacing: 6) {
                    SectionLabel(text: "Notes from coach")
                    Text("\"\(coachNote)\"")
                        .font(.system(size: 13))
                        .lineSpacing(2)
                        .foregroundStyle(AppTheme.textPrimary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                        .fill(AppTheme.coachNoteFill)
                )

                PrimaryActionButton(title: "Start Session", action: onStart)
            }
        }
    }

    private func canonicalPrescriptionText(_ prescription: SetPrescription) -> String {
        if prescription.targetSeconds > 0 {
            return "\(prescription.sets) × \(format(seconds: prescription.targetSeconds))"
        }
        return "\(prescription.sets) × \(prescription.targetReps) \(canonicalExerciseName(prescription.exercise))"
    }
}

private struct TodayHeroHeader: View {
    var initials: String

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 12) {
                Text(Date().formatted(.dateTime.weekday(.wide).month(.wide).day()).uppercased())
                    .font(.system(size: 13, weight: .semibold))
                    .tracking(1.6)
                    .foregroundStyle(AppTheme.forest)
                Text("Locked In.")
                    .font(.system(size: 34, weight: .semibold, design: .serif))
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Text("Discipline today. Freedom tomorrow.")
                    .font(.system(size: 15))
                    .foregroundStyle(AppTheme.textSecondary)
            }
            Spacer(minLength: 8)
            AthleteAvatar(initials: initials)
                .padding(.top, 22)
        }
        .padding(.top, -8)
    }
}

private struct AthleteAvatar: View {
    var initials: String

    var body: some View {
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        colors: [Color(hex: "D8DDD6"), Color(hex: "AEB6AE")],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
            Image(systemName: "person.crop.circle.fill")
                .resizable()
                .scaledToFit()
                .foregroundStyle(AppTheme.rankDark.opacity(0.86), AppTheme.surfaceElevated.opacity(0.35))
                .padding(7)
        }
        .frame(width: 56, height: 56)
        .accessibilityLabel("Profile")
    }
}

private struct TodayAtAGlanceCard: View {
    var rank: RankState

    var body: some View {
        LockinCard(padding: 12) {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "At a glance")
                HStack(spacing: 0) {
                    GlanceColumn(systemImage: "flame", value: "\(rank.streak)", label: "Current")
                    Divider()
                        .background(AppTheme.dividerLine)
                        .padding(.vertical, 6)
                    GlanceColumn(systemImage: "calendar.badge.checkmark", value: "\(rank.bestStreak)", label: "Best")
                    Divider()
                        .background(AppTheme.dividerLine)
                        .padding(.vertical, 6)
                    GlanceColumn(systemImage: "chart.line.uptrend.xyaxis", value: "\(consistencyScore)", label: "Consistency")
                }
            }
        }
    }

    private var consistencyScore: Int {
        rank.consistencyScore > 0 ? rank.consistencyScore : min(100, max(0, rank.streak * 6))
    }
}

private struct GlanceColumn: View {
    var systemImage: String
    var value: String
    var label: String

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: systemImage)
                .font(.system(size: 12, weight: .regular))
                .foregroundStyle(AppTheme.forest)
                .frame(height: 14)
            Text(value)
                .font(.system(size: 16, weight: .semibold, design: .serif))
                .foregroundStyle(AppTheme.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(AppTheme.textSecondary)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct TodayDailyProgressCard: View {
    var pullUps: Int
    var pushUps: Int
    var plankSeconds: Int
    var goalPullUps: Int
    var goalPushUps: Int
    var goalPlankSeconds: Int

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 14) {
                SectionLabel(text: "Daily progress")
                VStack(spacing: 12) {
                    TodayProgressRow(
                        exercise: .pullUp,
                        title: "Pull-ups",
                        value: "\(pullUps) / \(goalPullUps)",
                        progress: progress(current: pullUps, goal: goalPullUps)
                    )
                    TodayProgressRow(
                        exercise: .pushUp,
                        title: "Push-ups",
                        value: "\(pushUps) / \(goalPushUps)",
                        progress: progress(current: pushUps, goal: goalPushUps)
                    )
                    TodayProgressRow(
                        exercise: .plank,
                        title: "Plank",
                        value: "\(format(seconds: plankSeconds)) / \(format(seconds: goalPlankSeconds))",
                        progress: progress(current: plankSeconds, goal: goalPlankSeconds)
                    )
                }
            }
        }
    }

    private func progress(current: Int, goal: Int) -> Double {
        min(1, max(0, Double(current) / Double(max(goal, 1))))
    }
}

private struct TodayProgressRow: View {
    var exercise: ExerciseKind
    var title: String
    var value: String
    var progress: Double

    var body: some View {
        HStack(spacing: 14) {
            ExerciseBadge(kind: exercise, size: 32)
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
                .frame(width: 92, alignment: .leading)
            VStack(alignment: .trailing, spacing: 8) {
                HStack(spacing: 18) {
                    Text(value)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(AppTheme.textPrimary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Text("\(Int((progress * 100).rounded()))%")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(AppTheme.textSecondary)
                        .frame(width: 38, alignment: .trailing)
                }
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(AppTheme.borderStrong.opacity(0.72))
                        Capsule()
                            .fill(AppTheme.forest)
                            .frame(width: proxy.size.width * progress)
                    }
                }
                .frame(height: 3)
            }
        }
        .frame(minHeight: 36)
    }
}

private struct TodaySplitCard: View {
    var nextRun: RunningWorkout?
    var tomorrowSession: WorkoutSession?

    var body: some View {
        LockinCard {
            HStack(alignment: .center, spacing: 18) {
                VStack(alignment: .leading, spacing: 10) {
                    SectionLabel(text: "Next run")
                    Text(nextRun?.kind.title ?? "Easy Run")
                        .font(.system(size: 22, weight: .semibold, design: .serif))
                        .foregroundStyle(AppTheme.textPrimary)
                    HStack(spacing: 24) {
                        Text(runDistance)
                        Text(nextRun?.zone ?? "Zone 2")
                    }
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Rectangle()
                    .fill(AppTheme.dividerLine)
                    .frame(width: 1)
                    .frame(maxHeight: .infinity)

                HStack(alignment: .center, spacing: 10) {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionLabel(text: "Tomorrow")
                        Text(tomorrowSession?.title ?? "Mobility")
                            .font(.system(size: 22, weight: .semibold, design: .serif))
                            .foregroundStyle(AppTheme.textPrimary)
                        HStack(spacing: 24) {
                            Text(tomorrowDuration)
                            Text(tomorrowSession?.focus.title ?? "Recovery")
                        }
                        .font(.system(size: 14))
                        .foregroundStyle(AppTheme.textSecondary)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 24, weight: .regular))
                        .foregroundStyle(AppTheme.textPrimary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(minHeight: 86)
        }
    }

    private var runDistance: String {
        guard let nextRun else { return "8-10 km" }
        if nextRun.kind == .easy && nextRun.distanceKm <= 10 {
            return "\(Int(nextRun.distanceKm))-10 km"
        }
        return "\(format(kilometers: nextRun.distanceKm)) km"
    }

    private var tomorrowDuration: String {
        guard let tomorrowSession else { return "10 min" }
        return tomorrowSession.focus == .recovery ? "10 min" : "45 min"
    }
}

private struct ExerciseBadge: View {
    var kind: ExerciseKind
    var size: CGFloat

    var body: some View {
        ZStack {
            Circle()
                .fill(AppTheme.exerciseIconFill)
            exerciseIcon
                .foregroundStyle(AppTheme.rankDark)
                .frame(width: size * 0.58, height: size * 0.58)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var exerciseIcon: some View {
        switch kind {
        case .pullUp, .deadHang, .scapularPull:
            PullUpMiniIcon()
        case .pushUp, .inclinePushUp, .pikePushUp:
            Image(systemName: "figure.strengthtraining.traditional")
                .font(.system(size: size * 0.42, weight: .light))
        case .plank, .hollowHold:
            Image(systemName: "figure.core.training")
                .font(.system(size: size * 0.42, weight: .light))
        case .shoulderMobility:
            Image(systemName: "figure.flexibility")
                .font(.system(size: size * 0.42, weight: .light))
        }
    }
}

private struct PullUpMiniIcon: View {
    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let height = proxy.size.height
            Path { path in
                path.move(to: CGPoint(x: width * 0.2, y: height * 0.2))
                path.addLine(to: CGPoint(x: width * 0.8, y: height * 0.2))
                path.move(to: CGPoint(x: width * 0.28, y: height * 0.2))
                path.addLine(to: CGPoint(x: width * 0.28, y: height * 0.84))
                path.move(to: CGPoint(x: width * 0.72, y: height * 0.2))
                path.addLine(to: CGPoint(x: width * 0.72, y: height * 0.84))
            }
            .stroke(AppTheme.rankDark, style: StrokeStyle(lineWidth: 1.2, lineCap: .round, lineJoin: .round))

            Circle()
                .fill(AppTheme.rankDark)
                .frame(width: width * 0.12, height: width * 0.12)
                .position(x: width * 0.5, y: height * 0.38)

            Path { path in
                path.move(to: CGPoint(x: width * 0.38, y: height * 0.25))
                path.addLine(to: CGPoint(x: width * 0.5, y: height * 0.48))
                path.addLine(to: CGPoint(x: width * 0.62, y: height * 0.25))
                path.move(to: CGPoint(x: width * 0.5, y: height * 0.48))
                path.addLine(to: CGPoint(x: width * 0.5, y: height * 0.66))
                path.move(to: CGPoint(x: width * 0.5, y: height * 0.66))
                path.addLine(to: CGPoint(x: width * 0.42, y: height * 0.8))
                path.move(to: CGPoint(x: width * 0.5, y: height * 0.66))
                path.addLine(to: CGPoint(x: width * 0.58, y: height * 0.8))
            }
            .stroke(AppTheme.rankDark, style: StrokeStyle(lineWidth: 1.3, lineCap: .round, lineJoin: .round))
        }
    }
}

private struct PullUpIllustration: View {
    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let height = proxy.size.height

            Path { path in
                path.move(to: CGPoint(x: width * 0.16, y: height * 0.16))
                path.addLine(to: CGPoint(x: width * 0.84, y: height * 0.16))
                path.move(to: CGPoint(x: width * 0.2, y: height * 0.16))
                path.addLine(to: CGPoint(x: width * 0.2, y: height * 0.94))
                path.move(to: CGPoint(x: width * 0.8, y: height * 0.16))
                path.addLine(to: CGPoint(x: width * 0.8, y: height * 0.94))
            }
            .stroke(AppTheme.rankDark, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))

            Circle()
                .fill(AppTheme.rankDark)
                .frame(width: width * 0.12, height: width * 0.12)
                .position(x: width * 0.5, y: height * 0.28)

            RoundedRectangle(cornerRadius: width * 0.035, style: .continuous)
                .fill(AppTheme.rankDark)
                .frame(width: width * 0.16, height: height * 0.28)
                .position(x: width * 0.5, y: height * 0.47)

            Path { path in
                path.move(to: CGPoint(x: width * 0.32, y: height * 0.18))
                path.addLine(to: CGPoint(x: width * 0.43, y: height * 0.38))
                path.move(to: CGPoint(x: width * 0.68, y: height * 0.18))
                path.addLine(to: CGPoint(x: width * 0.57, y: height * 0.38))
                path.move(to: CGPoint(x: width * 0.43, y: height * 0.6))
                path.addLine(to: CGPoint(x: width * 0.36, y: height * 0.84))
                path.move(to: CGPoint(x: width * 0.57, y: height * 0.6))
                path.addLine(to: CGPoint(x: width * 0.64, y: height * 0.84))
            }
            .stroke(AppTheme.rankDark, style: StrokeStyle(lineWidth: 8, lineCap: .round, lineJoin: .round))

            Ellipse()
                .fill(AppTheme.border.opacity(0.38))
                .frame(width: width * 0.7, height: 6)
                .position(x: width * 0.5, y: height * 0.98)
        }
        .accessibilityHidden(true)
    }
}

private func canonicalExerciseName(_ exercise: ExerciseKind) -> String {
    switch exercise {
    case .pullUp: return "Pull-ups"
    case .pushUp: return "Push-ups"
    case .plank: return "Plank"
    case .scapularPull: return "Scapular pulls"
    case .hollowHold: return "Hollow holds"
    case .inclinePushUp: return "Incline push-ups"
    case .pikePushUp: return "Pike push-ups"
    case .deadHang: return "Dead hangs"
    case .shoulderMobility: return "Shoulder mobility"
    }
}

private struct PlannedStrengthRow: View {
    var session: WorkoutSession

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(session.title)
                    .font(.system(size: 15, weight: .semibold))
                Text(session.focus.title)
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
            }
            Spacer()
            Circle()
                .stroke(AppTheme.olive, lineWidth: 1)
                .frame(width: 22, height: 22)
        }
        .padding(.vertical, 10)
    }
}

private struct PlannedRunRow: View {
    var run: RunningWorkout

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(run.title)
                    .font(.system(size: 15, weight: .semibold))
                Text("\(format(kilometers: run.distanceKm)) km - \(durationText(seconds: run.durationSeconds))")
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
            }
            Spacer()
            Circle()
                .stroke(AppTheme.blueRunning, lineWidth: 1)
                .frame(width: 22, height: 22)
        }
        .padding(.vertical, 10)
    }
}

private struct EmptyTodayCard: View {
    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("No plan yet")
                    .font(.system(size: 20, weight: .semibold))
                Text("Open Coach and generate a strength week to populate Today and Log.")
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.textSecondary)
            }
        }
    }
}

private struct UpcomingTodayCard: View {
    var session: WorkoutSession

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("No session due today")
                        .font(.system(size: 20, weight: .semibold))
                    Spacer()
                    StatusPill(text: "Scheduled", systemImage: "calendar")
                }
                InfoLine(title: "Next session", value: session.title)
                InfoLine(title: "Date", value: session.scheduledDate.formatted(date: .abbreviated, time: .omitted))
            }
        }
    }
}

private struct WeekCompleteCard: View {
    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("Week processed")
                    .font(.system(size: 20, weight: .semibold))
                Text("All currently planned sessions are completed, missed, or deloaded. Progress now reflects the score changes.")
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.textSecondary)
            }
        }
    }
}

struct GuidedSessionView: View {
    @Environment(\.dismiss) private var dismiss
    var session: WorkoutSession
    var prescriptions: [SetPrescription]
    var blocks: [WorkoutBlock]
    var onFinish: () -> Void
    var onMarkMissed: () -> Void

    @State private var prescriptionIndex = 0
    @State private var phaseIndex = 0
    @State private var remainingSeconds = 0
    @State private var isRunning = false
    @State private var isShowingMissedConfirmation = false
    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var currentPrescription: SetPrescription? {
        guard prescriptions.indices.contains(prescriptionIndex) else { return nil }
        return prescriptions[prescriptionIndex]
    }

    private var phases: [WorkoutTimerPhase] {
        currentPrescription.map(workoutTimerPhases(for:)) ?? []
    }

    private var currentPhase: WorkoutTimerPhase? {
        guard phases.indices.contains(phaseIndex) else { return nil }
        return phases[phaseIndex]
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 22) {
                header
                if let currentPrescription {
                    exerciseContent(currentPrescription)
                } else {
                    Text("No exercise details are available for this session.")
                        .foregroundStyle(AppTheme.textSecondary)
                }
                Spacer()
                PrimaryActionButton(title: isLastExerciseAndPhase ? "Finish Workout" : "Next Phase", systemImage: "forward.end.fill") {
                    advance()
                }
            }
            .padding(.horizontal, AppTheme.screenHorizontal)
            .padding(.top, 18)
            .padding(.bottom, 24)
            .background(AppTheme.background.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .onAppear(perform: resetPhase)
            .onReceive(ticker) { _ in
                tick()
            }
            .alert("Mark workout missed?", isPresented: $isShowingMissedConfirmation) {
                Button("Cancel", role: .cancel) {}
                Button("Mark missed", role: .destructive) {
                    onMarkMissed()
                }
            } message: {
                Text("This exits the session and records the missed-session score pressure.")
            }
        }
    }

    private var header: some View {
        HStack {
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            Spacer()
            Text(session.title)
                .font(.system(size: 15, weight: .semibold))
            Spacer()
            Menu {
                Button(role: .destructive) {
                    isShowingMissedConfirmation = true
                } label: {
                    Label("Mark missed", systemImage: "xmark.circle")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 44, height: 44)
            }
        }
    }

    private func exerciseContent(_ prescription: SetPrescription) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            SectionLabel(text: "Guided session")
            Text(prescription.exercise.title)
                .font(.system(size: 34, weight: .bold))
                .foregroundStyle(AppTheme.textPrimary)
            Text(workoutTargetText(prescription))
                .font(.system(size: 16))
                .foregroundStyle(AppTheme.textSecondary)

            LockinCard(background: AppTheme.surfaceElevated) {
                VStack(spacing: 18) {
                    Text(phaseTitle)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(AppTheme.textSecondary)
                    Text(phaseValue)
                        .font(.system(size: 58, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                    TimerPhaseStrip(phases: phases, phaseIndex: phaseIndex, isFinished: false, onSelect: selectPhase)
                    HStack(spacing: 12) {
                        SessionControlButton(systemImage: "backward.end.fill", title: "Previous", isEnabled: canGoBack, action: previous)
                        SessionControlButton(systemImage: isRunning ? "pause.fill" : "play.fill", title: isRunning ? "Pause" : "Start", isEnabled: currentPhase?.isTimed == true, action: toggleTimer)
                        SessionControlButton(systemImage: "forward.end.fill", title: "Skip", isEnabled: true, action: advance)
                    }
                }
            }

            Text(exerciseWorkoutContext(prescription.exercise, block: blocks.first(where: { $0.id == prescription.blockId })))
                .font(.system(size: 14))
                .foregroundStyle(AppTheme.textSecondary)
        }
    }

    private var phaseTitle: String {
        currentPhase?.title ?? "Set"
    }

    private var phaseValue: String {
        guard let currentPhase else { return "--" }
        if currentPhase.isTimed {
            return format(seconds: remainingSeconds > 0 ? remainingSeconds : currentPhase.durationSeconds ?? 0)
        }
        return currentPhase.displayValue
    }

    private var canGoBack: Bool {
        phaseIndex > 0 || prescriptionIndex > 0
    }

    private var isLastExerciseAndPhase: Bool {
        prescriptionIndex == prescriptions.count - 1 && phaseIndex == max(0, phases.count - 1)
    }

    private func resetPhase() {
        phaseIndex = 0
        remainingSeconds = currentPhase?.durationSeconds ?? 0
        isRunning = false
    }

    private func selectPhase(_ index: Int) {
        guard phases.indices.contains(index) else { return }
        phaseIndex = index
        remainingSeconds = currentPhase?.durationSeconds ?? 0
        isRunning = false
    }

    private func previous() {
        if phaseIndex > 0 {
            selectPhase(phaseIndex - 1)
        } else if prescriptionIndex > 0 {
            prescriptionIndex -= 1
            resetPhase()
        }
    }

    private func advance() {
        if phases.indices.contains(phaseIndex + 1) {
            selectPhase(phaseIndex + 1)
        } else if prescriptions.indices.contains(prescriptionIndex + 1) {
            prescriptionIndex += 1
            resetPhase()
        } else {
            onFinish()
        }
    }

    private func toggleTimer() {
        guard currentPhase?.isTimed == true else { return }
        if remainingSeconds <= 0 {
            remainingSeconds = currentPhase?.durationSeconds ?? 0
        }
        isRunning.toggle()
    }

    private func tick() {
        guard isRunning, currentPhase?.isTimed == true else { return }
        if remainingSeconds <= 1 {
            isRunning = false
            advance()
        } else {
            remainingSeconds -= 1
        }
    }
}

private struct SessionControlButton: View {
    var systemImage: String
    var title: String
    var isEnabled: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 5) {
                Image(systemName: systemImage)
                    .font(.system(size: 17, weight: .semibold))
                Text(title)
                    .font(.system(size: 11, weight: .medium))
            }
            .foregroundStyle(isEnabled ? AppTheme.textPrimary : AppTheme.textTertiary)
            .frame(maxWidth: .infinity)
            .frame(height: 58)
            .background(
                RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                    .fill(AppTheme.surfaceWarm)
            )
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                    .stroke(AppTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
    }
}

private struct TimerPhaseStrip: View {
    var phases: [WorkoutTimerPhase]
    var phaseIndex: Int
    var isFinished: Bool
    var onSelect: (Int) -> Void

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(phases.enumerated()), id: \.element.id) { index, phase in
                Button {
                    onSelect(index)
                } label: {
                    Capsule()
                        .fill(color(for: phase, at: index))
                        .frame(height: 7)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(phase.stripAccessibilityLabel)
            }
        }
    }

    private func color(for phase: WorkoutTimerPhase, at index: Int) -> Color {
        if isFinished || index < phaseIndex {
            return AppTheme.forest
        }
        if index == phaseIndex {
            return phase.kind == .work ? AppTheme.forest : AppTheme.olive
        }
        return AppTheme.border
    }
}
