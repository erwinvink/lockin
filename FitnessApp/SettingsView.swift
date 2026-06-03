import SwiftData
import SwiftUI

struct SettingsView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @State private var notificationStatus = "Not requested"
    @State private var isShowingResetConfirmation = false
    @State private var resetError: String?

    var profile: UserProfile

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "Profile") {
                ProfileSummaryCard(profile: profile)
                ReminderSettingsCard(
                    profile: profile,
                    sessions: sessions,
                    notificationStatus: notificationStatus,
                    onReminderToggle: saveReminderPreference,
                    onStatusChange: { notificationStatus = $0 }
                )
                ResetCard(
                    resetError: resetError,
                    onResetTap: { isShowingResetConfirmation = true }
                )
            }
            .alert("Wipe all app data?", isPresented: $isShowingResetConfirmation) {
                Button("Cancel", role: .cancel) {}
                Button("Wipe everything", role: .destructive, action: resetAllData)
            } message: {
                Text("This removes every measurement, workout, log, consistency, and coach record from the app.")
            }
        }
    }

    private func saveReminderPreference(_ enabled: Bool) {
        profile.remindersEnabled = enabled
        try? modelContext.save()
    }

    private func resetAllData() {
        do {
            WorkoutNotificationScheduler().clearWorkoutReminders()
            try wipeAllData(in: modelContext)
            try modelContext.save()
        } catch {
            resetError = error.localizedDescription
        }
    }
}

private struct ProfileSummaryCard: View {
    var profile: UserProfile

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(profile.name)
                        .font(.system(.title2, design: .rounded, weight: .bold))
                    Text("Target: \(profile.targetDate, format: .dateTime.day().month().year())")
                        .font(.caption)
                        .foregroundStyle(AppTheme.muted)
                }
                Spacer()
                Image(systemName: "person.crop.circle.fill")
                    .font(.system(size: 42))
                    .foregroundStyle(AppTheme.accent)
            }
            Divider()
            InfoLine(title: "Goals", value: "\(profile.goalPullUps) pull-ups, \(profile.goalPushUps) push-ups, \(format(seconds: profile.goalPlankSeconds)) plank")
            InfoLine(title: "Training days", value: profile.trainingDayLabels.joined(separator: ", "))
            InfoLine(title: "iCloud container", value: ModelContainerFactory.cloudKitContainerIdentifier)
        }
        .card()
    }
}

private struct ReminderSettingsCard: View {
    var profile: UserProfile
    var sessions: [WorkoutSession]
    var notificationStatus: String
    var onReminderToggle: (Bool) -> Void
    var onStatusChange: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Toggle("Strict reminders", isOn: Binding(
                get: { profile.remindersEnabled },
                set: { newValue in
                    onReminderToggle(newValue)
                }
            ))
            .tint(AppTheme.accent)

            Button("Request and schedule", action: scheduleReminders)
                .buttonStyle(SecondaryActionButtonStyle())

            InfoLine(title: "Status", value: notificationStatus)
        }
        .card()
    }

    private func scheduleReminders() {
        Task {
            let scheduler = WorkoutNotificationScheduler()
            let allowed = await scheduler.requestAuthorization()
            if allowed {
                await scheduler.scheduleWorkoutReminders(for: sessions)
                onStatusChange("Scheduled")
            } else {
                onStatusChange("Denied")
            }
        }
    }
}

private struct ResetCard: View {
    var resetError: String?
    var onResetTap: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Reset")
                .font(.headline)
            Text("Deletes profile, measurements, goals, sessions, logs, consistency, coach plans, coach decisions, and pending workout reminders.")
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
            Button(role: .destructive, action: onResetTap) {
                Label("Wipe all app data", systemImage: "trash")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(SecondaryActionButtonStyle())
            if let resetError {
                Text(resetError)
                    .font(.caption)
                    .foregroundStyle(AppTheme.warning)
            }
        }
        .card()
    }
}
