import SwiftData
import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(\.openURL) private var openURL
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \RaceGoal.createdAt) private var raceGoals: [RaceGoal]
    // Configuration, not state: fixed per build flavor (see LocalCoachClient).
    private let coachEndpoint = LocalCoachClient.defaultEndpointString
    @AppStorage("garminLastSyncAt") private var garminLastSyncAt: Double = 0
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
                RunningGoalCard(
                    profile: profile,
                    raceGoal: raceGoals.first,
                    onCreateGoal: createRaceGoal,
                    onRemoveGoal: removeRaceGoal,
                    onRunningDaysChange: saveRunningDays,
                    onLongRunDayChange: saveLongRunDay,
                    onGoalChange: saveRaceGoalEdits
                )
                GarminCard(endpoint: coachEndpoint)
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

    private func createRaceGoal() {
        let raceDate = Calendar.current.date(byAdding: .weekOfYear, value: 16, to: Date()) ?? Date()
        modelContext.insert(RaceGoal(raceDate: raceDate, distanceKm: 50, elevationGainM: 1_000))
        if profile.runningDays.isEmpty {
            profile.runningDays = [.tuesday, .thursday, .saturday]
            profile.longRunDay = .saturday
        } else if profile.longRunDay.map({ profile.runningDays.contains($0) }) != true {
            profile.longRunDay = latestDay(in: profile.runningDays)
        }
        try? modelContext.save()
    }

    private func removeRaceGoal() {
        for goal in raceGoals {
            modelContext.delete(goal)
        }
        try? modelContext.save()
    }

    private func saveRunningDays(_ days: Set<TrainingWeekday>) {
        guard !days.isEmpty else { return }
        profile.runningDays = days
        if profile.longRunDay.map({ days.contains($0) }) != true {
            profile.longRunDay = latestDay(in: days)
        }
        try? modelContext.save()
    }

    private func saveLongRunDay(_ day: TrainingWeekday) {
        profile.longRunDay = day
        try? modelContext.save()
    }

    private func saveRaceGoalEdits() {
        try? modelContext.save()
    }

    private func latestDay(in days: Set<TrainingWeekday>) -> TrainingWeekday? {
        TrainingWeekday.allCases.last { days.contains($0) }
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
            // The wiped data includes the synced snapshots and run logs, so
            // "Last sync" must read Never again and the next foreground must
            // re-pull. The pending-delete stash is deliberately kept: those
            // pushed watch workouts still need cleanup on the Garmin side.
            garminLastSyncAt = 0
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

private struct RunningGoalCard: View {
    var profile: UserProfile
    var raceGoal: RaceGoal?
    var onCreateGoal: () -> Void
    var onRemoveGoal: () -> Void
    var onRunningDaysChange: (Set<TrainingWeekday>) -> Void
    var onLongRunDayChange: (TrainingWeekday) -> Void
    var onGoalChange: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Running")
                .font(.headline)
            if let raceGoal {
                RaceGoalEditor(
                    profile: profile,
                    goal: raceGoal,
                    onRemoveGoal: onRemoveGoal,
                    onRunningDaysChange: onRunningDaysChange,
                    onLongRunDayChange: onLongRunDayChange,
                    onGoalChange: onGoalChange
                )
            } else {
                Text("Set a race goal to unlock the ultra coach.")
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
                Button(action: onCreateGoal) {
                    Label("Set up running", systemImage: "figure.run")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryActionButtonStyle())
                .accessibilityIdentifier("running-setup-button")
            }
        }
        .card()
    }
}

private struct RaceGoalEditor: View {
    var profile: UserProfile
    var goal: RaceGoal
    var onRemoveGoal: () -> Void
    var onRunningDaysChange: (Set<TrainingWeekday>) -> Void
    var onLongRunDayChange: (TrainingWeekday) -> Void
    var onGoalChange: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            TextField("Race name", text: nameBinding)
                .textInputAutocapitalization(.words)
                .textFieldStyle(.roundedBorder)
            DatePicker("Race date", selection: raceDateBinding, displayedComponents: .date)
            IntegerField(title: "Distance", value: distanceBinding, range: 1...500, suffix: "km")
            IntegerField(title: "Elevation gain", value: elevationBinding, range: 0...30_000, suffix: "m+")
            IntegerField(title: "Baseline weekly volume", value: baselineWeeklyBinding, range: 0...300, suffix: "km")
            IntegerField(title: "Longest recent run", value: longestRecentRunBinding, range: 0...200, suffix: "km")
            TrainingDaysPicker(
                selectedDays: runningDaysBinding,
                title: "Running days",
                minDays: 1,
                maxDays: 7,
                caption: "Pick 1 to 7 days. At least one running day is needed while a race goal is set.",
                preventsEmptySelection: true
            )
            if !orderedRunningDays.isEmpty {
                HStack {
                    Text("Long run day")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(AppTheme.text)
                    Spacer()
                    Picker("Long run day", selection: longRunDayBinding) {
                        ForEach(orderedRunningDays) { day in
                            Text(day.title).tag(day)
                        }
                    }
                    .pickerStyle(.menu)
                    .tint(AppTheme.accent)
                    .labelsHidden()
                }
            }
            Button(role: .destructive) {
                onRemoveGoal()
            } label: {
                Label("Remove race goal", systemImage: "trash")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(SecondaryActionButtonStyle())
        }
    }

    private var orderedRunningDays: [TrainingWeekday] {
        TrainingWeekday.allCases.filter { profile.runningDays.contains($0) }
    }

    private var nameBinding: Binding<String> {
        Binding(
            get: { goal.name },
            set: { goal.name = $0; onGoalChange() }
        )
    }

    private var raceDateBinding: Binding<Date> {
        Binding(
            get: { goal.raceDate },
            set: { goal.raceDate = $0; onGoalChange() }
        )
    }

    private var distanceBinding: Binding<Int> {
        Binding(
            get: { Int(goal.distanceKm.rounded()) },
            set: { goal.distanceKm = Double($0); onGoalChange() }
        )
    }

    private var elevationBinding: Binding<Int> {
        Binding(
            get: { goal.elevationGainM },
            set: { goal.elevationGainM = $0; onGoalChange() }
        )
    }

    private var baselineWeeklyBinding: Binding<Int> {
        Binding(
            get: { Int(goal.baselineWeeklyKm.rounded()) },
            set: { goal.baselineWeeklyKm = Double($0); onGoalChange() }
        )
    }

    private var longestRecentRunBinding: Binding<Int> {
        Binding(
            get: { Int(goal.longestRecentRunKm.rounded()) },
            set: { goal.longestRecentRunKm = Double($0); onGoalChange() }
        )
    }

    private var runningDaysBinding: Binding<Set<TrainingWeekday>> {
        Binding(
            get: { profile.runningDays },
            set: { onRunningDaysChange($0) }
        )
    }

    private var longRunDayBinding: Binding<TrainingWeekday> {
        Binding(
            get: {
                profile.longRunDay
                    ?? TrainingWeekday.allCases.last { profile.runningDays.contains($0) }
                    ?? .saturday
            },
            set: { onLongRunDayChange($0) }
        )
    }
}

private struct GarminCard: View {
    var endpoint: String

    @Environment(\.modelContext) private var modelContext
    @AppStorage("garminLastSyncAt") private var garminLastSyncAt: Double = 0
    @State private var status: GarminStatusResponse?
    @State private var statusFailed = false
    @State private var isSyncing = false
    @State private var syncResult: String?
    @State private var syncError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Garmin")
                    .font(.headline)
                Spacer()
                StatusPill(text: statusText, color: statusColor, systemImage: statusIcon)
            }

            InfoLine(title: "Last sync", value: relativeSyncText(epochSeconds: garminLastSyncAt))

            if let lastError = status?.lastError, !lastError.isEmpty {
                Text(lastError)
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            }

            Button(action: syncNow) {
                Label(isSyncing ? "Syncing" : "Sync now", systemImage: "arrow.triangle.2.circlepath")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(SecondaryActionButtonStyle())
            .accessibilityIdentifier("garmin-sync-now")
            .disabled(isSyncing)
            .opacity(isSyncing ? 0.55 : 1)

            if let syncResult {
                Text(syncResult)
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            }

            if let syncError {
                Text(syncError)
                    .font(.caption)
                    .foregroundStyle(AppTheme.warning)
            }

            Text("Garmin login lives on the lockin server. If this shows Not logged in, run the login step on the server.")
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
            Text("When Garmin is unreachable, coaching continues from your logged training.")
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
        }
        .card()
        .task { await loadStatus() }
    }

    private var statusText: String {
        guard let status else { return statusFailed ? "Unreachable" : "Checking" }
        return status.displayState.text
    }

    private var statusColor: Color {
        guard let status else { return statusFailed ? AppTheme.warning : AppTheme.muted }
        return status.displayState.isHealthy ? AppTheme.accent : AppTheme.warning
    }

    private var statusIcon: String {
        guard let status else { return statusFailed ? "exclamationmark.triangle.fill" : "hourglass" }
        return status.displayState.isHealthy ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
    }

    private func loadStatus() async {
        do {
            status = try await LocalCoachClient(endpointString: endpoint).fetchGarminStatus()
            statusFailed = false
        } catch {
            status = nil
            statusFailed = true
        }
    }

    private func syncNow() {
        guard !isSyncing else { return }
        isSyncing = true
        syncResult = nil
        syncError = nil
        Task {
            defer { isSyncing = false }
            do {
                let newRuns = try await performGarminSync(endpoint: endpoint, in: modelContext)
                garminLastSyncAt = Date().timeIntervalSince1970
                syncResult = newRuns > 0
                    ? "Synced — \(newRuns) new \(newRuns == 1 ? "run" : "runs") to confirm"
                    : "Synced"
            } catch {
                syncError = error.localizedDescription
            }
            await loadStatus()
        }
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
            Text("Deletes profile, measurements, goals, race goal, sessions, logs, runs, streak data, coach plans, coach decisions, and pending workout reminders.")
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
