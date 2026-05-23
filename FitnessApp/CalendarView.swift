import SwiftData
import SwiftUI

struct CalendarView: View {
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "Log") {
                WeekPlanTable(sessions: sessions)

                VStack(alignment: .leading, spacing: 12) {
                    Text("Session history")
                        .font(.headline)
                    if sessions.isEmpty {
                        Text("No sessions yet.")
                            .font(.subheadline)
                            .foregroundStyle(AppTheme.muted)
                    } else {
                        ForEach(sessions) { session in
                            CalendarSessionRow(session: session)
                        }
                    }
                }
                .card()
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
                Text(session.summary)
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
                    .lineLimit(1)
            }
            Spacer()
            WorkoutStatusPill(status: session.status)
        }
        .padding(.vertical, 8)
    }
}
