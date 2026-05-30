import SwiftData
import SwiftUI

struct SettingsView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \RunningTrainingProfile.createdAt) private var runningProfiles: [RunningTrainingProfile]
    @State private var notificationStatus = "Not requested"
    @State private var isShowingResetConfirmation = false
    @State private var resetError: String?

    var profile: UserProfile

    private var runningProfile: RunningTrainingProfile {
        displayRunningProfile(for: profile, from: runningProfiles)
    }

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "Profile") {
                ProfileSummaryCard(profile: profile)
                UltraProfileSettingsCard(
                    runningProfile: runningProfile,
                    onChange: saveProfileChanges
                )
                ReminderSettingsCard(
                    profile: profile,
                    sessions: sessions,
                    notificationStatus: notificationStatus,
                    onReminderTimeChange: saveReminderTime,
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
                Text("This removes every measurement, workout, log, rank, and coach record from the app.")
            }
        }
        .onAppear {
            _ = try? ensureRunningProfile(for: profile, from: runningProfiles, in: modelContext)
        }
    }

    private func saveReminderTime(_ minutesAfterMidnight: Int) {
        profile.reminderMinutesAfterMidnight = minutesAfterMidnight
        profile.remindersEnabled = minutesAfterMidnight >= 0
        try? modelContext.save()
    }

    private func saveProfileChanges() {
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
            InfoLine(title: "Sessions/week", value: "\(profile.weeklySessions)")
            InfoLine(title: "iCloud container", value: ModelContainerFactory.cloudKitContainerIdentifier)
        }
        .card()
    }
}

private struct ReminderSettingsCard: View {
    var profile: UserProfile
    var sessions: [WorkoutSession]
    var notificationStatus: String
    var onReminderTimeChange: (Int) -> Void
    var onStatusChange: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Reminder time", systemImage: "bell")
                    .font(.headline)
                Spacer()
                Text(timeOfDayText(minutesAfterMidnight: profile.reminderMinutesAfterMidnight))
                    .font(.caption.weight(.bold))
                    .foregroundStyle(profile.reminderMinutesAfterMidnight >= 0 ? AppTheme.accent : AppTheme.muted)
            }

            if profile.reminderMinutesAfterMidnight >= 0 {
                DatePicker("Time", selection: reminderDateBinding, displayedComponents: .hourAndMinute)
                Button("Clear reminder time") {
                    onReminderTimeChange(-1)
                    WorkoutNotificationScheduler().clearWorkoutReminders()
                    onStatusChange("Empty")
                }
                .buttonStyle(SecondaryActionButtonStyle())
            } else {
                Button("Add reminder time") {
                    onReminderTimeChange(8 * 60)
                    onStatusChange("Time set to 08:00")
                }
                .buttonStyle(SecondaryActionButtonStyle())
            }

            Button("Apply reminders", action: scheduleReminders)
                .buttonStyle(SecondaryActionButtonStyle())
                .disabled(profile.reminderMinutesAfterMidnight < 0)
                .opacity(profile.reminderMinutesAfterMidnight >= 0 ? 1 : 0.45)

            InfoLine(title: "Status", value: notificationStatus)
        }
        .card()
    }

    private var reminderDateBinding: Binding<Date> {
        Binding(
            get: {
                let minutes = max(0, profile.reminderMinutesAfterMidnight)
                var components = Calendar.current.dateComponents([.year, .month, .day], from: Date())
                components.hour = minutes / 60
                components.minute = minutes % 60
                return Calendar.current.date(from: components) ?? Date()
            },
            set: { date in
                let components = Calendar.current.dateComponents([.hour, .minute], from: date)
                onReminderTimeChange((components.hour ?? 0) * 60 + (components.minute ?? 0))
            }
        )
    }

    private func scheduleReminders() {
        guard profile.reminderMinutesAfterMidnight >= 0 else {
            WorkoutNotificationScheduler().clearWorkoutReminders()
            onStatusChange("Empty")
            return
        }

        Task {
            let scheduler = WorkoutNotificationScheduler()
            let allowed = await scheduler.requestAuthorization()
            if allowed {
                await scheduler.scheduleWorkoutReminders(for: sessions, minutesAfterMidnight: profile.reminderMinutesAfterMidnight)
                onStatusChange("Scheduled at \(timeOfDayText(minutesAfterMidnight: profile.reminderMinutesAfterMidnight))")
            } else {
                onStatusChange("Denied")
            }
        }
    }
}

private struct UltraProfileSettingsCard: View {
    var runningProfile: RunningTrainingProfile
    var onChange: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Ultra runner")
                    .font(.headline)
                Spacer()
                StatusPill(text: "Active", systemImage: "figure.run")
            }
            DatePicker("Target date", selection: dateBinding, displayedComponents: .date)
            IntegerField(title: "Target distance", value: intBinding(\.targetRaceKm), range: 10...300, suffix: "km")
            IntegerField(title: "Run sessions/week", value: intBinding(\.weeklyRunSessions), range: 3...6)
            IntegerField(title: "Current weekly km", value: intBinding(\.currentWeeklyDistanceKm), range: 5...250, suffix: "km")
            IntegerField(title: "Current long run", value: intBinding(\.currentLongRunKm), range: 3...120, suffix: "km")
            PaceField(title: "Easy pace", secondsPerKm: intBinding(\.easyPaceSecondsPerKm))
            IntegerField(title: "Easy HR", value: intBinding(\.easyHeartRate), range: 90...190, suffix: "bpm")
            IntegerField(title: "Threshold HR", value: intBinding(\.thresholdHeartRate), range: 110...210, suffix: "bpm")
            IntegerField(title: "Target elevation", value: intBinding(\.targetElevationMeters), range: 0...12_000, suffix: "m")

            Picker("Running background", selection: backgroundBinding) {
                ForEach(RunningBackground.allCases) { background in
                    Text(background.title).tag(background)
                }
            }
            .pickerStyle(.menu)

            Picker("Current durability", selection: durabilityBinding) {
                ForEach(RunningDurability.allCases) { durability in
                    Text(durability.title).tag(durability)
                }
            }
            .pickerStyle(.menu)

            Picker("Main terrain", selection: terrainBinding) {
                ForEach(RunningTerrain.allCases) { terrain in
                    Text(terrain.title).tag(terrain)
                }
            }
            .pickerStyle(.menu)

            Picker("Walk strategy", selection: walkStrategyBinding) {
                ForEach(WalkStrategy.allCases) { strategy in
                    Text(strategy.title).tag(strategy)
                }
            }
            .pickerStyle(.menu)
            if runningProfile.walkStrategy == .timed || runningProfile.walkStrategy == .custom {
                TextField("Walk strategy details", text: stringBinding(\.runWalkStrategy))
                    .textFieldStyle(.roundedBorder)
            } else {
                Text(runningProfile.walkStrategy == .climbsOnly ? "Walk climbs early to keep heart rate controlled." : "No planned walk breaks; keep the run conversational.")
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            }
            TextField("Running notes", text: stringBinding(\.injuryNotes), axis: .vertical)
                .textFieldStyle(.roundedBorder)
        }
        .card()
    }

    private var dateBinding: Binding<Date> {
        Binding(
            get: { runningProfile.targetRaceDate },
            set: {
                runningProfile.targetRaceDate = $0
                onChange()
            }
        )
    }

    private var backgroundBinding: Binding<RunningBackground> {
        Binding(
            get: { runningProfile.background },
            set: {
                runningProfile.background = $0
                onChange()
            }
        )
    }

    private var durabilityBinding: Binding<RunningDurability> {
        Binding(
            get: { runningProfile.durability },
            set: {
                runningProfile.durability = $0
                onChange()
            }
        )
    }

    private var walkStrategyBinding: Binding<WalkStrategy> {
        Binding(
            get: { runningProfile.walkStrategy },
            set: {
                runningProfile.walkStrategy = $0
                onChange()
            }
        )
    }

    private var terrainBinding: Binding<RunningTerrain> {
        Binding(
            get: { runningProfile.terrain },
            set: {
                runningProfile.terrain = $0
                onChange()
            }
        )
    }

    private func intBinding(_ keyPath: ReferenceWritableKeyPath<RunningTrainingProfile, Int>) -> Binding<Int> {
        Binding(
            get: { runningProfile[keyPath: keyPath] },
            set: {
                runningProfile[keyPath: keyPath] = $0
                onChange()
            }
        )
    }

    private func stringBinding(_ keyPath: ReferenceWritableKeyPath<RunningTrainingProfile, String>) -> Binding<String> {
        Binding(
            get: { runningProfile[keyPath: keyPath] },
            set: {
                runningProfile[keyPath: keyPath] = $0
                onChange()
            }
        )
    }
}

private struct ResetCard: View {
    var resetError: String?
    var onResetTap: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Reset")
                .font(.headline)
            Text("Deletes profile, measurements, goals, sessions, logs, rank, coach plans, coach decisions, and pending workout reminders.")
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
