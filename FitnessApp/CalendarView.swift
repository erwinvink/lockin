import SwiftData
import SwiftUI

struct CalendarView: View {
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \WorkoutBlock.orderIndex) private var blocks: [WorkoutBlock]
    @Query(sort: \SetPrescription.orderIndex) private var prescriptions: [SetPrescription]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query(sort: \RunLog.completedAt, order: .reverse) private var runLogs: [RunLog]
    @State private var historyPage = 0
    @State private var selectedSession: WorkoutSession?

    private let historyPageSize = 25

    private var openSessions: [WorkoutSession] {
        sessions
            .filter { $0.status == .planned }
            .sorted { $0.scheduledDate < $1.scheduledDate }
    }

    private var historySessions: [WorkoutSession] {
        sessions
            .filter { $0.status != .planned }
            .sorted { $0.scheduledDate > $1.scheduledDate }
    }

    private var historyTotalPages: Int {
        max(1, (historySessions.count + historyPageSize - 1) / historyPageSize)
    }

    private var pagedHistorySessions: [WorkoutSession] {
        let safePage = min(historyPage, historyTotalPages - 1)
        let start = safePage * historyPageSize
        return Array(historySessions.dropFirst(start).prefix(historyPageSize))
    }

    private struct HistoryWeek: Identifiable {
        let weekStart: Date
        let weekNumber: Int
        let sessions: [WorkoutSession]
        var id: Date { weekStart }
    }

    /// History grouped into calendar weeks — runners read their past in
    /// weekly blocks, not in flat rows.
    private var pagedHistoryWeeks: [HistoryWeek] {
        let calendar = Calendar.current
        var weeks: [HistoryWeek] = []
        for session in pagedHistorySessions {
            guard let interval = calendar.dateInterval(of: .weekOfYear, for: session.scheduledDate) else { continue }
            if let index = weeks.firstIndex(where: { $0.weekStart == interval.start }) {
                weeks[index] = HistoryWeek(
                    weekStart: interval.start,
                    weekNumber: weeks[index].weekNumber,
                    sessions: weeks[index].sessions + [session]
                )
            } else {
                weeks.append(HistoryWeek(
                    weekStart: interval.start,
                    weekNumber: calendar.component(.weekOfYear, from: session.scheduledDate),
                    sessions: [session]
                ))
            }
        }
        return weeks
    }

    /// Confirmed running volume in the week — the number behind each header.
    private func weekVolumeText(for week: HistoryWeek) -> String? {
        let calendar = Calendar.current
        guard let interval = calendar.dateInterval(of: .weekOfYear, for: week.weekStart) else { return nil }
        let confirmed = confirmedGarminRunLogs(from: runLogs)
            .filter { interval.start <= $0.completedAt && $0.completedAt < interval.end }
        let km = confirmed.reduce(0) { $0 + $1.distanceKm }
        guard km > 0 else { return nil }
        return runDistanceText(km: km)
    }

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "Log") {
                WeekPlanTable(sessions: openSessions, prescriptions: prescriptions, onSelectSession: { selectedSession = $0 })

                VStack(alignment: .leading, spacing: 12) {
                    SectionHeader("Session history")
                    if historySessions.isEmpty {
                        Text("No history yet.")
                            .font(.subheadline)
                            .foregroundStyle(AppTheme.muted)
                    } else {
                        VStack(alignment: .leading, spacing: 18) {
                            ForEach(pagedHistoryWeeks) { week in
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack(alignment: .firstTextBaseline) {
                                        MicroLabel(text: "WEEK \(week.weekNumber)")
                                        Spacer()
                                        if let volume = weekVolumeText(for: week) {
                                            Text(volume)
                                                .font(.footnote.weight(.semibold).monospacedDigit())
                                                .foregroundStyle(AppTheme.muted)
                                        }
                                    }
                                    VStack(spacing: 0) {
                                        Hairline()
                                        ForEach(Array(week.sessions.enumerated()), id: \.element.id) { index, session in
                                            CalendarSessionRow(session: session, log: logForSession(session), runLog: runLogForSession(session))
                                            if index < week.sessions.count - 1 {
                                                Hairline()
                                            }
                                        }
                                        Hairline()
                                    }
                                }
                            }
                        }
                        if historyTotalPages > 1 {
                            HStack {
                                Button("Previous") {
                                    historyPage = max(0, historyPage - 1)
                                }
                                .disabled(historyPage == 0)
                                .foregroundStyle(historyPage == 0 ? AppTheme.faint : AppTheme.accent)

                                Spacer()
                                Text("Page \(min(historyPage + 1, historyTotalPages)) of \(historyTotalPages)")
                                    .font(.system(size: 12).monospacedDigit())
                                    .foregroundStyle(AppTheme.muted)
                                Spacer()

                                Button("Next") {
                                    historyPage = min(historyTotalPages - 1, historyPage + 1)
                                }
                                .disabled(historyPage >= historyTotalPages - 1)
                                .foregroundStyle(historyPage >= historyTotalPages - 1 ? AppTheme.faint : AppTheme.accent)
                            }
                            .font(.system(size: 13, weight: .medium))
                            .buttonStyle(.plain)
                            .padding(.top, 4)
                        }
                    }
                }
            }
            .onChange(of: historySessions.count) { _, _ in
                historyPage = min(historyPage, historyTotalPages - 1)
            }
            .sheet(item: $selectedSession) { session in
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

    private func logForSession(_ session: WorkoutSession) -> PerformanceLog? {
        logs.first { $0.sessionId == session.id }
    }

    private func runLogForSession(_ session: WorkoutSession) -> RunLog? {
        guard session.isRun else { return nil }
        return runLogs.first { $0.sessionId == session.id }
    }
}

private struct CalendarSessionRow: View {
    var session: WorkoutSession
    var log: PerformanceLog?
    var runLog: RunLog?

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(session.scheduledDate, format: .dateTime.weekday(.abbreviated))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(AppTheme.text)
                Text(session.scheduledDate, format: .dateTime.day().month())
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(AppTheme.faint)
            }
            .frame(width: 48, alignment: .leading)

            VStack(alignment: .leading, spacing: 3) {
                Text(session.title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppTheme.text)
                    .lineLimit(1)
                if session.isRun {
                    Text(runDistanceSummary)
                        .font(.system(size: 12).monospacedDigit())
                        .foregroundStyle(AppTheme.muted)
                } else if let log {
                    RPEComparisonPill(plannedRPE: plannedRPEForDisplay(log: log), actualRPE: log.rpe)
                }
            }
            Spacer(minLength: 8)
            WorkoutStatusIcon(status: session.status)
        }
        .padding(.vertical, 11)
        .accessibilityElement(children: .combine)
    }

    private var runDistanceSummary: String {
        let planned = "\(runDistanceText(km: session.plannedDistanceKm)) planned"
        guard let runLog else { return planned }
        var parts = ["\(runDistanceText(km: runLog.distanceKm)) run"]
        if runLog.averagePaceSecPerKm > 0 {
            parts.append(runPaceText(secondsPerKm: runLog.averagePaceSecPerKm))
        }
        if runLog.averageHr > 0 {
            parts.append("\(runLog.averageHr) bpm")
        }
        return ([planned] + parts).joined(separator: " \u{00B7} ")
    }

    private func plannedRPEForDisplay(log: PerformanceLog) -> Int? {
        if log.hasPlannedRPESnapshot {
            return log.plannedRPE
        }
        if (1...10).contains(session.plannedEffortTargetRPE) {
            return session.plannedEffortTargetRPE
        }
        return session.plannedEffortLabel?.defaultTargetRPE
    }
}

/// Read-only workout detail used from Log's open activities and Today's
/// this-week ledger.
struct FutureWorkoutPreviewSheet: View {
    var session: WorkoutSession
    var blocks: [WorkoutBlock]
    var prescriptions: [SetPrescription]

    @Environment(\.dismiss) private var dismiss

    private var durationMinutes: Int {
        estimatedWorkoutDurationMinutes(for: session, prescriptions: prescriptions)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    previewHeader

                    if session.isRun {
                        RunPreviewDetails(session: session)
                    } else if prescriptions.isEmpty {
                        EmptyWorkoutPreview(summary: session.summary)
                    } else {
                        VStack(alignment: .leading, spacing: 16) {
                            SectionHeader("Workout preview")
                            ForEach(blocks) { block in
                                let blockPrescriptions = prescriptionsForBlock(block)
                                if !blockPrescriptions.isEmpty {
                                    WorkoutPreviewBlock(block: block, prescriptions: blockPrescriptions)
                                }
                            }
                            let ungroupedPrescriptions = prescriptionsWithoutBlock
                            if !ungroupedPrescriptions.isEmpty {
                                WorkoutPreviewBlock(
                                    title: "Work",
                                    detail: "Prescriptions for this session.",
                                    prescriptions: ungroupedPrescriptions
                                )
                            }
                        }
                    }
                }
                .padding(AppTheme.screenMargin)
            }
            .background(AppTheme.background)
            .navigationTitle("Workout details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }

    private var previewHeader: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.title)
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(AppTheme.text)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(session.scheduledDate.formatted(date: .complete, time: .omitted))
                        .font(.subheadline)
                        .foregroundStyle(AppTheme.muted)
                }

                Spacer(minLength: 8)

                WorkoutStatusPill(status: session.status)
            }

            HStack(spacing: 14) {
                Label(focusPillText, systemImage: focusIconName)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(AppTheme.muted)
                DurationPill(minutes: durationMinutes)
                if let effortLabel = session.plannedEffortLabel {
                    EffortPill(
                        label: effortLabel,
                        prefix: "Plan",
                        targetRPE: session.plannedEffortTargetRPE > 0 ? session.plannedEffortTargetRPE : nil
                    )
                }
            }

            if !session.summary.isEmpty {
                Text(session.summary)
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text(availabilityText)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(AppTheme.accent)
        }
        .ruled(verticalPadding: 16)
    }

    private var availabilityText: String {
        Calendar.current.isDateInToday(session.scheduledDate)
            ? "Log this from Today when you are ready."
            : "Available to log on the scheduled day."
    }

    private var focusPillText: String {
        session.isRun ? (session.runKind?.title ?? "Run") : session.focus.title
    }

    private var focusIconName: String {
        if session.isRun {
            return "figure.run"
        }
        switch session.focus {
        case .pull: return "arrow.down.circle"
        case .push: return "arrow.up.circle"
        case .core: return "circle.hexagongrid.circle"
        case .mixed: return "square.grid.2x2"
        case .recovery: return "leaf"
        }
    }

    private var prescriptionsWithoutBlock: [SetPrescription] {
        let blockIds = Set(blocks.map(\.id))
        return prescriptions.filter { !blockIds.contains($0.blockId) }
    }

    private func prescriptionsForBlock(_ block: WorkoutBlock) -> [SetPrescription] {
        prescriptions
            .filter { $0.blockId == block.id }
            .sorted { $0.orderIndex < $1.orderIndex }
    }
}

private struct RunPreviewDetails: View {
    var session: WorkoutSession

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader("Run preview")
            VStack(spacing: 10) {
                InfoLine(title: "Distance", value: runDistanceText(km: session.plannedDistanceKm))
                if session.plannedElevationM > 0 {
                    InfoLine(title: "Elevation gain", value: "\(session.plannedElevationM) m+")
                }
                InfoLine(title: "Target", value: runTargetText(session: session))
            }
        }
        .ruled(verticalPadding: 16)
    }
}

private struct EmptyWorkoutPreview: View {
    var summary: String

    var body: some View {
        EmptyStateView(
            systemImage: "list.bullet.rectangle",
            title: "No exercise details yet",
            message: summary.isEmpty ? "This planned session does not have saved exercise prescriptions." : summary
        )
    }
}

private struct WorkoutPreviewBlock: View {
    var block: WorkoutBlock?
    var title: String
    var detail: String
    var prescriptions: [SetPrescription]

    init(block: WorkoutBlock, prescriptions: [SetPrescription]) {
        self.block = block
        self.title = block.name
        self.detail = block.detail
        self.prescriptions = prescriptions
    }

    init(title: String, detail: String, prescriptions: [SetPrescription]) {
        self.block = nil
        self.title = title
        self.detail = detail
        self.prescriptions = prescriptions
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                // Block names render verbatim ("Warm-up") — tests assert them.
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.text)
                if !detail.isEmpty {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(AppTheme.faint)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            VStack(spacing: 0) {
                Hairline()
                ForEach(Array(prescriptions.enumerated()), id: \.element.id) { index, item in
                    WorkoutPreviewPrescriptionRow(item: item, block: block)
                    if index < prescriptions.count - 1 {
                        Hairline()
                    }
                }
                Hairline()
            }
        }
    }
}

private struct WorkoutPreviewPrescriptionRow: View {
    var item: SetPrescription
    var block: WorkoutBlock?

    var body: some View {
        WorkoutInfoPopover(prescription: item, block: block, onDone: {}) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.exercise.title)
                        .font(.subheadline.weight(.medium))
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

                VStack(alignment: .trailing, spacing: 3) {
                    Text(prescriptionText(item))
                        .font(.system(size: 15, weight: .semibold).monospacedDigit())
                        .foregroundStyle(AppTheme.text)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                    Text("\(durationText(seconds: item.restSeconds)) rest")
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundStyle(AppTheme.faint)
                        .lineLimit(1)
                }

                Image(systemName: "info.circle")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(AppTheme.faint)
            }
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
    }
}
