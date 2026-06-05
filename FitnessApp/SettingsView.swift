import SwiftData
import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(\.openURL) private var openURL
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @State private var isShowingReminderPermissionAlert = false
    @State private var isShowingResetConfirmation = false
    @State private var resetError: String?

    var profile: UserProfile

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "Profile") {
                ProfileSummaryCard(profile: profile)
                WeekScheduleCard(
                    profile: profile,
                    onScheduleChange: saveTrainingDays
                )
                ReminderSettingsCard(
                    profile: profile,
                    onReminderToggle: saveReminderPreference,
                    onReminderTimeChange: saveReminderTime
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
                Text("This removes every measurement, workout, log, streak, and coach record from the app.")
            }
            .alert("Enable notifications", isPresented: $isShowingReminderPermissionAlert) {
                Button("Enable", action: openNotificationSettings)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Turn on notifications for Lockin in iOS Settings to use reminders.")
            }
            .onAppear(perform: refreshEnabledReminders)
        }
    }

    private func saveTrainingDays(_ days: Set<TrainingWeekday>) {
        profile.trainingDays = days
        try? modelContext.save()
    }

    private func saveReminderPreference(_ enabled: Bool) {
        if enabled {
            enableReminders()
        } else {
            disableReminders()
        }
    }

    private func saveReminderTime(_ reminderTime: Date) {
        profile.reminderTime = reminderTime
        try? modelContext.save()
        guard profile.remindersEnabled else { return }

        enableReminders()
    }

    private func enableReminders() {
        Task { @MainActor in
            let scheduler = WorkoutNotificationScheduler()
            let allowed = await scheduler.requestAuthorization()
            guard allowed else {
                profile.remindersEnabled = false
                try? modelContext.save()
                isShowingReminderPermissionAlert = true
                return
            }

            profile.remindersEnabled = true
            try? modelContext.save()
            await scheduler.scheduleWorkoutReminders(for: sessions, at: profile.reminderTime)
        }
    }

    private func disableReminders() {
        profile.remindersEnabled = false
        try? modelContext.save()
        WorkoutNotificationScheduler().clearWorkoutReminders()
    }

    private func refreshEnabledReminders() {
        guard profile.remindersEnabled else { return }
        enableReminders()
    }

    private func openNotificationSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        openURL(url)
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

private struct WeekScheduleCard: View {
    var profile: UserProfile
    var onScheduleChange: (Set<TrainingWeekday>) -> Void

    private var selectedDays: Binding<Set<TrainingWeekday>> {
        Binding(
            get: { profile.trainingDays },
            set: { onScheduleChange($0) }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Week schedule")
                .font(.headline)
            TrainingDaysPicker(selectedDays: selectedDays)
            InfoLine(title: "AI week shape", value: profile.trainingDayLabels.joined(separator: ", "))
        }
        .card()
    }
}

private struct ReminderSettingsCard: View {
    var profile: UserProfile
    var onReminderToggle: (Bool) -> Void
    var onReminderTimeChange: (Date) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Reminder")
                .font(.headline)

            Toggle("Enabled", isOn: Binding(
                get: { profile.remindersEnabled },
                set: { newValue in
                    onReminderToggle(newValue)
                }
            ))
            .tint(AppTheme.accent)

            DatePicker(
                "Time",
                selection: Binding(
                    get: { profile.reminderTime },
                    set: { onReminderTimeChange($0) }
                ),
                displayedComponents: .hourAndMinute
            )
            .accessibilityIdentifier("reminder-time-picker")
        }
        .card()
    }
}

private struct ResetCard: View {
    var resetError: String?
    var onResetTap: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Reset")
                .font(.headline)
            Text("Deletes profile, measurements, goals, sessions, logs, streak data, coach plans, coach decisions, and pending workout reminders.")
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
