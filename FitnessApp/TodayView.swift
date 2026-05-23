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
                    UpcomingSessionCard(session: session)
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
        HStack(spacing: 14) {
            RankBadge(rank: rank.rank)
            VStack(alignment: .leading, spacing: 6) {
                Text(rank.rank.title)
                    .font(.system(.title3, design: .rounded, weight: .bold))
                    .foregroundStyle(AppTheme.accent)
                Text("Rank")
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 8) {
                Text("XP \(rank.xp)")
                    .font(.system(.body, design: .rounded, weight: .semibold))
                Gauge(value: Double(rank.xp), in: 0...Double(nextRankTarget(for: rank))) {
                    EmptyView()
                }
                .tint(AppTheme.gold)
                Text("\(rank.xp) / \(nextRankTarget(for: rank))")
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            }
            .frame(width: 128)
        }
        .card()
    }

    private func nextRankTarget(for rankState: RankState) -> Int {
        CalisthenicsRank.allCases.first(where: { $0.minimumXP > rankState.xp })?.minimumXP ?? max(rankState.xp, CalisthenicsRank.apex.minimumXP)
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
                        onToggle: { toggle(item) }
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
}

private struct CompactPrescriptionRow: View {
    var item: SetPrescription
    var block: WorkoutBlock?
    var isComplete: Bool
    var onToggle: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Text(item.exercise.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppTheme.text)
                .lineLimit(1)
            Spacer()
            Text(prescriptionText(item))
                .font(.system(.subheadline, design: .rounded, weight: .bold))
                .foregroundStyle(AppTheme.text)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            WorkoutInfoButton(prescription: item, block: block)
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
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
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
                ReadinessTile(title: "RPE", value: "\(log?.rpe ?? 7)", status: rpeStatus, color: rpeColor)
                ReadinessTile(title: "Pain", value: "\(log?.painLevel ?? 0)", status: painStatus, color: painColor)
                ReadinessTile(title: "Fatigue", value: "\(log?.fatigueLevel ?? 5)", status: fatigueStatus, color: fatigueColor)
            }
        }
    }

    private var rpeStatus: String {
        guard let rpe = log?.rpe else { return "Baseline" }
        return rpe >= 8 ? "Hard" : "Moderate"
    }

    private var painStatus: String {
        guard let pain = log?.painLevel else { return "None" }
        return pain >= 4 ? "Flag" : "None"
    }

    private var fatigueStatus: String {
        guard let fatigue = log?.fatigueLevel else { return "Some" }
        return fatigue >= 9 ? "Flag" : fatigue >= 6 ? "Some" : "Low"
    }

    private var rpeColor: Color {
        (log?.rpe ?? 7) >= 9 ? AppTheme.warning : AppTheme.accent
    }

    private var painColor: Color {
        (log?.painLevel ?? 0) >= 4 ? AppTheme.warning : AppTheme.accent
    }

    private var fatigueColor: Color {
        (log?.fatigueLevel ?? 5) >= 9 ? AppTheme.warning : AppTheme.gold
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
