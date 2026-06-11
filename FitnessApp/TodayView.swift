import SwiftData
import SwiftUI

struct TodayView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \WorkoutBlock.orderIndex) private var blocks: [WorkoutBlock]
    @Query(sort: \SetPrescription.orderIndex) private var prescriptions: [SetPrescription]
    @Query(sort: \RunLog.completedAt, order: .reverse) private var runLogs: [RunLog]
    @Query(sort: \GarminDailySnapshot.date, order: .reverse) private var snapshots: [GarminDailySnapshot]
    @Query private var ranks: [RankState]

    var profile: UserProfile
    @State private var loggingSession: WorkoutSession?
    @State private var loggingRunSession: WorkoutSession?
    @State private var editingPendingRun: PendingRun?
    @State private var pendingLoggingSessionID: UUID?
    @State private var previewSession: WorkoutSession?
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

    /// Morning readiness only counts when the snapshot is from today or
    /// yesterday — stale wellness shown as "readiness" would mislead.
    private var todaysSnapshot: GarminDailySnapshot? {
        guard let snapshot = snapshots.first else { return nil }
        let calendar = Calendar.current
        let age = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: snapshot.date),
            to: calendar.startOfDay(for: Date())
        ).day ?? .max
        return age <= 1 ? snapshot : nil
    }

    // MARK: Week context (display only)

    private var weekInterval: DateInterval? {
        Calendar.current.dateInterval(of: .weekOfYear, for: Date())
    }

    private var thisWeekSessions: [WorkoutSession] {
        guard let weekInterval else { return [] }
        return sessions
            .filter { weekInterval.start <= $0.scheduledDate && $0.scheduledDate < weekInterval.end }
            .sorted { $0.scheduledDate < $1.scheduledDate }
    }

    private var weekProgress: Double {
        let week = thisWeekSessions
        guard !week.isEmpty else { return 0 }
        let processed = week.filter { $0.status != .planned }.count
        return Double(processed) / Double(week.count)
    }

    private var thisWeekKm: Double {
        guard let weekInterval else { return 0 }
        return runLogs
            .filter { !$0.needsConfirmation && weekInterval.start <= $0.completedAt && $0.completedAt < weekInterval.end }
            .reduce(0) { $0 + $1.distanceKm }
    }

    var body: some View {
        NavigationStack {
            ScreenBackground {
                LockinHeader {
                    if !thisWeekSessions.isEmpty {
                        WeekRing(progress: weekProgress, label: "\(Int((weekProgress * 100).rounded()))%")
                    }
                }
                .entrance(0)

                if let snapshot = todaysSnapshot {
                    MorningReadinessStrip(snapshot: snapshot)
                        .entrance(1)
                }

                if !dueSessions.isEmpty {
                    // A due session with a pending log already renders above.
                    let visibleDueSessions = dueSessions.filter { !pendingSessionIds.contains($0.id) }
                    VStack(alignment: .leading, spacing: AppTheme.sectionSpacing) {
                        ForEach(Array(visibleDueSessions.enumerated()), id: \.element.id) { index, session in
                            if session.isRun {
                                RunPrescriptionCard(
                                    session: session,
                                    prominent: index == 0,
                                    onLog: { beginRunLogging(session) }
                                )
                            } else {
                                WorkoutPrescriptionCard(
                                    session: session,
                                    prescriptions: prescriptionsForSession(session),
                                    blocks: blocksForSession(session),
                                    prominent: index == 0,
                                    onComplete: { beginLogging(session) }
                                )
                                .id("\(session.id.uuidString)-\(workoutCardResetID.uuidString)")
                            }
                        }
                    }
                    .entrance(2)
                } else if sessions.isEmpty {
                    EmptyStateView(
                        systemImage: "sparkles",
                        title: "No AI plan yet",
                        message: "Open Coach and generate an AI week to populate Today and Log."
                    )
                    .entrance(2)
                } else if let session = futureSession {
                    UpcomingSessionCard(session: session, prescriptions: prescriptionsForSession(session))
                        .entrance(2)
                } else {
                    EmptyStateView(
                        systemImage: "checkmark.seal",
                        title: "Week processed",
                        message: "All currently planned sessions are either completed, missed, or deloaded. Your Progress screen now reflects the score changes."
                    )
                    .entrance(2)
                }

                ForEach(pendingConfirmations) { pending in
                    ConfirmRunCard(
                        session: pending.session,
                        log: pending.log,
                        onConfirm: { rpe, feel in confirmRun(session: pending.session, log: pending.log, rpe: rpe, feel: feel) },
                        onEdit: { editingPendingRun = pending }
                    )
                }
                .entrance(3)

                MetricStrip(cells: [
                    MetricCellModel(label: "STREAK", value: "\(rank.streak)"),
                    MetricCellModel(label: "BEST", value: "\(rank.displayedBestStreak)"),
                    MetricCellModel(label: "WEEK", value: runDistanceText(km: thisWeekKm))
                ])
                .entrance(4)

                if !thisWeekSessions.isEmpty {
                    ThisWeekSection(sessions: thisWeekSessions, onSelect: { previewSession = $0 })
                        .entrance(5)
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
            .sheet(item: $previewSession) { session in
                FutureWorkoutPreviewSheet(
                    session: session,
                    blocks: blocksForSession(session),
                    prescriptions: prescriptionsForSession(session)
                )
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
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

// MARK: - Entrance choreography

/// One-shot staggered fade-up for Today's sections. Skipped entirely under
/// Reduce Motion.
private struct EntranceModifier: ViewModifier {
    let index: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : 10)
            .onAppear {
                guard !shown else { return }
                if reduceMotion {
                    shown = true
                } else {
                    withAnimation(.smooth(duration: 0.45).delay(Double(index) * 0.05)) {
                        shown = true
                    }
                }
            }
    }
}

private extension View {
    func entrance(_ index: Int) -> some View {
        modifier(EntranceModifier(index: index))
    }
}

// MARK: - Due session blocks

struct WorkoutPrescriptionCard: View {
    var session: WorkoutSession
    var prescriptions: [SetPrescription]
    var blocks: [WorkoutBlock]
    var prominent: Bool = false
    var onComplete: () -> Void
    @State private var completedPrescriptionIds: Set<UUID> = []

    private var durationMinutes: Int {
        estimatedWorkoutDurationMinutes(for: session, prescriptions: prescriptions)
    }

    private var allComplete: Bool {
        !prescriptions.isEmpty && completedPrescriptionIds.count == prescriptions.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SessionHeading(
                title: session.title,
                trailingText: session.focus.title,
                prominent: prominent
            )

            if durationMinutes > 0 || session.plannedEffortLabel != nil {
                HStack(spacing: 14) {
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
                Hairline()
                ForEach(Array(prescriptions.enumerated()), id: \.element.id) { index, item in
                    CompactPrescriptionRow(
                        item: item,
                        block: blocks.first(where: { $0.id == item.blockId }),
                        isComplete: completedPrescriptionIds.contains(item.id),
                        onToggle: { toggle(item) },
                        onComplete: { complete(item) }
                    )
                    if index < prescriptions.count - 1 {
                        Hairline()
                    }
                }
                Hairline()
            }

            // Logging is an explicit decision, not a side effect of the last
            // checkbox — the button appears once every row is checked.
            if allComplete {
                Button("Finish & log", action: onComplete)
                    .buttonStyle(PrimaryActionButtonStyle())
                    .accessibilityIdentifier("finish-and-log-button")
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .animation(.smooth(duration: 0.3), value: allComplete)
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

/// The day's heading: a TODAY eyebrow plus the session title. The first due
/// session carries display type; any further sessions stay at section size.
private struct SessionHeading: View {
    var title: String
    var trailingText: String?
    var prominent: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: prominent ? 8 : 4) {
            if prominent {
                MicroLabel(text: "TODAY", color: AppTheme.accent)
            }
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(prominent ? .lockinDisplay : .lockinSection)
                    .foregroundStyle(AppTheme.text)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 12)
                if let trailingText {
                    Text(trailingText)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(AppTheme.muted)
                }
            }
        }
    }
}

private struct RunPrescriptionCard: View {
    var session: WorkoutSession
    var prominent: Bool = false
    var onLog: () -> Void

    private var purposeText: String {
        var purpose = session.summary
        if purpose.hasPrefix("AI: ") {
            purpose = String(purpose.dropFirst(4))
        }
        return purpose.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SessionHeading(
                title: session.title,
                trailingText: (session.runKind ?? .easy).title == session.title ? nil : (session.runKind ?? .easy).title,
                prominent: prominent
            )

            if session.estimatedDurationMinutes > 0 || session.pushedToGarminAt != nil {
                HStack(spacing: 14) {
                    if session.estimatedDurationMinutes > 0 {
                        DurationPill(minutes: session.estimatedDurationMinutes)
                    }
                    if session.pushedToGarminAt != nil {
                        StatusPill(text: "On your watch", color: AppTheme.muted, systemImage: "applewatch")
                    }
                    Spacer(minLength: 0)
                }
            }

            VStack(spacing: 0) {
                Hairline()
                RunDetailRow(title: "Distance", value: runDistanceText(km: session.plannedDistanceKm))
                Hairline()
                if session.plannedElevationM > 0 {
                    RunDetailRow(title: "Elevation gain", value: "\(session.plannedElevationM) m+")
                    Hairline()
                }
                RunDetailRow(title: "Target", value: runTargetText(session: session))
                Hairline()
            }

            if !purposeText.isEmpty {
                Text(purposeText)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button("Log this run", action: onLog)
                .buttonStyle(PrimaryActionButtonStyle())
                .accessibilityIdentifier("log-run-button")
        }
    }
}

private struct ConfirmRunCard: View {
    var session: WorkoutSession
    var log: RunLog
    var onConfirm: (_ rpe: Int, _ feel: Int) -> Void
    var onEdit: () -> Void

    @State private var rpe = 6
    @State private var howFelt = 3
    @State private var confirmTapped = false

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
        if log.elevationLossM > 0 {
            parts.append("\(log.elevationLossM) m−")
        }
        if log.averageHr > 0 {
            parts.append("avg \(log.averageHr) bpm")
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(session.title)
                        .font(.lockinSection)
                        .foregroundStyle(AppTheme.text)
                    Spacer(minLength: 12)
                    StatusPill(text: "Synced from Garmin", color: AppTheme.accent, systemImage: "applewatch.radiowaves.left.and.right")
                }
                if let scheduledDayText {
                    Text(scheduledDayText)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(AppTheme.muted)
                }
            }

            if !actualsText.isEmpty {
                Text(actualsText)
                    .font(.system(size: 16, weight: .semibold).monospacedDigit())
                    .foregroundStyle(AppTheme.text)
            }

            VStack(spacing: 2) {
                ReadinessSlider(
                    title: "Perceived effort",
                    systemImage: "speedometer",
                    value: $rpe,
                    range: 1...10,
                    descriptor: ReadinessScale.perceivedEffort
                )
                Hairline()
                ReadinessSlider(
                    title: "How did you feel?",
                    systemImage: "face.smiling",
                    value: $howFelt,
                    range: 1...5,
                    descriptor: ReadinessScale.howIFelt
                )
            }

            Button("Confirm run") {
                confirmTapped = true
                onConfirm(rpe, howFelt)
            }
            .buttonStyle(PrimaryActionButtonStyle())
            .sensoryFeedback(.success, trigger: confirmTapped) { _, newValue in newValue }
            .accessibilityIdentifier("confirm-run-button")

            Button("Edit details", action: onEdit)
                .buttonStyle(SecondaryActionButtonStyle())
                .accessibilityIdentifier("edit-run-details-button")
        }
        .card()
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
                .font(.subheadline)
                .foregroundStyle(AppTheme.muted)
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(value)
                .font(.system(size: 15, weight: .semibold).monospacedDigit())
                .foregroundStyle(AppTheme.text)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .padding(.vertical, 12)
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
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.exercise.title)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(isComplete ? AppTheme.muted : AppTheme.text)
                            .strikethrough(isComplete, color: AppTheme.faint)
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
                        .font(.system(size: 15, weight: .semibold).monospacedDigit())
                        .foregroundStyle(isComplete ? AppTheme.muted : AppTheme.text)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Image(systemName: "info.circle")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(AppTheme.faint)
                }
                .padding(.vertical, 11)
                .contentShape(Rectangle())
            }
            .frame(maxWidth: .infinity)

            CheckCircle(
                isComplete: isComplete,
                accessibilityName: item.exercise.title,
                onToggle: onToggle
            )
        }
        .animation(.easeOut(duration: 0.2), value: isComplete)
    }
}

// MARK: - States and context

private struct UpcomingSessionCard: View {
    var session: WorkoutSession
    var prescriptions: [SetPrescription] = []

    private var durationMinutes: Int {
        estimatedWorkoutDurationMinutes(for: session, prescriptions: prescriptions)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 8) {
                MicroLabel(text: "SCHEDULED", color: AppTheme.accent)
                Text("No session due today")
                    .font(.lockinSection)
                    .foregroundStyle(AppTheme.text)
            }

            VStack(spacing: 10) {
                InfoLine(title: "Next session", value: session.title)
                if session.isRun, session.plannedDistanceKm > 0 {
                    InfoLine(title: "Distance", value: runDistanceText(km: session.plannedDistanceKm))
                }
                if session.isRun, session.pushedToGarminAt != nil {
                    HStack {
                        Text("Watch")
                            .font(.footnote)
                            .foregroundStyle(AppTheme.muted)
                        Spacer()
                        StatusPill(text: "On your watch", color: AppTheme.muted, systemImage: "applewatch")
                    }
                }
                if durationMinutes > 0 {
                    HStack {
                        Text("Duration")
                            .font(.footnote)
                            .foregroundStyle(AppTheme.muted)
                        Spacer()
                        DurationPill(minutes: durationMinutes)
                    }
                }
                if let effortLabel = session.plannedEffortLabel {
                    HStack {
                        Text("Planned effort")
                            .font(.footnote)
                            .foregroundStyle(AppTheme.muted)
                        Spacer()
                        EffortPill(
                            label: effortLabel,
                            targetRPE: session.plannedEffortTargetRPE > 0 ? session.plannedEffortTargetRPE : nil
                        )
                    }
                }
                InfoLine(title: "Date", value: session.scheduledDate.formatted(date: .abbreviated, time: .omitted))
            }

            Text("Future sessions stay in Log until their scheduled day.")
                .font(.system(size: 12))
                .foregroundStyle(AppTheme.faint)
        }
        .ruled(verticalPadding: 18)
    }
}

/// This morning's Garmin readiness — the "how hard can I go today" context,
/// shown only while the snapshot is fresh. The post-session subjective
/// scores live with their sessions in Log.
private struct MorningReadinessStrip: View {
    var snapshot: GarminDailySnapshot

    private var hrvText: String {
        let trimmed = snapshot.hrvStatus.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "—" }
        return trimmed.replacingOccurrences(of: "_", with: " ").capitalized
    }

    // The Garmin sidecar zero-fills missing metrics, so zero means "no data".
    private func metricText(_ value: Int) -> String {
        value > 0 ? "\(value)" : "—"
    }

    var body: some View {
        MetricStrip(cells: [
            MetricCellModel(
                label: "READINESS",
                value: metricText(snapshot.trainingReadiness),
                valueColor: snapshot.trainingReadiness > 0 ? AppTheme.text : AppTheme.faint
            ),
            MetricCellModel(
                label: "SLEEP",
                value: metricText(snapshot.sleepScore),
                valueColor: snapshot.sleepScore > 0 ? AppTheme.text : AppTheme.faint
            ),
            MetricCellModel(
                label: "HRV",
                value: hrvText,
                valueColor: hrvText == "—" ? AppTheme.faint : AppTheme.text
            )
        ])
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Morning readiness \(metricText(snapshot.trainingReadiness)), sleep \(metricText(snapshot.sleepScore)), HRV \(hrvText)")
    }
}

/// Display-only week ledger: every session scheduled this calendar week with
/// its state at the trailing edge, ruled like the approved reference.
private struct ThisWeekSection: View {
    var sessions: [WorkoutSession]
    var onSelect: (WorkoutSession) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader("This week")
            VStack(spacing: 0) {
                Hairline()
                ForEach(Array(sessions.enumerated()), id: \.element.id) { index, session in
                    ThisWeekRow(session: session, onSelect: { onSelect(session) })
                    if index < sessions.count - 1 {
                        Hairline()
                    }
                }
                Hairline()
            }
        }
    }
}

private struct ThisWeekRow: View {
    var session: WorkoutSession
    var onSelect: () -> Void = {}

    private var isToday: Bool {
        Calendar.current.isDateInToday(session.scheduledDate)
    }

    private var stateText: String {
        switch session.status {
        case .completed: "Done"
        case .deload: "Deload"
        case .missed: "Missed"
        case .planned: isToday ? "Today" : "Planned"
        }
    }

    private var stateColor: Color {
        switch session.status {
        case .completed, .deload: AppTheme.accent
        case .missed: AppTheme.warning
        case .planned: isToday ? AppTheme.accent : AppTheme.muted
        }
    }

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 12) {
                WorkoutStatusIcon(status: session.status)
                Text(session.scheduledDate, format: .dateTime.weekday(.abbreviated))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(AppTheme.muted)
                    .frame(width: 34, alignment: .leading)
                Text(session.title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppTheme.text)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(stateText)
                    .font(.system(size: 13, weight: isToday && session.status == .planned ? .semibold : .regular))
                    .foregroundStyle(stateColor)
            }
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Open workout details")
    }
}
