import SwiftData
import SwiftUI

struct TodayView: View {
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \WorkoutBlock.orderIndex) private var blocks: [WorkoutBlock]
    @Query(sort: \SetPrescription.orderIndex) private var prescriptions: [SetPrescription]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query private var ranks: [RankState]

    var profile: UserProfile
    @State private var loggingSession: WorkoutSession?
    @State private var pendingLoggingSessionID: UUID?
    @State private var workoutCardResetID = UUID()

    private var dueSession: WorkoutSession? {
        duePlannedSession(from: sessions)
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

    var body: some View {
        NavigationStack {
            ScreenBackground {
                BrandHeader()

                TodayHeroCard(rank: rank)

                if let session = dueSession {
                    WorkoutPrescriptionCard(
                        session: session,
                        prescriptions: prescriptionsForSession(session),
                        blocks: blocksForSession(session),
                        onComplete: { beginLogging(session) }
                    )
                    .id("\(session.id.uuidString)-\(workoutCardResetID.uuidString)")
                    ReadinessSummary(log: latestLog)
                } else if sessions.isEmpty {
                    EmptyPlanCard()
                } else if let session = futureSession {
                    UpcomingSessionCard(session: session, prescriptions: prescriptionsForSession(session))
                } else {
                    WeekCompleteCard()
                }
            }
            .sheet(item: $loggingSession, onDismiss: resetCheckedWorkoutIfLogWasCancelled) { session in
                LogWorkoutView(session: session, profile: profile)
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

    private func beginLogging(_ session: WorkoutSession) {
        guard session.status == .planned else { return }
        pendingLoggingSessionID = session.id
        loggingSession = session
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

private struct TodayHeroCard: View {
    var rank: RankState

    var body: some View {
        HStack(spacing: 10) {
            MetricCard(title: "Streak", value: "\(rank.streak)", subtitle: "Current sessions", systemImage: "flame.fill")
            MetricCard(title: "Best", value: "\(rank.displayedBestStreak)", subtitle: "Best streak", systemImage: "checkmark.seal.fill")
        }
    }
}

struct WorkoutPrescriptionCard: View {
    var session: WorkoutSession
    var prescriptions: [SetPrescription]
    var blocks: [WorkoutBlock]
    var onComplete: () -> Void
    @State private var completedPrescriptionIds: Set<UUID> = []
    @State private var didCompleteSession = false

    private var durationMinutes: Int {
        estimatedWorkoutDurationMinutes(for: session, prescriptions: prescriptions)
    }

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

            if durationMinutes > 0 || session.plannedEffortLabel != nil {
                HStack(spacing: 8) {
                    DurationPill(minutes: durationMinutes)
                    if let effortLabel = session.plannedEffortLabel {
                        EffortPill(
                            label: effortLabel,
                            targetRPE: session.plannedEffortTargetRPE > 0 ? session.plannedEffortTargetRPE : nil
                        )
                    }
                    Spacer(minLength: 0)
                }
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
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.exercise.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AppTheme.text)
                            .lineLimit(1)
                        if let effortLabel = item.plannedEffortLabel {
                            EffortPill(
                                label: effortLabel,
                                targetRPE: item.plannedEffortTargetRPE > 0 ? item.plannedEffortTargetRPE : nil
                            )
                        }
                    }
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
    var prescriptions: [SetPrescription] = []

    private var durationMinutes: Int {
        estimatedWorkoutDurationMinutes(for: session, prescriptions: prescriptions)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("No session due today")
                    .font(.title3.bold())
                Spacer()
                StatusPill(text: "Scheduled", systemImage: "calendar")
            }
            InfoLine(title: "Next session", value: session.title)
            if durationMinutes > 0 {
                HStack {
                    Text("Duration")
                        .font(.caption)
                        .foregroundStyle(AppTheme.muted)
                    Spacer()
                    DurationPill(minutes: durationMinutes)
                }
            }
            if let effortLabel = session.plannedEffortLabel {
                HStack {
                    Text("Planned effort")
                        .font(.caption)
                        .foregroundStyle(AppTheme.muted)
                    Spacer()
                    EffortPill(
                        label: effortLabel,
                        targetRPE: session.plannedEffortTargetRPE > 0 ? session.plannedEffortTargetRPE : nil
                    )
                }
            }
            InfoLine(title: "Date", value: session.scheduledDate.formatted(date: .abbreviated, time: .omitted))
            Text("Future sessions stay in Log until their scheduled day.")
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
        }
        .card()
    }
}

private struct ReadinessSummary: View {
    var log: PerformanceLog?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Readiness")
                .font(.headline)
            HStack(spacing: 8) {
                ReadinessTile(title: "Perceived effort", value: "\(log?.rpe ?? 7)", status: perceivedEffortStatus, color: perceivedEffortColor)
                ReadinessTile(title: "Pain", value: "\(log?.painLevel ?? 0)", status: painStatus, color: painColor)
                ReadinessTile(title: "How you felt", value: howYouFeltValue, status: howYouFeltStatus, color: howYouFeltColor)
            }
        }
    }

    private var perceivedEffortStatus: String {
        guard let rpe = log?.rpe else { return "Baseline" }
        return rpe >= 8 ? "Hard" : "Moderate"
    }

    private var painStatus: String {
        guard let pain = log?.painLevel else { return "None" }
        return pain >= 4 ? "Flag" : "None"
    }

    private var howYouFeltValue: String {
        guard let fatigueLevel = log?.fatigueLevel else { return "3" }
        return "\(howYouFeltScore(fromFatigueLevel: fatigueLevel))"
    }

    private var howYouFeltStatus: String {
        guard let fatigueLevel = log?.fatigueLevel else { return "Normal" }
        switch howYouFeltScore(fromFatigueLevel: fatigueLevel) {
        case 1:
            return "Very weak"
        case 2:
            return "Weak"
        case 4:
            return "Strong"
        case 5:
            return "Very strong"
        default:
            return "Normal"
        }
    }

    private var perceivedEffortColor: Color {
        (log?.rpe ?? 7) >= 9 ? AppTheme.warning : AppTheme.accent
    }

    private var painColor: Color {
        (log?.painLevel ?? 0) >= 4 ? AppTheme.warning : AppTheme.accent
    }

    private var howYouFeltColor: Color {
        guard let fatigueLevel = log?.fatigueLevel else { return AppTheme.accent }
        switch howYouFeltScore(fromFatigueLevel: fatigueLevel) {
        case 1:
            return AppTheme.warning
        case 2:
            return AppTheme.gold
        default:
            return AppTheme.accent
        }
    }

    private func howYouFeltScore(fromFatigueLevel fatigueLevel: Int) -> Int {
        switch fatigueLevel {
        case 9...10:
            return 1
        case 7...8:
            return 2
        case 3...6:
            return 3
        case 1...2:
            return 4
        default:
            return 5
        }
    }
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
