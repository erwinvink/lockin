import SwiftData
import SwiftUI

struct CalendarView: View {
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \RunningWorkout.scheduledDate) private var runningWorkouts: [RunningWorkout]
    @Query(sort: \RunningLog.completedAt, order: .reverse) private var runningLogs: [RunningLog]
    @State private var visibleMonth = Calendar.current.startOfDay(for: Date())
    @State private var historyPage = 0

    private let historyPageSize = 25

    var body: some View {
        NavigationStack {
            ScreenBackground(
                title: "Log",
                trailing: AnyView(Button { visibleMonth = Date() } label: {
                    Image(systemName: "calendar")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(AppTheme.textPrimary)
                        .frame(width: 44, height: 44)
                }.buttonStyle(.plain))
            ) {
                monthCard
                openActivitiesCard
                historyCard
            }
            .onChange(of: historyItems.count) { _, _ in
                clampHistoryPage()
            }
        }
    }

    private var monthCard: some View {
        LockinCard {
            VStack(spacing: 16) {
                HStack {
                    Button { shiftMonth(-1) } label: {
                        Image(systemName: "chevron.left")
                            .frame(width: 36, height: 36)
                    }
                    .buttonStyle(.plain)
                    Spacer()
                    Text(monthTitle)
                        .font(.system(size: 15, weight: .semibold))
                    Spacer()
                    Button { shiftMonth(1) } label: {
                        Image(systemName: "chevron.right")
                            .frame(width: 36, height: 36)
                    }
                    .buttonStyle(.plain)
                }

                HStack {
                    ForEach(Array(["M", "T", "W", "T", "F", "S", "S"].enumerated()), id: \.offset) { _, day in
                        Text(day)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(AppTheme.textSecondary)
                            .frame(maxWidth: .infinity)
                    }
                }

                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 7), spacing: 10) {
                    ForEach(monthCells, id: \.id) { cell in
                        if let day = cell.day {
                            CalendarDayMarker(day: day, status: status(for: cell.date))
                        } else {
                            Color.clear.frame(width: 30, height: 30)
                        }
                    }
                }
            }
        }
    }

    private var openActivitiesCard: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 14) {
                SectionLabel(text: "Open Activities")
                if openActivities.isEmpty {
                    Text("No open activities.")
                        .font(.system(size: 14))
                        .foregroundStyle(AppTheme.textSecondary)
                } else {
                    ForEach(openActivities) { activity in
                        activityRow(activity, isHistory: false)
                    }
                }
            }
        }
    }

    private var historyCard: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    SectionLabel(text: "Session History")
                    Spacer()
                    if !historyItems.isEmpty {
                        Text("\(historyItems.count) items")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(AppTheme.textSecondary)
                    }
                }

                if groupedHistoryDays.isEmpty {
                    Text("No history yet.")
                        .font(.system(size: 14))
                        .foregroundStyle(AppTheme.textSecondary)
                } else {
                    ForEach(groupedHistoryDays, id: \.date) { group in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(group.date.formatted(date: .complete, time: .omitted).uppercased())
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(AppTheme.textSecondary)
                            ForEach(group.items) { activity in
                                activityRow(activity, isHistory: true)
                            }
                        }
                        Divider()
                    }

                    if historyTotalPages > 1 {
                        historyPagingControls
                    }
                }
            }
        }
    }

    private var monthTitle: String {
        visibleMonth.formatted(.dateTime.month(.wide).year())
    }

    private var monthCells: [MonthCell] {
        let calendar = Calendar.current
        let start = calendar.dateInterval(of: .month, for: visibleMonth)?.start ?? visibleMonth
        let days = calendar.range(of: .day, in: .month, for: start) ?? 1..<1
        let weekday = calendar.component(.weekday, from: start)
        let mondayOffset = (weekday + 5) % 7
        var cells = (0..<mondayOffset).map { MonthCell(id: "blank-\($0)", date: start, day: nil) }
        cells += days.compactMap { day -> MonthCell? in
            guard let date = calendar.date(byAdding: .day, value: day - 1, to: start) else { return nil }
            return MonthCell(id: date.formatted(.iso8601.year().month().day()), date: date, day: day)
        }
        return cells
    }

    private var openActivities: [CalendarActivity] {
        (sessions
            .filter { $0.status == .planned }
            .map(CalendarActivity.strength) +
            runningWorkouts
            .filter { $0.status == .planned }
            .map(CalendarActivity.run))
            .sorted { lhs, rhs in
                if lhs.scheduledDate == rhs.scheduledDate {
                    return lhs.title < rhs.title
                }
                return lhs.scheduledDate < rhs.scheduledDate
            }
    }

    private var historyItems: [CalendarActivity] {
        (sessions
            .filter { $0.status != .planned }
            .map(CalendarActivity.strength) +
            runningWorkouts
            .filter { $0.status != .planned }
            .map(CalendarActivity.run))
            .sorted { lhs, rhs in
                if lhs.scheduledDate == rhs.scheduledDate {
                    return lhs.title < rhs.title
                }
                return lhs.scheduledDate > rhs.scheduledDate
            }
    }

    private var historyTotalPages: Int {
        max(1, (historyItems.count + historyPageSize - 1) / historyPageSize)
    }

    private var currentHistoryPage: Int {
        min(historyPage, historyTotalPages - 1)
    }

    private var pagedHistoryItems: [CalendarActivity] {
        let start = currentHistoryPage * historyPageSize
        return Array(historyItems.dropFirst(start).prefix(historyPageSize))
    }

    private var groupedHistoryDays: [HistoryGroup] {
        let calendar = Calendar.current
        var groups: [HistoryGroup] = []
        for item in pagedHistoryItems {
            let date = calendar.startOfDay(for: item.scheduledDate)
            if let lastIndex = groups.indices.last, calendar.isDate(groups[lastIndex].date, inSameDayAs: date) {
                groups[lastIndex].items.append(item)
            } else {
                groups.append(HistoryGroup(date: date, items: [item]))
            }
        }
        return groups
    }

    private func status(for date: Date) -> ConsistencyDayStatus? {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return .today }
        if sessions.contains(where: { calendar.isDate($0.scheduledDate, inSameDayAs: date) && $0.status == .completed }) ||
            runningWorkouts.contains(where: { calendar.isDate($0.scheduledDate, inSameDayAs: date) && $0.status == .completed }) {
            return .completed
        }
        if sessions.contains(where: { calendar.isDate($0.scheduledDate, inSameDayAs: date) && $0.status == .missed }) ||
            runningWorkouts.contains(where: { calendar.isDate($0.scheduledDate, inSameDayAs: date) && $0.status == .missed }) {
            return .missed
        }
        if sessions.contains(where: { calendar.isDate($0.scheduledDate, inSameDayAs: date) && $0.status == .planned }) ||
            runningWorkouts.contains(where: { calendar.isDate($0.scheduledDate, inSameDayAs: date) && $0.status == .planned }) {
            return .planned
        }
        if sessions.contains(where: { calendar.isDate($0.scheduledDate, inSameDayAs: date) && $0.status == .deload }) {
            return .rest
        }
        return nil
    }

    private func shiftMonth(_ value: Int) {
        visibleMonth = Calendar.current.date(byAdding: .month, value: value, to: visibleMonth) ?? visibleMonth
    }

    private func strengthIcon(for focus: SessionFocus) -> String {
        switch focus {
        case .pull: "figure.strengthtraining.traditional"
        case .push: "figure.core.training"
        case .core: "figure.core.training"
        case .mixed: "figure.cross.training"
        case .recovery: "leaf"
        }
    }

    private func color(for status: SessionStatus) -> Color {
        switch status {
        case .planned: AppTheme.textSecondary
        case .completed: AppTheme.success
        case .missed: AppTheme.danger
        case .deload: AppTheme.olive
        }
    }

    private var historyPagingControls: some View {
        HStack {
            Button {
                historyPage = max(0, currentHistoryPage - 1)
            } label: {
                Image(systemName: "chevron.left")
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)
            .disabled(currentHistoryPage == 0)
            .opacity(currentHistoryPage == 0 ? 0.35 : 1)

            Spacer()

            Text("Page \(currentHistoryPage + 1) of \(historyTotalPages)")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(AppTheme.textSecondary)

            Spacer()

            Button {
                historyPage = min(historyTotalPages - 1, currentHistoryPage + 1)
            } label: {
                Image(systemName: "chevron.right")
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)
            .disabled(currentHistoryPage >= historyTotalPages - 1)
            .opacity(currentHistoryPage >= historyTotalPages - 1 ? 0.35 : 1)
        }
        .padding(.top, 2)
    }

    @ViewBuilder
    private func activityRow(_ activity: CalendarActivity, isHistory: Bool) -> some View {
        switch activity {
        case .strength(let session):
            WorkoutRowCard(
                title: session.title,
                subtitle: session.focus.title,
                status: isHistory ? session.status.rawValue.capitalized : session.scheduledDate.formatted(date: .abbreviated, time: .omitted),
                systemImage: strengthIcon(for: session.focus),
                tint: color(for: session.status),
                trailingSystemImage: isHistory && session.status == .completed ? "checkmark" : nil
            )
        case .run(let run):
            NavigationLink {
                RunDetailView(workout: run, log: runningLogs.first(where: { $0.workoutId == run.id }))
            } label: {
                WorkoutRowCard(
                    title: run.title,
                    subtitle: "\(format(kilometers: run.distanceKm)) km - \(run.zone)",
                    status: isHistory ? run.status.rawValue.capitalized : run.scheduledDate.formatted(date: .abbreviated, time: .omitted),
                    systemImage: "figure.run",
                    tint: AppTheme.blueRunning,
                    trailingSystemImage: "chevron.right"
                )
            }
            .buttonStyle(.plain)
        }
    }

    private func clampHistoryPage() {
        historyPage = min(historyPage, historyTotalPages - 1)
    }
}

private struct MonthCell {
    var id: String
    var date: Date
    var day: Int?
}

private struct HistoryGroup {
    var date: Date
    var items: [CalendarActivity]
}

private enum CalendarActivity: Identifiable {
    case strength(WorkoutSession)
    case run(RunningWorkout)

    var id: String {
        switch self {
        case .strength(let session): "strength-\(session.id.uuidString)"
        case .run(let run): "run-\(run.id.uuidString)"
        }
    }

    var scheduledDate: Date {
        switch self {
        case .strength(let session): session.scheduledDate
        case .run(let run): run.scheduledDate
        }
    }

    var title: String {
        switch self {
        case .strength(let session): session.title
        case .run(let run): run.title
        }
    }
}
