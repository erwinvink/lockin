import SwiftData
import SwiftUI

struct TodayView: View {
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \WorkoutBlock.orderIndex) private var blocks: [WorkoutBlock]
    @Query(sort: \SetPrescription.orderIndex) private var prescriptions: [SetPrescription]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query(sort: \RunningLog.completedAt, order: .reverse) private var runLogs: [RunningLog]
    @Query private var runningWorkouts: [RunningWorkout]
    @Query private var ranks: [RankState]

    var profile: UserProfile
    @State private var loggingSheet: TrainingLogSheet?
    @State private var pendingLoggingSessionID: UUID?
    @State private var workoutCardResetID = UUID()

    private var dueSessions: [WorkoutSession] {
        duePlannedSessions(from: sessions)
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

    private var latestRunLog: RunningLog? {
        runLogs.first
    }

    var body: some View {
        NavigationStack {
            ScreenBackground {
                BrandHeader()

                TodayStateCard(
                    rank: rank,
                    nextSession: dueSessions.first ?? futureSession,
                    strengthLog: latestLog,
                    runLog: latestRunLog
                )

                if !dueSessions.isEmpty {
                    ForEach(dueSessions) { session in
                        if session.domain == .ultraRunning {
                            RunPrescriptionCard(
                                session: session,
                                workout: runningWorkout(for: session),
                                onComplete: { beginLogging(session) }
                            )
                            .id("\(session.id.uuidString)-\(workoutCardResetID.uuidString)")
                        } else {
                            WorkoutPrescriptionCard(
                                session: session,
                                prescriptions: prescriptionsForSession(session),
                                blocks: blocksForSession(session),
                                onComplete: { beginLogging(session) }
                            )
                            .id("\(session.id.uuidString)-\(workoutCardResetID.uuidString)")
                        }
                    }
                } else if sessions.isEmpty {
                    EmptyPlanCard()
                } else if let session = futureSession {
                    UpcomingSessionCard(session: session)
                } else {
                    WeekCompleteCard()
                }
            }
            .sheet(item: $loggingSheet, onDismiss: resetCheckedWorkoutIfLogWasCancelled) { sheet in
                switch sheet {
                case .strength(let session):
                    LogWorkoutView(session: session, profile: profile)
                case .ultraRunning(let session, let workout):
                    LogRunView(session: session, workout: workout)
                }
            }
        }
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

    private func runningWorkout(for session: WorkoutSession) -> RunningWorkout? {
        runningWorkouts.first { $0.sessionId == session.id }
    }

    private func beginLogging(_ session: WorkoutSession) {
        guard session.status == .planned else { return }
        if session.domain == .ultraRunning, runningWorkout(for: session) == nil { return }
        pendingLoggingSessionID = session.id
        if session.domain == .ultraRunning, let workout = runningWorkout(for: session) {
            loggingSheet = .ultraRunning(session, workout)
        } else {
            loggingSheet = .strength(session)
        }
    }

    private func resetCheckedWorkoutIfLogWasCancelled() {
        guard let pendingLoggingSessionID else { return }
        let session = sessions.first { $0.id == pendingLoggingSessionID }
        if session?.status == .planned {
            workoutCardResetID = UUID()
        }
        self.pendingLoggingSessionID = nil
    }
}

private enum TrainingLogSheet: Identifiable {
    case strength(WorkoutSession)
    case ultraRunning(WorkoutSession, RunningWorkout)

    var id: String {
        switch self {
        case .strength(let session):
            "strength-\(session.id.uuidString)"
        case .ultraRunning(let session, _):
            "ultra-\(session.id.uuidString)"
        }
    }
}

private struct TodayStateCard: View {
    var rank: RankState
    var nextSession: WorkoutSession?
    var strengthLog: PerformanceLog?
    var runLog: RunningLog?

    private var state: TodayState {
        if (strengthLog?.painLevel ?? 0) >= 4 || (runLog?.painLevel ?? 0) >= 4 || (strengthLog?.fatigueLevel ?? 0) >= 9 || (runLog?.fatigueLevel ?? 0) >= 9 || runLog?.hadGIIssues == true {
            return .recovery
        }
        if (strengthLog?.rpe ?? 5) >= 8 || (runLog?.rpe ?? 5) >= 8 {
            return .careful
        }
        return .green
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                RankBadge(rank: rank.rank)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Today state")
                        .font(.system(.title3, design: .rounded, weight: .bold))
                    Text(nextSession.map { "\($0.domain.title): \($0.title)" } ?? "No training due today")
                        .font(.caption)
                        .foregroundStyle(AppTheme.muted)
                        .lineLimit(2)
                }
                Spacer()
                StatusPill(text: state.title, color: state.color, systemImage: state.icon)
            }

            HStack(spacing: 7) {
                SignalChip(title: "Effort", value: effortValue, color: effortColor)
                SignalChip(title: "Pain", value: painValue, color: painColor)
                SignalChip(title: "Fatigue", value: fatigueValue, color: fatigueColor)
                SignalChip(title: "Fuel", value: fuelValue, color: fuelColor)
            }

            HStack {
                InfoLine(title: "Rank", value: "\(rank.rank.title) · XP \(rank.xp)")
                Gauge(value: Double(rank.xp), in: 0...Double(nextRankTarget(for: rank))) {
                    EmptyView()
                }
                .tint(AppTheme.gold)
                .frame(width: 92)
            }
        }
        .card()
    }

    private var effortValue: String {
        "S \(strengthLog?.rpe ?? 5) · R \(runLog?.rpe ?? 5)"
    }

    private var painValue: String {
        "S \(strengthLog?.painLevel ?? 0) · R \(runLog?.painLevel ?? 0)"
    }

    private var fatigueValue: String {
        "S \(strengthLog?.fatigueLevel ?? 5) · R \(runLog?.fatigueLevel ?? 5)"
    }

    private var fuelValue: String {
        guard let runLog else { return "No run" }
        if runLog.hadGIIssues { return "GI flag" }
        return runLog.carbsPerHour > 0 ? "\(runLog.carbsPerHour)g/hr" : "Not logged"
    }

    private var effortColor: Color {
        (strengthLog?.rpe ?? 5) >= 8 || (runLog?.rpe ?? 5) >= 8 ? AppTheme.warning : AppTheme.accent
    }

    private var painColor: Color {
        (strengthLog?.painLevel ?? 0) >= 4 || (runLog?.painLevel ?? 0) >= 4 ? AppTheme.warning : AppTheme.accent
    }

    private var fatigueColor: Color {
        (strengthLog?.fatigueLevel ?? 5) >= 9 || (runLog?.fatigueLevel ?? 5) >= 9 ? AppTheme.warning : AppTheme.gold
    }

    private var fuelColor: Color {
        runLog?.hadGIIssues == true ? AppTheme.warning : AppTheme.gold
    }

    private func nextRankTarget(for rankState: RankState) -> Int {
        CalisthenicsRank.allCases.first(where: { $0.minimumXP > rankState.xp })?.minimumXP ?? max(rankState.xp, CalisthenicsRank.apex.minimumXP)
    }
}

private enum TodayState {
    case green
    case careful
    case recovery

    var title: String {
        switch self {
        case .green: "Green"
        case .careful: "Careful"
        case .recovery: "Recovery"
        }
    }

    var color: Color {
        switch self {
        case .green: AppTheme.accent
        case .careful: AppTheme.gold
        case .recovery: AppTheme.warning
        }
    }

    var icon: String {
        switch self {
        case .green: "checkmark.circle.fill"
        case .careful: "exclamationmark.circle.fill"
        case .recovery: "heart.fill"
        }
    }
}

private struct SignalChip: View {
    var title: String
    var value: String
    var color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(AppTheme.muted)
            Text(value)
                .font(.caption.weight(.bold))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 7)
        .padding(.vertical, 8)
        .background(AppTheme.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                .stroke(color.opacity(0.16), lineWidth: 1)
        )
    }
}

struct WorkoutPrescriptionCard: View {
    var session: WorkoutSession
    var prescriptions: [SetPrescription]
    var blocks: [WorkoutBlock]
    var onComplete: () -> Void
    @State private var completedPrescriptionIds: Set<UUID> = []
    @State private var didCompleteSession = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(session.title)
                    .font(.system(.title3, design: .rounded, weight: .bold))
                    .foregroundStyle(AppTheme.text)
                Spacer(minLength: 12)
                Text(session.focus.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppTheme.muted)
            }

            VStack(spacing: 0) {
                ForEach(Array(prescriptions.enumerated()), id: \.element.id) { index, item in
                    CompactPrescriptionRow(
                        item: item,
                        block: blocks.first(where: { $0.id == item.blockId }),
                        isComplete: completedPrescriptionIds.contains(item.id),
                        onToggle: { toggle(item) },
                        onComplete: { complete(item) }
                    )
                    if index < prescriptions.count - 1 {
                        Divider()
                    }
                }
            }
            .background(AppTheme.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                    .stroke(AppTheme.divider, lineWidth: 1)
            )
        }
        .card(padding: 14)
        .onChange(of: completedPrescriptionIds) { _, ids in
            guard !didCompleteSession, !prescriptions.isEmpty, ids.count == prescriptions.count else { return }
            didCompleteSession = true
            onComplete()
        }
    }

    private func toggle(_ item: SetPrescription) {
        if completedPrescriptionIds.contains(item.id) {
            completedPrescriptionIds.remove(item.id)
        } else {
            completedPrescriptionIds.insert(item.id)
        }
    }

    private func complete(_ item: SetPrescription) {
        completedPrescriptionIds.insert(item.id)
    }
}

private struct CompactPrescriptionRow: View {
    var item: SetPrescription
    var block: WorkoutBlock?
    var isComplete: Bool
    var onToggle: () -> Void
    var onComplete: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            WorkoutInfoPopover(prescription: item, block: block, onDone: onComplete) {
                HStack(alignment: .center, spacing: 12) {
                    Text(item.exercise.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppTheme.text)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(prescriptionText(item))
                        .font(.system(.subheadline, design: .rounded, weight: .bold))
                        .foregroundStyle(AppTheme.text)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(AppTheme.muted.opacity(0.72))
                }
                .padding(.leading, 10)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .frame(maxWidth: .infinity)

            Button(action: onToggle) {
                Image(systemName: isComplete ? "checkmark.circle.fill" : "circle")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(isComplete ? AppTheme.accent : AppTheme.muted)
                    .frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isComplete ? "\(item.exercise.title) done" : "Mark \(item.exercise.title) done")
            .accessibilityIdentifier(isComplete ? "exercise-checkbox-checked" : "exercise-checkbox-unchecked")
        }
        .padding(.trailing, 10)
    }
}

private struct UpcomingSessionCard: View {
    var session: WorkoutSession

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("No session due today")
                    .font(.title3.bold())
                Spacer()
                StatusPill(text: "Scheduled", systemImage: "calendar")
            }
            InfoLine(title: "Next session", value: session.title)
            InfoLine(title: "Coach", value: session.domain.title)
            InfoLine(title: "Date", value: session.scheduledDate.formatted(date: .abbreviated, time: .omitted))
            Text("Future sessions stay in Log until their scheduled day.")
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
        }
        .card()
    }
}

private struct RunPrescriptionCard: View {
    var session: WorkoutSession
    var workout: RunningWorkout?
    var onComplete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.title)
                        .font(.system(.title3, design: .rounded, weight: .bold))
                    Text(workout?.runType.title ?? session.focus.title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.accent)
                }
                Spacer()
                StatusPill(text: "Ultra", systemImage: "figure.run")
            }

            if let workout {
                VStack(spacing: 8) {
                    InfoLine(title: "Target", value: "\(distanceText(km: workout.targetDistanceKm)) · \(minutesText(workout.targetDurationMinutes))")
                    InfoLine(title: "HR", value: "\(workout.targetHeartRateLow)-\(workout.targetHeartRateHigh) bpm")
                    InfoLine(title: "Pace guide", value: paceText(secondsPerKm: workout.targetPaceSecondsPerKm))
                    InfoLine(title: "Terrain", value: "\(workout.terrain.title) · \(workout.targetElevationMeters)m up")
                    InfoLine(title: "Walk plan", value: shortWalkPlan(workout.runWalkStrategy))
                }

                Text(workout.purpose)
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)

                Text(workout.fuelingPlan)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(AppTheme.gold)

                Button(action: onComplete) {
                    Label("Log run", systemImage: "checkmark.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryActionButtonStyle())
            } else {
                Text("This ultra session is missing its run prescription. Regenerate the ultra week from Coach.")
                    .font(.caption)
                    .foregroundStyle(AppTheme.warning)
            }
        }
        .card(padding: 14)
    }
}

private func shortWalkPlan(_ strategy: String) -> String {
    let normalized = strategy.lowercased()
    if normalized.contains("climb") {
        return "Walk climbs early"
    }
    if normalized.contains("power") || normalized.contains("hike") {
        return "Power-hike steep climbs"
    }
    if normalized.contains("run") && normalized.contains("steady") {
        return "Run steady"
    }
    if normalized.contains("run") && normalized.contains("easy") {
        return "Run easy"
    }
    return strategy
}

private struct EmptyPlanCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("No AI plan yet")
                .font(.title3.bold())
            Text("Open Coach and generate an AI week to populate Today and Log.")
                .font(.subheadline)
                .foregroundStyle(AppTheme.muted)
        }
        .card()
    }
}

private struct WeekCompleteCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Week processed")
                .font(.title3.bold())
            Text("All currently planned sessions are either completed, missed, or deloaded. Your Progress screen now reflects the score changes.")
                .font(.subheadline)
                .foregroundStyle(AppTheme.muted)
        }
        .card()
    }
}
