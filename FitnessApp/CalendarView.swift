import SwiftData
import SwiftUI

struct CalendarView: View {
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @State private var historyPage = 0

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

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "Log") {
                WeekPlanTable(sessions: openSessions)

                VStack(alignment: .leading, spacing: 12) {
                    Text("Session history")
                        .font(.headline)
                    if historySessions.isEmpty {
                        Text("No history yet.")
                            .font(.subheadline)
                            .foregroundStyle(AppTheme.muted)
                    } else {
                        ForEach(pagedHistorySessions) { session in
                            CalendarSessionRow(session: session)
                        }
                        if historyTotalPages > 1 {
                            HStack {
                                Button("Previous") {
                                    historyPage = max(0, historyPage - 1)
                                }
                                .disabled(historyPage == 0)

                                Spacer()
                                Text("Page \(min(historyPage + 1, historyTotalPages)) of \(historyTotalPages)")
                                    .font(.caption)
                                    .foregroundStyle(AppTheme.muted)
                                Spacer()

                                Button("Next") {
                                    historyPage = min(historyTotalPages - 1, historyPage + 1)
                                }
                                .disabled(historyPage >= historyTotalPages - 1)
                            }
                            .font(.caption.weight(.semibold))
                        }
                    }
                }
                .card()
            }
            .onChange(of: historySessions.count) { _, _ in
                historyPage = min(historyPage, historyTotalPages - 1)
            }
        }
    }
}

private struct CalendarSessionRow: View {
    var session: WorkoutSession

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(session.scheduledDate, format: .dateTime.weekday(.abbreviated))
                    .font(.caption.weight(.bold))
                    .foregroundStyle(AppTheme.accent)
                Text(session.scheduledDate, format: .dateTime.day().month())
                    .font(.caption2)
                    .foregroundStyle(AppTheme.muted)
            }
            .frame(width: 48, alignment: .leading)

            VStack(alignment: .leading, spacing: 3) {
                Text(session.title)
                    .font(.subheadline.weight(.semibold))
            }
            Spacer()
            WorkoutStatusIcon(status: session.status)
        }
        .padding(.vertical, 8)
    }
}
