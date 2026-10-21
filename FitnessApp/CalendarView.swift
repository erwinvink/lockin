import SwiftData
import SwiftUI

struct CalendarView: View {
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \WorkoutBlock.orderIndex) private var blocks: [WorkoutBlock]
    @Query(sort: \SetPrescription.orderIndex) private var prescriptions: [SetPrescription]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query(sort: \RunLog.completedAt, order: .reverse) private var runLogs: [RunLog]
    @Query(sort: \UserProfile.createdAt) private var profiles: [UserProfile]
    @State private var historyPage = 0
    @State private var selectedSession: WorkoutSession?
    @State private var ratingLog: RunLog?

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
        let confirmed = confirmedRunLogs(from: runLogs)
            .filter { interval.start <= $0.completedAt && $0.completedAt < interval.end }
        let km = confirmed.reduce(0) { $0 + $1.distanceKm }
        guard km > 0 else { return nil }
        return runDistanceText(km: km)
    }

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "Log") {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader("Coming up")
                    if openSessions.isEmpty {
                        Text("Nothing planned yet. Your coach plans the week from Coach.")
                            .font(.lockinBody)
                            .foregroundStyle(AppTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(Array(openSessions.prefix(7).enumerated()), id: \.element.id) { index, session in
                                if index > 0 {
                                    Hairline()
                                }
                                ComingUpRow(
                                    session: session,
                                    durationMinutes: durationMinutes(for: session),
                                    onSelect: { selectedSession = session }
                                )
                            }
                        }
                        .padding(.leading, 14)
                        .card(padding: 0)
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader("History")
                    if historySessions.isEmpty {
                        Text("No history yet.")
                            .font(.lockinBody)
                            .foregroundStyle(AppTheme.muted)
                    } else {
                        VStack(alignment: .leading, spacing: 18) {
                            ForEach(pagedHistoryWeeks) { week in
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack(alignment: .firstTextBaseline) {
                                        Text("Week \(week.weekNumber)")
                                            .font(.trail(14, .semibold, relativeTo: .subheadline))
                                            .foregroundStyle(AppTheme.muted)
                                        Spacer()
                                        if let volume = weekVolumeText(for: week) {
                                            Text("\(volume) run")
                                                .font(.lockinMeta.monospacedDigit())
                                                .foregroundStyle(AppTheme.muted)
                                        }
                                    }
                                    .padding(.horizontal, 2)

                                    VStack(spacing: 0) {
                                        ForEach(Array(week.sessions.enumerated()), id: \.element.id) { index, session in
                                            if index > 0 {
                                                Hairline()
                                            }
                                            HistoryRow(
                                                session: session,
                                                log: logForSession(session),
                                                runLog: runLogForSession(session),
                                                onRate: rateAction(for: runLogForSession(session))
                                            )
                                        }
                                    }
                                    .padding(.leading, 14)
                                    .card(padding: 0)
                                }
                            }
                        }
                        if historyTotalPages > 1 {
                            HistoryPager(
                                page: min(historyPage + 1, historyTotalPages),
                                totalPages: historyTotalPages,
                                onPrevious: { historyPage = max(0, historyPage - 1) },
                                onNext: { historyPage = min(historyTotalPages - 1, historyPage + 1) }
                            )
                        }
                    }
                }
            }
            .onChange(of: historySessions.count) { _, _ in
                historyPage = min(historyPage, historyTotalPages - 1)
            }
            .sheet(item: $ratingLog) { log in
                if let profile = profiles.first {
                    LogRunView(mode: .rate(log, sessions.first { $0.id == log.sessionId }), profile: profile)
                }
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

    private func durationMinutes(for session: WorkoutSession) -> Int {
        session.isRun
            ? session.estimatedDurationMinutes
            : estimatedWorkoutDurationMinutes(for: session, prescriptions: prescriptionsForSession(session))
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

    private func rateAction(for runLog: RunLog?) -> (() -> Void)? {
        guard let runLog, runLog.rpe == 0, profiles.first != nil else { return nil }
        return { ratingLog = runLog }
    }

    private func runLogForSession(_ session: WorkoutSession) -> RunLog? {
        guard session.isRun else { return nil }
        return runLogs.first { $0.sessionId == session.id }
    }
}

// MARK: - Rows

/// "Thu" over "11 Jun": the date column every Log row starts with.
private struct DayColumn: View {
    var date: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(date, format: .dateTime.weekday(.abbreviated))
                .font(.trail(15, .bold, relativeTo: .subheadline))
                .foregroundStyle(AppTheme.text)
            Text(date, format: .dateTime.day().month(.abbreviated))
                .font(.trail(12, .regular, relativeTo: .caption1).monospacedDigit())
                .foregroundStyle(AppTheme.muted)
        }
        .frame(width: 46, alignment: .leading)
    }
}

/// An open session: when, what, how long and how hard. Opens the preview.
private struct ComingUpRow: View {
    var session: WorkoutSession
    var durationMinutes: Int
    var onSelect: () -> Void

    private var isToday: Bool {
        Calendar.current.isDateInToday(session.scheduledDate)
    }

    private var metaText: String {
        var parts: [String] = []
        if session.isRun, session.plannedDistanceKm > 0 {
            parts.append(runDistanceText(km: session.plannedDistanceKm))
        }
        if durationMinutes > 0 {
            parts.append(signDurationText(minutes: durationMinutes))
        }
        if let effort = session.plannedEffortLabel {
            let rpe = session.plannedEffortTargetRPE
            parts.append(rpe > 0 ? "\(effort.title.lowercased()), RPE \(rpe)" : effort.title.lowercased())
        }
        return parts.joined(separator: ", ")
    }

    var body: some View {
        Button(action: onSelect) {
            HStack(alignment: .center, spacing: 12) {
                DayColumn(date: session.scheduledDate)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text(session.title)
                            .font(.lockinRowTitle)
                            .foregroundStyle(AppTheme.text)
                            .lineLimit(1)
                        if isToday {
                            Text("Today")
                                .font(.trail(12, .semibold, relativeTo: .caption1))
                                .foregroundStyle(AppTheme.text)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 2)
                                .background(RoundedRectangle(cornerRadius: 4).fill(AppTheme.sign))
                        }
                    }
                    if !metaText.isEmpty {
                        HStack(spacing: 7) {
                            if let effort = session.plannedEffortLabel {
                                TrailMark(grade: TrailGrade(effort), width: 18, height: 12)
                            }
                            Text(metaText)
                                .font(.lockinMeta.monospacedDigit())
                                .foregroundStyle(AppTheme.muted)
                                .lineLimit(1)
                                .minimumScaleFactor(0.85)
                        }
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(AppTheme.post)
            }
            .padding(.vertical, 10)
            .padding(.trailing, 14)
            .frame(minHeight: 64)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Open workout details")
        .accessibilityIdentifier("week-plan-row-\(session.title)")
    }
}

/// A past session: how it went against the plan, and its outcome.
private struct HistoryRow: View {
    var session: WorkoutSession
    var log: PerformanceLog?
    var runLog: RunLog?
    /// Set for a run that has no RPE or feel yet (Garmin completed it).
    var onRate: (() -> Void)?

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            DayColumn(date: session.scheduledDate)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title)
                    .font(.lockinRowTitle)
                    .foregroundStyle(AppTheme.text)
                    .lineLimit(1)
                detail
                    .font(.lockinMeta.monospacedDigit())
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            if let onRate {
                Button(action: onRate) {
                    Text("Rate")
                        .font(.trail(14, .semibold, relativeTo: .subheadline))
                        .foregroundStyle(AppTheme.text)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 36)
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .strokeBorder(AppTheme.text, lineWidth: 2)
                        )
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Rate \(session.title)")
            }
            if session.status == .deload {
                Text("Deload")
                    .font(.trail(12, .semibold, relativeTo: .caption1))
                    .foregroundStyle(AppTheme.bodyText)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(AppTheme.post, lineWidth: 1))
            } else {
                WorkoutStatusIcon(status: session.status)
            }
        }
        .padding(.vertical, 10)
        .padding(.trailing, 14)
        .frame(minHeight: 62)
        .accessibilityElement(children: onRate == nil ? .combine : .contain)
    }

    @ViewBuilder
    private var detail: some View {
        if session.status == .missed {
            Text("Missed")
                .fontWeight(.semibold)
                .foregroundStyle(AppTheme.markerRedText)
        } else if session.isRun {
            Text(runDetail)
                .foregroundStyle(AppTheme.muted)
        } else if let log {
            rpeDetail(log)
        } else if session.status == .deload {
            Text("Deloaded by the coach")
                .foregroundStyle(AppTheme.muted)
        }
    }

    private var runDetail: String {
        let planned = session.plannedDistanceKm
        guard let runLog else {
            return planned > 0 ? "\(runDistanceText(km: planned)) planned" : "Run"
        }
        var parts: [String] = []
        if planned > 0 {
            let plannedNumber = planned.formatted(.number.precision(.fractionLength(0...1)))
            parts.append("\(runLog.distanceKm.formatted(.number.precision(.fractionLength(0...1)))) of \(plannedNumber) km")
        } else {
            parts.append(runDistanceText(km: runLog.distanceKm))
        }
        if runLog.averagePaceSecPerKm > 0 {
            parts.append(runPaceText(secondsPerKm: runLog.averagePaceSecPerKm))
        }
        if runLog.averageHr > 0 {
            parts.append("\(runLog.averageHr) bpm")
        }
        return parts.joined(separator: ", ")
    }

    /// "RPE 6 planned, 8 logged. 2 harder": the plan-versus-reality read.
    private func rpeDetail(_ log: PerformanceLog) -> Text {
        let actual = min(10, max(1, log.rpe))
        guard let planned = plannedRPEForDisplay(log: log), (1...10).contains(planned) else {
            return Text("RPE \(actual) logged").foregroundStyle(AppTheme.muted)
        }
        let base = Text("RPE \(planned) planned, \(actual) logged. ").foregroundStyle(AppTheme.muted)
        let difference = actual - planned
        if difference == 0 {
            return base + Text("On plan").foregroundStyle(AppTheme.muted)
        }
        if difference > 0 {
            return base + Text("\(difference) harder").fontWeight(.semibold).foregroundStyle(AppTheme.markerRedText)
        }
        return base + Text("\(-difference) easier").fontWeight(.semibold).foregroundStyle(AppTheme.text)
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

private struct HistoryPager: View {
    var page: Int
    var totalPages: Int
    var onPrevious: () -> Void
    var onNext: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button("Previous", action: onPrevious)
                .disabled(page <= 1)
                .foregroundStyle(page <= 1 ? AppTheme.post : AppTheme.text)
                .frame(minHeight: 44)
            Spacer()
            Text("Page \(page) of \(totalPages)")
                .font(.lockinMeta.monospacedDigit())
                .foregroundStyle(AppTheme.muted)
            Spacer()
            Button("Next", action: onNext)
                .disabled(page >= totalPages)
                .foregroundStyle(page >= totalPages ? AppTheme.post : AppTheme.text)
                .frame(minHeight: 44)
        }
        .font(.trail(15, .semibold, relativeTo: .subheadline))
        .buttonStyle(.plain)
    }
}

// MARK: - Session preview

/// Read-only session detail, from Log's coming-up list and Today's week
/// trail: a sign with the day, then the planned work block by block.
struct FutureWorkoutPreviewSheet: View {
    var session: WorkoutSession
    var blocks: [WorkoutBlock]
    var prescriptions: [SetPrescription]

    @Environment(\.dismiss) private var dismiss

    private var durationMinutes: Int {
        session.isRun
            ? session.estimatedDurationMinutes
            : estimatedWorkoutDurationMinutes(for: session, prescriptions: prescriptions)
    }

    private var summaryText: String {
        var summary = session.summary
        if summary.hasPrefix("AI: ") {
            summary = String(summary.dropFirst(4))
        }
        return summary.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Signpost(
                        eyebrow: session.scheduledDate.formatted(.dateTime.weekday(.wide).day().month(.wide)),
                        title: session.title,
                        trailing: signDurationText(minutes: durationMinutes),
                        grade: session.plannedEffortLabel.map(TrailGrade.init)
                    )

                    AvailabilityNote(session: session)

                    if !summaryText.isEmpty {
                        Text(summaryText)
                            .font(.trail(17, .regular, relativeTo: .body))
                            .foregroundStyle(AppTheme.text)
                            .lineSpacing(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if session.isRun {
                        RunPreviewDetails(session: session)
                    } else if prescriptions.isEmpty {
                        EmptyWorkoutPreview()
                    } else {
                        VStack(alignment: .leading, spacing: 18) {
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
                                    detail: "",
                                    prescriptions: ungroupedPrescriptions
                                )
                            }
                        }
                    }
                }
                .padding(.horizontal, AppTheme.screenMargin)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Workout details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                    .font(.trail(17, .semibold, relativeTo: .headline))
                }
            }
        }
        .presentationBackground(AppTheme.background)
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

/// When this session can be logged, or how it ended.
private struct AvailabilityNote: View {
    var session: WorkoutSession

    private var content: (icon: String, text: String, isProblem: Bool) {
        let calendar = Calendar.current
        switch session.status {
        case .completed:
            return ("checkmark.circle", "Logged.", false)
        case .partial:
            return ("checkmark.circle", "Logged as partial.", false)
        case .deload:
            return ("arrow.down.circle", "Deloaded by the coach.", false)
        case .missed:
            return ("xmark.circle", "Missed. If you did train, log it from Today.", true)
        case .planned:
            if calendar.isDateInToday(session.scheduledDate) {
                return ("calendar", "Due today. Check it off and log it from Today.", false)
            }
            if session.scheduledDate < calendar.startOfDay(for: Date()) {
                return ("clock", "Not logged yet. Log it from Today.", false)
            }
            let weekday = session.scheduledDate.formatted(.dateTime.weekday(.wide))
            return ("lock", "Opens on \(weekday). You can check it off and log it then.", false)
        }
    }

    var body: some View {
        Label {
            Text(content.text)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: content.icon)
        }
        .font(.trail(14, .regular, relativeTo: .subheadline))
        .foregroundStyle(content.isProblem ? AppTheme.markerRedText : AppTheme.muted)
    }
}

private struct RunPreviewDetails: View {
    var session: WorkoutSession

    var body: some View {
        VStack(spacing: 0) {
            PreviewInfoRow(title: "Distance", value: runDistanceText(km: session.plannedDistanceKm))
            if session.plannedElevationM > 0 {
                Hairline()
                PreviewInfoRow(title: "Climb", value: "\(session.plannedElevationM) m")
            }
            Hairline()
            PreviewInfoRow(title: "Target", value: runTargetText(session: session))
            if session.estimatedDurationMinutes > 0 {
                Hairline()
                PreviewInfoRow(title: "Time", value: signDurationText(minutes: session.estimatedDurationMinutes))
            }
        }
        .padding(.horizontal, 16)
        .card(padding: 0)
    }
}

private struct PreviewInfoRow: View {
    var title: String
    var value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title)
                .font(.trail(16, .regular, relativeTo: .body))
                .foregroundStyle(AppTheme.muted)
            Spacer(minLength: 8)
            Text(value)
                .font(.trail(17, .semibold, relativeTo: .headline).monospacedDigit())
                .foregroundStyle(AppTheme.text)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 14)
        .accessibilityElement(children: .combine)
    }
}

private struct EmptyWorkoutPreview: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("No exercise details yet")
                .font(.trail(17, .semibold, relativeTo: .headline))
                .foregroundStyle(AppTheme.text)
            Text("This session has no saved exercises. The coach adds them when it plans the week.")
                .font(.lockinBody)
                .foregroundStyle(AppTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
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
            VStack(alignment: .leading, spacing: 2) {
                // Block names render verbatim ("Warm-up") — tests assert them.
                Text(title)
                    .font(.trail(15, .semibold, relativeTo: .subheadline))
                    .foregroundStyle(AppTheme.muted)
                if !detail.isEmpty {
                    Text(detail)
                        .font(.lockinMeta)
                        .foregroundStyle(AppTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 2)

            VStack(spacing: 0) {
                ForEach(Array(prescriptions.enumerated()), id: \.element.id) { index, item in
                    if index > 0 {
                        Hairline()
                    }
                    WorkoutPreviewPrescriptionRow(item: item, block: block)
                }
            }
            .padding(.leading, 14)
            .card(padding: 0)
        }
    }
}

private struct WorkoutPreviewPrescriptionRow: View {
    var item: SetPrescription
    var block: WorkoutBlock?

    var body: some View {
        WorkoutInfoPopover(prescription: item, block: block, onDone: {}) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.exercise.title)
                        .font(.trail(16, .semibold, relativeTo: .headline))
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

                VStack(alignment: .trailing, spacing: 2) {
                    Text(prescriptionText(item))
                        .font(.trail(17, .bold, relativeTo: .headline).monospacedDigit())
                        .foregroundStyle(AppTheme.text)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                    if item.restSeconds > 0 {
                        Text("\(durationText(seconds: item.restSeconds)) rest")
                            .font(.trail(12, .regular, relativeTo: .caption1).monospacedDigit())
                            .foregroundStyle(AppTheme.muted)
                            .lineLimit(1)
                    }
                }

                Image(systemName: "info.circle")
                    .font(.system(size: 18, weight: .regular))
                    .foregroundStyle(AppTheme.muted)
            }
            .padding(.vertical, 10)
            .padding(.trailing, 12)
            .frame(minHeight: 58)
            .contentShape(Rectangle())
        }
    }
}
