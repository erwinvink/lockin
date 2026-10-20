import Foundation
import SwiftData
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
        for reminder in workoutReminderRequests(for: sessions, at: reminderTime) {
            let content = UNMutableNotificationContent()
            content.title = reminder.title
            content.body = reminder.body
            content.sound = .default

            let components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: reminder.fireDate)
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            let request = UNNotificationRequest(identifier: reminder.identifier, content: content, trigger: trigger)
            try? await center.add(request)
        }
    }

    func clearWorkoutReminders() {
        center.removeAllPendingNotificationRequests()
    }
}

struct WorkoutReminderRequest: Equatable {
    var identifier: String
    var fireDate: Date
    var title: String
    var body: String
}

/// One reminder per training day for the sessions still planned, so a done
/// session never nags and a double day gets one notification.
func workoutReminderRequests(
    for sessions: [WorkoutSession],
    at reminderTime: Date,
    now: Date = Date(),
    calendar: Calendar = .current
) -> [WorkoutReminderRequest] {
    let planned = sessions.filter { $0.status == .planned }
    let byDay = Dictionary(grouping: planned) { calendar.startOfDay(for: $0.scheduledDate) }
    return byDay.keys.sorted().compactMap { day in
        guard let fireDate = workoutReminderDate(for: day, at: reminderTime, now: now, calendar: calendar) else { return nil }
        let daySessions = (byDay[day] ?? []).sorted { lhs, rhs in
            if lhs.isRun != rhs.isRun { return lhs.isRun }
            return lhs.scheduledDate < rhs.scheduledDate
        }
        let details = daySessions.map(reminderDetail(for:)).filter { !$0.isEmpty }.joined(separator: " · ")
        return WorkoutReminderRequest(
            identifier: "workout-day-\(Int(day.timeIntervalSince1970))",
            fireDate: fireDate,
            title: daySessions.map(\.title).joined(separator: " + ") + " today",
            body: details.isEmpty ? "Skip it and the score pays." : "\(details) — skip it and the score pays."
        )
    }
}

/// The reminder names the actual work — "12 km · ~75 min" beats a generic
/// nag.
private func reminderDetail(for session: WorkoutSession) -> String {
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
    return parts.joined(separator: " · ")
}

/// Rebuilds pending reminders from the store after anything that changes
/// which sessions are still planned (a log, a Garmin completion, a replan).
@MainActor
func refreshWorkoutReminders(in modelContext: ModelContext) async {
    guard let profile = try? modelContext.fetch(FetchDescriptor<UserProfile>(sortBy: [SortDescriptor(\.createdAt)])).first,
          profile.remindersEnabled,
          let sessions = try? modelContext.fetch(FetchDescriptor<WorkoutSession>(sortBy: [SortDescriptor(\.scheduledDate)]))
    else { return }
    await WorkoutNotificationScheduler().scheduleWorkoutReminders(for: sessions, at: profile.reminderTime)
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
