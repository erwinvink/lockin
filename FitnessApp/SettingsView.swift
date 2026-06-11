import SwiftData
import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(\.openURL) private var openURL
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \RaceGoal.createdAt) private var raceGoals: [RaceGoal]
    @Query(sort: \RunLog.completedAt, order: .reverse) private var runLogs: [RunLog]
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
                    hasConfirmedRuns: runLogs.contains { !$0.needsConfirmation },
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
                Text("iCloud · \(ModelContainerFactory.cloudKitContainerIdentifier)")
                    .font(.system(size: 11))
                    .foregroundStyle(AppTheme.faint)
                    .frame(maxWidth: .infinity, alignment: .center)
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
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 3) {
                Text(profile.name)
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(AppTheme.text)
                Text("Target: \(profile.targetDate, format: .dateTime.day().month().year())")
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(AppTheme.muted)
            }
            VStack(spacing: 10) {
                InfoLine(title: "Goals", value: "\(profile.goalPullUps) pull-ups, \(profile.goalPushUps) push-ups, \(format(seconds: profile.goalPlankSeconds)) plank")
                InfoLine(title: "Training days", value: profile.trainingDayLabels.joined(separator: ", "))
            }
        }
        .ruled(verticalPadding: 16)
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
            SectionHeader("Week schedule")
            TrainingDaysPicker(selectedDays: selectedDays)
            InfoLine(title: "AI week shape", value: profile.trainingDayLabels.joined(separator: ", "))
        }
        .ruled(verticalPadding: 16)
    }
}

private struct RunningGoalCard: View {
    var profile: UserProfile
    var raceGoal: RaceGoal?
    var hasConfirmedRuns: Bool = false
    var onCreateGoal: () -> Void
    var onRemoveGoal: () -> Void
    var onRunningDaysChange: (Set<TrainingWeekday>) -> Void
    var onLongRunDayChange: (TrainingWeekday) -> Void
    var onGoalChange: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader("Running")
            if let raceGoal {
                RaceGoalEditor(
                    profile: profile,
                    goal: raceGoal,
                    hasConfirmedRuns: hasConfirmedRuns,
                    onRemoveGoal: onRemoveGoal,
                    onRunningDaysChange: onRunningDaysChange,
                    onLongRunDayChange: onLongRunDayChange,
                    onGoalChange: onGoalChange
                )
            } else {
                Text("Set a race goal to unlock the ultra coach.")
                    .font(.footnote)
                    .foregroundStyle(AppTheme.muted)
                Button(action: onCreateGoal) {
                    Label("Set up running", systemImage: "figure.run")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryActionButtonStyle())
                .accessibilityIdentifier("running-setup-button")
            }
        }
        .ruled(verticalPadding: 16)
    }
}

private struct RaceGoalEditor: View {
    var profile: UserProfile
    var goal: RaceGoal
    var hasConfirmedRuns: Bool = false
    var onRemoveGoal: () -> Void
    var onRunningDaysChange: (Set<TrainingWeekday>) -> Void
    var onLongRunDayChange: (TrainingWeekday) -> Void
    var onGoalChange: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            TextField("Race name", text: nameBinding)
                .textInputAutocapitalization(.words)
                .font(.subheadline)
                .lockinField()
            DatePicker("Race date", selection: raceDateBinding, displayedComponents: .date)
                .font(.subheadline.weight(.medium))
                .tint(AppTheme.accent)
            IntegerField(title: "Distance", value: distanceBinding, range: 1...500, suffix: "km")
            IntegerField(title: "Elevation gain", value: elevationBinding, range: 0...30_000, suffix: "m+")
            if hasConfirmedRuns {
                // Real run history owns these numbers; editable fields here
                // would be silently overwritten on the next sync.
                InfoLine(title: "Baseline weekly volume", value: "\(Int(goal.baselineWeeklyKm.rounded())) km")
                InfoLine(title: "Longest recent run", value: "\(Int(goal.longestRecentRunKm.rounded())) km")
                Text("Updated automatically from your confirmed Garmin runs.")
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.faint)
            } else {
                IntegerField(title: "Baseline weekly volume", value: baselineWeeklyBinding, range: 0...300, suffix: "km")
                IntegerField(title: "Longest recent run", value: longestRecentRunBinding, range: 0...200, suffix: "km")
                Text("Starting estimates — once real runs sync from Garmin these update themselves.")
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.faint)
            }
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
    @State private var isPushing = false
    @State private var syncResult: String?
    @State private var syncError: String?
    @State private var pushStatus: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader("Garmin") {
                StatusPill(text: statusText, color: statusColor, systemImage: statusIcon)
            }

            InfoLine(title: "Last sync", value: relativeSyncText(epochSeconds: garminLastSyncAt))

            if let lastError = status?.lastError, !lastError.isEmpty {
                Text(lastError)
                    .font(.footnote)
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
                    .font(.footnote)
                    .foregroundStyle(AppTheme.muted)
            }

            if let syncError {
                Text(syncError)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.warning)
            }

            Button(action: pushRunsToWatch) {
                Label(isPushing ? "Pushing runs" : "Push runs to watch", systemImage: "arrow.up.circle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(SecondaryActionButtonStyle())
            .accessibilityIdentifier("garmin-push-retry")
            .disabled(isPushing)
            .opacity(isPushing ? 0.55 : 1)

            if let pushStatus {
                Text(pushStatus)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.muted)
            }

            Text("Garmin login lives on the lockin server. If this shows Not logged in, run the login step on the server. When Garmin is unreachable, coaching continues from your logged training.")
                .font(.system(size: 12))
                .foregroundStyle(AppTheme.faint)
        }
        .ruled(verticalPadding: 16)
        .task { await loadStatus() }
    }

    private func pushRunsToWatch() {
        guard !isPushing, !GarminPushCoordinator.isPushing else { return }
        isPushing = true
        pushStatus = nil
        Task {
            defer { isPushing = false }
            let note = await GarminPushCoordinator.pushPlannedRuns(
                endpoint: endpoint,
                stalePushedIds: [],
                in: modelContext
            )
            pushStatus = note ?? "All planned runs are already on your watch."
        }
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
                let ingested = try await performGarminSync(endpoint: endpoint, in: modelContext)
                garminLastSyncAt = Date().timeIntervalSince1970
                if ingested.importedRuns > 0 {
                    UserDefaults.standard.set(true, forKey: CoachVerdictRefreshFlag.needsRefreshKey)
                }
                var parts: [String] = []
                if ingested.importedRuns > 0 {
                    parts.append("\(ingested.importedRuns) \(ingested.importedRuns == 1 ? "run" : "runs") imported")
                }
                if ingested.pendingRuns > 0 {
                    parts.append("\(ingested.pendingRuns) to confirm")
                }
                syncResult = parts.isEmpty ? "Synced" : "Synced — " + parts.joined(separator: ", ")
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
            SectionHeader("Reminder")

            Toggle("Enabled", isOn: Binding(
                get: { profile.remindersEnabled },
                set: { newValue in
                    onReminderToggle(newValue)
                }
            ))
            .font(.subheadline.weight(.medium))
            .tint(AppTheme.accent)

            DatePicker(
                "Time",
                selection: Binding(
                    get: { profile.reminderTime },
                    set: { onReminderTimeChange($0) }
                ),
                displayedComponents: .hourAndMinute
            )
            .font(.subheadline.weight(.medium))
            .tint(AppTheme.accent)
            .accessibilityIdentifier("reminder-time-picker")
        }
        .ruled(verticalPadding: 16)
    }
}

private struct ResetCard: View {
    var resetError: String?
    var onResetTap: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader("Reset")
            Text("Deletes profile, measurements, goals, race goal, sessions, logs, runs, streak data, coach plans, coach decisions, and pending workout reminders.")
                .font(.system(size: 12))
                .foregroundStyle(AppTheme.faint)
            Button(role: .destructive, action: onResetTap) {
                Label("Wipe all app data", systemImage: "trash")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(SecondaryActionButtonStyle())
            if let resetError {
                Text(resetError)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.warning)
            }
        }
        .ruled(verticalPadding: 16)
    }
}
