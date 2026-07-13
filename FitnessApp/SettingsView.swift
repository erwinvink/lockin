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
    @AppStorage("garminConnectionActive") private var garminConnectionActive = false
    @State private var isShowingReminderPermissionAlert = false
    @State private var isShowingResetConfirmation = false
    @State private var resetError: String?
    #if DEBUG && targetEnvironment(simulator)
    @State private var isShowingSeedConfirmation = false
    @State private var seedMessage: String?
    @State private var seedError: String?
    #endif

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
                    hasConfirmedRuns: runLogs.contains { $0.source == .garmin },
                    onCreateGoal: createRaceGoal,
                    onRemoveGoal: removeRaceGoal,
                    onRunningDaysChange: saveRunningDays,
                    onLongRunDayChange: saveLongRunDay,
                    onGoalChange: saveRaceGoalEdits
                )
                GarminCard(endpoint: coachEndpoint, userId: profile.id.uuidString)
                ReminderSettingsCard(
                    profile: profile,
                    onReminderToggle: saveReminderPreference,
                    onReminderTimeChange: saveReminderTime
                )
                #if DEBUG && targetEnvironment(simulator)
                DemoHistorySeedCard(
                    seedMessage: seedMessage,
                    seedError: seedError,
                    onSeedTap: { isShowingSeedConfirmation = true }
                )
                #endif
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
            #if DEBUG && targetEnvironment(simulator)
            .alert("Replace with demo history?", isPresented: $isShowingSeedConfirmation) {
                Button("Cancel", role: .cancel) {}
                Button("Seed demo history", role: .destructive, action: seedDemoHistory)
            } message: {
                Text("This wipes local app data and adds fake strength sessions, Garmin-style runs, readiness, a race goal, and a coach read.")
            }
            #endif
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
            garminConnectionActive = false
        } catch {
            resetError = error.localizedDescription
        }
    }

    #if DEBUG && targetEnvironment(simulator)
    private func seedDemoHistory() {
        do {
            WorkoutNotificationScheduler().clearWorkoutReminders()
            try seedTwoWeekActivityPreview(in: modelContext)
            garminLastSyncAt = 0
            garminConnectionActive = false
            seedMessage = "Demo history loaded."
            seedError = nil
            resetError = nil
        } catch {
            seedMessage = nil
            seedError = error.localizedDescription
        }
    }
    #endif
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
                Text("Updated automatically from your Garmin runs.")
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
                title: "Available running days",
                minDays: 1,
                maxDays: 7,
                caption: "Pick the days you can run. The coach may leave rest days open while you build.",
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
    var userId: String

    @Environment(\.modelContext) private var modelContext
    @AppStorage("garminLastSyncAt") private var garminLastSyncAt: Double = 0
    @AppStorage("garminConnectionActive") private var garminConnectionActive = false
    @State private var status: GarminStatusResponse?
    @State private var watchSyncStatus: GarminSyncPlanResponse?
    @State private var statusFailed = false
    @State private var isSyncing = false
    @State private var isConnecting = false
    @State private var isDisconnecting = false
    @State private var isRetryingWatchSync = false
    @State private var isShowingConnectForm = false
    @State private var isShowingTroubleshoot = false
    @State private var garminEmail = ""
    @State private var garminPassword = ""
    @State private var garminMFACode = ""
    @State private var connectMessage: String?
    @State private var connectError: String?
    @State private var syncResult: String?
    @State private var syncError: String?
    @State private var watchRetryStatus: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader("Garmin") {
                StatusPill(text: statusText, color: statusColor, systemImage: statusIcon)
            }

            if let connectedEmail = status?.connectedEmail, !connectedEmail.isEmpty {
                InfoLine(title: "Account", value: connectedEmail)
            }
            InfoLine(title: "Last sync", value: relativeSyncText(epochSeconds: garminLastSyncAt))
            InfoLine(title: "Watch plan", value: watchPlanText)

            if let watchError = watchSyncStatus?.lastError, !watchError.isEmpty {
                Text(watchError)
                    .font(.footnote)
                    .foregroundStyle(watchSyncStatus?.status == .failed ? AppTheme.warning : AppTheme.muted)
            }

            if isConnected {
                Button(action: syncNow) {
                    Label(isSyncing ? "Importing" : "Import Garmin data", systemImage: "arrow.triangle.2.circlepath")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryActionButtonStyle())
                .accessibilityIdentifier("garmin-sync-now")
                .disabled(isSyncing)
                .opacity(isSyncing ? 0.55 : 1)
            } else {
                Button(action: { isShowingConnectForm.toggle() }) {
                    Label(isShowingConnectForm ? "Hide sign-in fields" : "Connect Garmin", systemImage: "link")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryActionButtonStyle())
                .accessibilityIdentifier("garmin-connect-toggle")
            }

            if isShowingConnectForm && !isConnected {
                VStack(alignment: .leading, spacing: 10) {
                    TextField("Garmin email", text: $garminEmail)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                        .font(.subheadline)
                        .lockinField()
                        .accessibilityIdentifier("garmin-email-field")

                    SecureField("Garmin password", text: $garminPassword)
                        .font(.subheadline)
                        .lockinField()
                        .accessibilityIdentifier("garmin-password-field")

                    if shouldShowMFAField {
                        TextField("MFA code", text: $garminMFACode)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.numberPad)
                            .font(.subheadline)
                            .lockinField()
                            .accessibilityIdentifier("garmin-mfa-field")
                    }

                    Button(action: connectGarmin) {
                        Label(isConnecting ? "Connecting" : connectButtonTitle, systemImage: "checkmark.circle")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(SecondaryActionButtonStyle())
                    .accessibilityIdentifier("garmin-connect-submit")
                    .disabled(isConnecting || garminEmail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || garminPassword.isEmpty)
                    .opacity(isConnecting ? 0.55 : 1)
                }
            }

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

            if shouldShowWatchRetry && isConnected {
                Button(action: retryWatchSync) {
                    Label(isRetryingWatchSync ? "Retrying watch sync" : "Retry watch sync", systemImage: "arrow.clockwise.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryActionButtonStyle())
                .accessibilityIdentifier("garmin-watch-sync-retry")
                .disabled(isRetryingWatchSync)
                .opacity(isRetryingWatchSync ? 0.55 : 1)
            }

            if let watchRetryStatus {
                Text(watchRetryStatus)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.muted)
            }

            if let connectMessage {
                Text(connectMessage)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.muted)
            }

            if let connectError {
                Text(connectError)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.warning)
            }

            HStack(spacing: 10) {
                Button(action: { isShowingTroubleshoot.toggle() }) {
                    Label("Troubleshoot", systemImage: "wrench.and.screwdriver")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryActionButtonStyle())
                .accessibilityIdentifier("garmin-troubleshoot")

                if isConnected {
                    Button(role: .destructive, action: disconnectGarmin) {
                        Label(isDisconnecting ? "Disconnecting" : "Disconnect", systemImage: "xmark.circle")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(SecondaryActionButtonStyle())
                    .accessibilityIdentifier("garmin-disconnect")
                    .disabled(isDisconnecting)
                    .opacity(isDisconnecting ? 0.55 : 1)
                }
            }

            if isShowingTroubleshoot {
                VStack(alignment: .leading, spacing: 6) {
                    InfoLine(title: "Connection", value: statusText)
                    if let lastError = status?.lastError, !lastError.isEmpty {
                        Text(lastError)
                            .font(.footnote)
                            .foregroundStyle(AppTheme.warning)
                    } else if statusFailed {
                        Text("Lockin could not reach the coach proxy.")
                            .font(.footnote)
                            .foregroundStyle(AppTheme.warning)
                    }
                }
            }
        }
        .ruled(verticalPadding: 16)
        .task { await loadStatus() }
    }

    private func retryWatchSync() {
        guard !isRetryingWatchSync, !GarminSyncCoordinator.isSyncing else { return }
        isRetryingWatchSync = true
        watchRetryStatus = nil
        Task {
            defer { isRetryingWatchSync = false }
            watchRetryStatus = await GarminSyncCoordinator.retryFailedSync(
                endpoint: endpoint,
                userId: userId,
                in: modelContext
            )
            await loadStatus()
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
        let client: LocalCoachClient
        do {
            client = try LocalCoachClient(endpointString: endpoint)
        } catch {
            status = nil
            watchSyncStatus = nil
            statusFailed = true
            return
        }

        do {
            status = try await client.fetchGarminStatus(userId: userId)
            statusFailed = false
            garminConnectionActive = status?.loggedIn == true
            if status?.state == .mfaRequired {
                isShowingConnectForm = true
            }
        } catch {
            status = nil
            statusFailed = true
        }

        do {
            watchSyncStatus = try await client.fetchGarminSyncStatus(userId: userId)
        } catch {
            watchSyncStatus = nil
        }
    }

    private func connectGarmin() {
        guard !isConnecting else { return }
        isConnecting = true
        connectMessage = nil
        connectError = nil
        Task {
            defer { isConnecting = false }
            do {
                let response = try await LocalCoachClient(endpointString: endpoint).connectGarmin(GarminConnectRequest(
                    userId: userId,
                    email: garminEmail,
                    password: garminPassword,
                    mfaCode: garminMFACode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : garminMFACode
                ))
                status = response
                statusFailed = false
                if response.loggedIn {
                    garminConnectionActive = true
                    isShowingConnectForm = false
                    garminPassword = ""
                    garminMFACode = ""
                    connectMessage = "Garmin connected."
                    await loadStatus()
                } else if response.state == .mfaRequired {
                    garminMFACode = ""
                    connectError = response.lastError ?? "Garmin needs the MFA code."
                    isShowingConnectForm = true
                } else {
                    connectError = response.lastError ?? "Garmin connection failed."
                }
            } catch {
                connectError = error.localizedDescription
            }
        }
    }

    private func disconnectGarmin() {
        guard !isDisconnecting else { return }
        isDisconnecting = true
        connectMessage = nil
        connectError = nil
        Task {
            defer { isDisconnecting = false }
            do {
                status = try await LocalCoachClient(endpointString: endpoint).disconnectGarmin(userId: userId)
                statusFailed = false
                garminConnectionActive = false
                garminLastSyncAt = 0
                connectMessage = "Garmin disconnected."
                await loadStatus()
            } catch {
                connectError = error.localizedDescription
            }
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
                let ingested = try await performGarminSync(endpoint: endpoint, userId: userId, in: modelContext)
                garminLastSyncAt = Date().timeIntervalSince1970
                if ingested.completedRuns > 0 || ingested.partialRuns > 0 || ingested.importedRuns > 0 {
                    UserDefaults.standard.set(true, forKey: CoachVerdictRefreshFlag.needsRefreshKey)
                }
                var parts: [String] = []
                if ingested.completedRuns > 0 {
                    parts.append("\(ingested.completedRuns) \(ingested.completedRuns == 1 ? "planned run" : "planned runs") completed")
                }
                if ingested.partialRuns > 0 {
                    parts.append("\(ingested.partialRuns) \(ingested.partialRuns == 1 ? "run" : "runs") partial")
                }
                if ingested.importedRuns > 0 {
                    parts.append("\(ingested.importedRuns) \(ingested.importedRuns == 1 ? "run" : "runs") imported")
                }
                syncResult = parts.isEmpty ? "Synced" : "Synced — " + parts.joined(separator: ", ")
            } catch {
                syncError = error.localizedDescription
            }
            await loadStatus()
        }
    }

    private var watchPlanText: String {
        guard isConnected else { return "Not connected" }
        guard let watchSyncStatus else { return statusFailed ? "Unavailable" : "Checking" }
        switch watchSyncStatus.status {
        case .idle:
            return "No future plan"
        case .syncing:
            return "Syncing"
        case .synced:
            return "Ready"
        case .retrying:
            return "Retrying"
        case .failed:
            return "Needs retry"
        case .blockedOnDelete:
            return "Replacing"
        }
    }

    private var shouldShowWatchRetry: Bool {
        guard let watchSyncStatus else { return false }
        switch watchSyncStatus.status {
        case .failed, .retrying, .blockedOnDelete:
            return true
        case .idle, .syncing, .synced:
            return false
        }
    }

    private var isConnected: Bool {
        status?.loggedIn == true
    }

    private var shouldShowMFAField: Bool {
        status?.state == .mfaRequired || !garminMFACode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var connectButtonTitle: String {
        shouldShowMFAField ? "Submit MFA code" : "Connect"
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

#if DEBUG && targetEnvironment(simulator)
private struct DemoHistorySeedCard: View {
    var seedMessage: String?
    var seedError: String?
    var onSeedTap: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader("Demo data")
            Text("Loads a fake two-week training block with strength logs, Garmin-style runs, readiness, race goal, and coach state.")
                .font(.system(size: 12))
                .foregroundStyle(AppTheme.faint)
            Button(action: onSeedTap) {
                Label("Seed demo history", systemImage: "sparkles")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(SecondaryActionButtonStyle())
            .accessibilityIdentifier("seed-demo-history-button")

            if let seedMessage {
                Text(seedMessage)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.muted)
            }
            if let seedError {
                Text(seedError)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.warning)
            }
        }
        .ruled(verticalPadding: 16)
    }
}
#endif
