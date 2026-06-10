import SwiftData
import SwiftUI

struct TodayView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \WorkoutBlock.orderIndex) private var blocks: [WorkoutBlock]
    @Query(sort: \SetPrescription.orderIndex) private var prescriptions: [SetPrescription]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query(sort: \RunLog.completedAt, order: .reverse) private var runLogs: [RunLog]
    @Query private var ranks: [RankState]

    var profile: UserProfile
    @State private var loggingSession: WorkoutSession?
    @State private var loggingRunSession: WorkoutSession?
    @State private var editingPendingRun: PendingRun?
    @State private var pendingLoggingSessionID: UUID?
    @State private var workoutCardResetID = UUID()

    private struct PendingRun: Identifiable {
        let session: WorkoutSession
        let log: RunLog
        var id: UUID { log.id }
    }

    private var dueSessions: [WorkoutSession] {
        duePlannedSessions(from: sessions)
    }

    /// Synced runs waiting for athlete confirmation, joined to their session —
    /// any session, today or past, planned or missed — so a pending card
    /// survives midnight instead of vanishing with the due list.
    private var pendingConfirmations: [PendingRun] {
        runLogs
            .filter(\.needsConfirmation)
            .compactMap { log in
                sessions.first { $0.id == log.sessionId }.map { PendingRun(session: $0, log: log) }
            }
            .sorted { $0.session.scheduledDate < $1.session.scheduledDate }
    }

    private var pendingSessionIds: Set<UUID> {
        Set(pendingConfirmations.map(\.session.id))
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

                ForEach(pendingConfirmations) { pending in
                    ConfirmRunCard(
                        session: pending.session,
                        log: pending.log,
                        onConfirm: { rpe, feel in confirmRun(session: pending.session, log: pending.log, rpe: rpe, feel: feel) },
                        onEdit: { editingPendingRun = pending }
                    )
                }

                if !dueSessions.isEmpty {
                    // A due session with a pending log already renders above.
                    ForEach(dueSessions.filter { !pendingSessionIds.contains($0.id) }) { session in
                        if session.isRun {
                            RunPrescriptionCard(session: session, onLog: { beginRunLogging(session) })
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
            .sheet(item: $loggingRunSession) { session in
                LogRunView(session: session)
            }
            .sheet(item: $editingPendingRun) { edit in
                LogRunView(session: edit.session, prefilledFrom: edit.log)
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

    private func beginRunLogging(_ session: WorkoutSession) {
        guard session.status == .planned else { return }
        loggingRunSession = session
    }

    /// completeRun owns the shared confirm/scoring path (including refunding
    /// a wrongly-applied miss when the run synced after the missed sweep).
    private func confirmRun(session: WorkoutSession, log: RunLog, rpe: Int, feel: Int) {
        guard log.needsConfirmation else { return }
        try? completeRun(session: session, log: log, rpe: rpe, feelScore: feel, ranks: ranks, in: modelContext)
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

private struct RunPrescriptionCard: View {
    var session: WorkoutSession
    var onLog: () -> Void

    private var purposeText: String {
        var purpose = session.summary
        if purpose.hasPrefix("AI: ") {
            purpose = String(purpose.dropFirst(4))
        }
        return purpose.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(session.title)
                    .font(.system(.title3, design: .rounded, weight: .bold))
                    .foregroundStyle(AppTheme.text)
                Spacer(minLength: 12)
                StatusPill(text: (session.runKind ?? .easy).title, systemImage: "figure.run")
            }

            if session.estimatedDurationMinutes > 0 {
                HStack(spacing: 8) {
                    DurationPill(minutes: session.estimatedDurationMinutes)
                    Spacer(minLength: 0)
                }
            }

            VStack(spacing: 0) {
                RunDetailRow(title: "Distance", value: runDistanceText(km: session.plannedDistanceKm))
                if session.plannedElevationM > 0 {
                    Divider()
                    RunDetailRow(title: "Elevation gain", value: "\(session.plannedElevationM) m+")
                }
                Divider()
                RunDetailRow(title: "Target", value: runTargetText(session: session))
            }
            .background(AppTheme.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                    .stroke(AppTheme.divider, lineWidth: 1)
            )

            if !purposeText.isEmpty {
                Text(purposeText)
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button("Log this run", action: onLog)
                .buttonStyle(PrimaryActionButtonStyle())
                .accessibilityIdentifier("log-run-button")
        }
        .card(padding: 14)
    }
}

private struct ConfirmRunCard: View {
    var session: WorkoutSession
    var log: RunLog
    var onConfirm: (_ rpe: Int, _ feel: Int) -> Void
    var onEdit: () -> Void

    @State private var rpe = 6
    @State private var howFelt = 3

    /// "Monday's run · 8 Jun" when the session is not scheduled today, so a
    /// confirmation that survived midnight still names the day it belongs to.
    private var scheduledDayText: String? {
        let calendar = Calendar.current
        guard !calendar.isDateInToday(session.scheduledDate) else { return nil }
        let weekday = session.scheduledDate.formatted(.dateTime.weekday(.wide))
        let date = session.scheduledDate.formatted(date: .abbreviated, time: .omitted)
        return "\(weekday)'s run · \(date)"
    }

    private var actualsText: String {
        var parts: [String] = []
        if log.distanceKm > 0 {
            parts.append(runDistanceText(km: log.distanceKm))
        }
        if log.movingSeconds > 0 {
            parts.append(Self.movingTimeText(seconds: log.movingSeconds))
        }
        if log.elevationGainM > 0 {
            parts.append("\(log.elevationGainM) m+")
        }
        if log.averageHr > 0 {
            parts.append("avg \(log.averageHr) bpm")
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(session.title)
                    .font(.system(.title3, design: .rounded, weight: .bold))
                    .foregroundStyle(AppTheme.text)
                Spacer(minLength: 12)
                StatusPill(text: "Synced from Garmin", systemImage: "applewatch.radiowaves.left.and.right")
            }

            if let scheduledDayText {
                Text(scheduledDayText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppTheme.muted)
            }

            if !actualsText.isEmpty {
                Text(actualsText)
                    .font(.system(.subheadline, design: .rounded, weight: .bold))
                    .foregroundStyle(AppTheme.text)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(AppTheme.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                            .stroke(AppTheme.divider, lineWidth: 1)
                    )
            }

            ReadinessSlider(
                title: "Perceived effort",
                systemImage: "speedometer",
                value: $rpe,
                range: 1...10,
                descriptor: ReadinessScale.perceivedEffort
            )
            Divider()
            ReadinessSlider(
                title: "How did you feel?",
                systemImage: "face.smiling",
                value: $howFelt,
                range: 1...5,
                descriptor: ReadinessScale.howIFelt
            )

            Button("Confirm run") { onConfirm(rpe, howFelt) }
                .buttonStyle(PrimaryActionButtonStyle())
                .accessibilityIdentifier("confirm-run-button")

            Button("Edit details", action: onEdit)
                .buttonStyle(SecondaryActionButtonStyle())
                .accessibilityIdentifier("edit-run-details-button")
        }
        .card(padding: 14)
    }

    private static func movingTimeText(seconds: Int) -> String {
        let hours = seconds / 3_600
        let minutes = (seconds % 3_600) / 60
        if hours > 0 {
            return "\(hours):" + String(format: "%02d", minutes)
        }
        return "\(max(1, minutes)) min"
    }
}

private struct RunDetailRow: View {
    var title: String
    var value: String

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppTheme.text)
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(value)
                .font(.system(.subheadline, design: .rounded, weight: .bold))
                .foregroundStyle(AppTheme.text)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
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
            if session.isRun, session.plannedDistanceKm > 0 {
                InfoLine(title: "Distance", value: runDistanceText(km: session.plannedDistanceKm))
            }
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
