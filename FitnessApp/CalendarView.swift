import SwiftData
import SwiftUI

struct CalendarView: View {
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query private var runningWorkouts: [RunningWorkout]

    private var historySessions: [WorkoutSession] {
        sessions.filter { $0.status != .planned }
    }

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "Log") {
                WeekPlanTable(sessions: sessions)

                VStack(alignment: .leading, spacing: 12) {
                    Text("Session history")
                        .font(.headline)
                    if historySessions.isEmpty {
                        Text("No history yet.")
                            .font(.subheadline)
                            .foregroundStyle(AppTheme.muted)
                    } else {
                        ForEach(historySessions) { session in
                            CalendarSessionRow(session: session, workout: runningWorkout(for: session))
                        }
                    }
                }
                .card()
            }
        }
    }

    private func runningWorkout(for session: WorkoutSession) -> RunningWorkout? {
        runningWorkouts.first { $0.sessionId == session.id }
    }
}

private struct CalendarSessionRow: View {
    var session: WorkoutSession
    var workout: RunningWorkout?

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
                if let workout {
                    Text("\(distanceText(km: workout.targetDistanceKm)) · \(minutesText(workout.targetDurationMinutes)) · \(workout.runType.title)")
                        .font(.caption2)
                        .foregroundStyle(AppTheme.muted)
                } else {
                    Text(session.domain.title)
                        .font(.caption2)
                        .foregroundStyle(AppTheme.muted)
                }
            }
            Spacer()
            WorkoutStatusIcon(status: session.status)
        }
        .padding(.vertical, 8)
    }
}
