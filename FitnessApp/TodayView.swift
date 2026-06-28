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
    @State private var pendingLoggingSessionID: UUID?
    @State private var previewSession: WorkoutSession?
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

    private var streakSnapshot: TrainingStreakSnapshot {
        let computed = trainingStreakSnapshot(from: sessions)
        if computed.best > 0 { return computed }
        return TrainingStreakSnapshot(current: rank.streak, best: rank.displayedBestStreak)
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
        return confirmedGarminRunLogs(from: runLogs)
            .filter { weekInterval.start <= $0.completedAt && $0.completedAt < weekInterval.end }
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
                    VStack(alignment: .leading, spacing: AppTheme.sectionSpacing) {
                        ForEach(Array(dueSessions.enumerated()), id: \.element.id) { index, session in
                            if session.isRun {
                                RunPrescriptionCard(
                                    session: session,
                                    prominent: index == 0
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
                        message: "Open Coach to check automatic planning status."
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

                MetricStrip(cells: [
                    MetricCellModel(label: "STREAK", value: "\(streakSnapshot.current)"),
                    MetricCellModel(label: "BEST", value: "\(streakSnapshot.best)"),
                    MetricCellModel(label: "WEEK", value: runDistanceText(km: thisWeekKm))
                ])
                .entrance(3)

                if !thisWeekSessions.isEmpty {
                    ThisWeekSection(sessions: thisWeekSessions, onSelect: { previewSession = $0 })
                        .entrance(4)
                }
            }
            .sheet(item: $loggingSession, onDismiss: resetCheckedWorkoutIfLogWasCancelled) { session in
                LogWorkoutView(session: session, profile: profile)
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

            if session.estimatedDurationMinutes > 0 || garminWatchPill(for: session) != nil {
                HStack(spacing: 14) {
                    if session.estimatedDurationMinutes > 0 {
                        DurationPill(minutes: session.estimatedDurationMinutes)
                    }
                    if let pill = garminWatchPill(for: session) {
                        StatusPill(text: pill.text, color: pill.color, systemImage: pill.systemImage)
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

        }
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
                if let pill = garminWatchPill(for: session) {
                    HStack {
                        Text("Watch")
                            .font(.footnote)
                            .foregroundStyle(AppTheme.muted)
                        Spacer()
                        StatusPill(text: pill.text, color: pill.color, systemImage: pill.systemImage)
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

private func garminWatchPill(for session: WorkoutSession) -> (text: String, color: Color, systemImage: String)? {
    guard session.isRun else { return nil }
    if session.pushedToGarminAt != nil || session.garminSyncStatus == .synced {
        return ("On your watch", AppTheme.muted, "applewatch")
    }

    switch session.garminSyncStatus {
    case .some(.pending), .some(.retrying), .some(.blockedOnDelete):
        return ("Syncing to watch", AppTheme.muted, "hourglass")
    case .some(.failed):
        return ("Watch sync failed", AppTheme.warning, "exclamationmark.triangle.fill")
    case .some(.deleted), .none:
        return ("Awaiting Garmin", AppTheme.muted, "applewatch.radiowaves.left.and.right")
    case .some(.synced):
        return ("On your watch", AppTheme.muted, "applewatch")
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
        case .partial: "Partial"
        case .deload: "Deload"
        case .missed: "Missed"
        case .planned: isToday ? "Today" : "Planned"
        }
    }

    private var stateColor: Color {
        switch session.status {
        case .completed, .partial, .deload: AppTheme.accent
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
