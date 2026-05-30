import Foundation
import UserNotifications

protocol NotificationScheduling {
    func requestAuthorization() async -> Bool
    func scheduleWorkoutReminders(for sessions: [WorkoutSession], minutesAfterMidnight: Int) async
    func clearWorkoutReminders()
}

struct WorkoutNotificationScheduler: NotificationScheduling {
    private let center = UNUserNotificationCenter.current()

    func requestAuthorization() async -> Bool {
        do {
            return try await center.requestAuthorization(options: [.alert, .badge, .sound])
        } catch {
            return false
        }
    }

    func scheduleWorkoutReminders(for sessions: [WorkoutSession], minutesAfterMidnight: Int) async {
        clearWorkoutReminders()
        guard minutesAfterMidnight >= 0 else { return }
        let hour = minutesAfterMidnight / 60
        let minute = minutesAfterMidnight % 60

        for session in sessions where session.status == .planned {
            let content = UNMutableNotificationContent()
            content.title = "Training due"
            content.body = session.title
            content.sound = .default

            var components = Calendar.current.dateComponents([.year, .month, .day], from: session.scheduledDate)
            components.hour = hour
            components.minute = minute
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            let request = UNNotificationRequest(identifier: "workout-\(session.id.uuidString)", content: content, trigger: trigger)
            try? await center.add(request)
        }
    }

    func clearWorkoutReminders() {
        center.removePendingNotificationRequests(withIdentifiers: [])
        center.removeAllPendingNotificationRequests()
    }
}
