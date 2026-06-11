import Foundation
import UserNotifications

protocol NotificationScheduling {
    func requestAuthorization() async -> Bool
    func scheduleWorkoutReminders(for sessions: [WorkoutSession], at reminderTime: Date) async
    func clearWorkoutReminders()
}

struct WorkoutNotificationScheduler: NotificationScheduling {
    private let center = UNUserNotificationCenter.current()

    func requestAuthorization() async -> Bool {
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return true
        case .denied:
            return false
        case .notDetermined:
            break
        @unknown default:
            break
        }

        do {
            return try await center.requestAuthorization(options: [.alert, .badge, .sound])
        } catch {
            return false
        }
    }

    func scheduleWorkoutReminders(for sessions: [WorkoutSession], at reminderTime: Date) async {
        clearWorkoutReminders()
        let now = Date()
        for session in sessions where session.status == .planned {
            guard let reminderDate = workoutReminderDate(
                for: session.scheduledDate,
                at: reminderTime,
                now: now
            ) else { continue }

            let content = UNMutableNotificationContent()
            content.title = "\(session.title) today"
            content.body = reminderBody(for: session)
            content.sound = .default

            let components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: reminderDate)
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            let request = UNNotificationRequest(identifier: "workout-\(session.id.uuidString)", content: content, trigger: trigger)
            try? await center.add(request)
        }
    }

    func clearWorkoutReminders() {
        center.removeAllPendingNotificationRequests()
    }

    /// The reminder names the actual work — "12 km · ~75 min" beats a
    /// generic nag — and keeps the accountability line.
    private func reminderBody(for session: WorkoutSession) -> String {
        var parts: [String] = []
        if session.isRun {
            if session.plannedDistanceKm > 0 {
                parts.append(runDistanceText(km: session.plannedDistanceKm))
            }
            if session.plannedElevationM > 0 {
                parts.append("\(session.plannedElevationM) m+")
            }
        }
        if session.estimatedDurationMinutes > 0 {
            parts.append("~\(session.estimatedDurationMinutes) min")
        }
        let detail = parts.joined(separator: " · ")
        return detail.isEmpty
            ? "Skip it and the score pays."
            : "\(detail) — skip it and the score pays."
    }
}

func workoutReminderDate(
    for scheduledDate: Date,
    at reminderTime: Date,
    now: Date = Date(),
    calendar: Calendar = .current
) -> Date? {
    let timeComponents = calendar.dateComponents([.hour, .minute], from: reminderTime)
    var reminderComponents = calendar.dateComponents([.year, .month, .day], from: scheduledDate)
    reminderComponents.hour = timeComponents.hour ?? 9
    reminderComponents.minute = timeComponents.minute ?? 0
    reminderComponents.second = 0

    guard let reminderDate = calendar.date(from: reminderComponents), reminderDate > now else {
        return nil
    }
    return reminderDate
}
