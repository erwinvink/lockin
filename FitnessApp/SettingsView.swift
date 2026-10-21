import SwiftData
import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(\.openURL) private var openURL
    @Environment(\.modelContext) private var modelContext
    @Environment(\.openTab) private var openTab
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \RaceGoal.createdAt) private var raceGoals: [RaceGoal]
    @Query(sort: \RunLog.completedAt, order: .reverse) private var runLogs: [RunLog]
    // Configuration, not state: fixed per build flavor (see LocalCoachClient).
    private let coachEndpoint = LocalCoachClient.defaultEndpointString
    @AppStorage("garminLastSyncAt") private var garminLastSyncAt: Double = 0
    @AppStorage("garminConnectionActive") private var garminConnectionActive = false
    @AppStorage("autoPlanLastContextSyncAt") private var autoPlanLastContextSyncAt: Double = 0
    @AppStorage("coachModelID") private var selectedModelID = CoachModelCatalog.defaultModelID
    @State private var isShowingReminderPermissionAlert = false
    @State private var isShowingResetConfirmation = false
    @State private var resetError: String?
    @State private var newPlanDraft: NewPlanDraft?
    #if DEBUG && targetEnvironment(simulator)
    @State private var isShowingSeedConfirmation = false
    @State private var seedMessage: String?
    @State private var seedError: String?
    #endif

    var profile: UserProfile

    var body: some View {
        NavigationStack {
            // No screen title: the athlete's name heads the page.
            ScreenBackground {
                ProfileHeader(profile: profile)
                GoalsSection(profile: profile)
                StrengthDaysSection(
                    profile: profile,
                    onScheduleChange: saveTrainingDays
                )
                RaceGoalSection(
                    profile: profile,
                    raceGoal: raceGoals.first,
                    hasConfirmedRuns: runLogs.contains { $0.source == .garmin },
                    onCreateGoal: createRaceGoal,
                    onRemoveGoal: removeRaceGoal,
                    onRunningDaysChange: saveRunningDays,
                    onLongRunDayChange: saveLongRunDay,
                    onGoalChange: saveRaceGoalEdits
                )
                GarminSection(endpoint: coachEndpoint, userId: profile.id.uuidString, profile: profile)
                ReminderSection(
                    profile: profile,
                    onReminderToggle: saveReminderPreference,
                    onReminderTimeChange: saveReminderTime
                )
                #if DEBUG && targetEnvironment(simulator)
                DemoHistorySeedSection(
                    seedMessage: seedMessage,
                    seedError: seedError,
                    onSeedTap: { isShowingSeedConfirmation = true }
                )
                #endif
                NewPlanSection(onStartTap: openNewPlan)
                DataSection(
                    resetError: resetError,
                    onResetTap: { isShowingResetConfirmation = true }
                )
                Text("iCloud · \(ModelContainerFactory.cloudKitContainerIdentifier)")
                    .font(.trail(11, .regular, relativeTo: .caption2))
                    .foregroundStyle(AppTheme.faint)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
            .sheet(item: $newPlanDraft) { draft in
                NewPlanView(profile: profile, draft: draft) { planReady in
                    if planReady { openTab(.today) }
                }
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
            .onDisappear(perform: replanIfScheduleChanged)
        }
    }

    private func openNewPlan() {
        newPlanDraft = NewPlanDraft.make(profile: profile, raceGoal: raceGoals.first, in: modelContext)
    }

    private func saveTrainingDays(_ days: Set<TrainingWeekday>) {
        profile.trainingDays = days
        try? modelContext.save()
        PlanRefreshRequest.mark()
    }

    /// Schedule edits ask for one forced replan when the athlete leaves
    /// Profile, so sessions on de-selected days don't linger until tonight.
    private func replanIfScheduleChanged() {
        guard PlanRefreshRequest.consume() else { return }
        Task {
            guard let request = try? makeCoachRequestFromStore(profile: profile, modelID: selectedModelID, in: modelContext) else {
                PlanRefreshRequest.mark()
                return
            }
            let outcome = await AutoPlanCoordinator.trigger(
                endpoint: coachEndpoint,
                source: .manual,
                reason: "Training days changed.",
                force: true,
                request: request,
                profile: profile,
                in: modelContext
            )
            if PlanRefreshRequest.shouldRetry(after: outcome) {
                PlanRefreshRequest.mark()
            }
        }
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
        PlanRefreshRequest.mark()
    }

    private func removeRaceGoal() {
        for goal in raceGoals {
            modelContext.delete(goal)
        }
        try? modelContext.save()
        PlanRefreshRequest.mark()
    }

    private func saveRunningDays(_ days: Set<TrainingWeekday>) {
        guard !days.isEmpty else { return }
        profile.runningDays = days
        if profile.longRunDay.map({ days.contains($0) }) != true {
            profile.longRunDay = latestDay(in: days)
        }
        try? modelContext.save()
        PlanRefreshRequest.mark()
    }

    private func saveLongRunDay(_ day: TrainingWeekday) {
        profile.longRunDay = day
        try? modelContext.save()
        PlanRefreshRequest.mark()
    }

    private func saveRaceGoalEdits() {
        try? modelContext.save()
        PlanRefreshRequest.mark()
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
            // The next profile gets its first plan right away, not after the
            // 30-minute app-active throttle.
            autoPlanLastContextSyncAt = 0
            _ = PlanRefreshRequest.consume()
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

// MARK: - Building blocks

/// Lighter than the 2pt secondary button: for the second of two actions
/// side by side.
private struct QuietActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.trail(15, .semibold, relativeTo: .subheadline))
            .foregroundStyle(AppTheme.text)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(
                RoundedRectangle(cornerRadius: AppTheme.buttonRadius, style: .continuous)
                    .fill(configuration.isPressed ? AppTheme.surfaceRaised : AppTheme.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.buttonRadius, style: .continuous)
                    .strokeBorder(AppTheme.post.opacity(0.6), lineWidth: 1)
            )
    }
}

// MARK: - Sections

private struct ProfileHeader: View {
    var profile: UserProfile

    private var displayName: String {
        let trimmed = profile.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Profile" : trimmed
    }

    private var subtitle: String {
        let days = profile.trainingDays.count
        let dayText = "\(days) training \(days == 1 ? "day" : "days")"
        return profile.strictFormAccepted ? "Strict form only, \(dayText)" : dayText
    }

    var body: some View {
        HStack(spacing: 14) {
            Text(String(displayName.prefix(1)).uppercased())
                .font(.trail(24, .bold, relativeTo: .title2))
                .foregroundStyle(AppTheme.text)
                .frame(width: 56, height: 56)
                .background(Circle().fill(AppTheme.sign))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(displayName)
                    .font(.trail(28, .bold, relativeTo: .title1))
                    .foregroundStyle(AppTheme.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .accessibilityAddTraits(.isHeader)
                Text(subtitle)
                    .font(.trail(14, .regular, relativeTo: .subheadline))
                    .foregroundStyle(AppTheme.muted)
            }
        }
        .padding(.top, 6)
    }
}

private struct GoalsSection: View {
    var profile: UserProfile

    var body: some View {
        FormGroup("Goals") {
            ListCard {
                ListCardValueRow(title: "Pull-ups", value: "\(profile.goalPullUps)")
                ListCardRule()
                ListCardValueRow(title: "Push-ups", value: "\(profile.goalPushUps)")
                ListCardRule()
                ListCardValueRow(title: "Plank", value: format(seconds: profile.goalPlankSeconds))
                ListCardRule()
                ListCardValueRow(
                    title: "Target date",
                    value: profile.targetDate.formatted(.dateTime.day().month(.abbreviated).year())
                )
            }
        }
    }
}

private struct StrengthDaysSection: View {
    var profile: UserProfile
    var onScheduleChange: (Set<TrainingWeekday>) -> Void

    private var selectedDays: Binding<Set<TrainingWeekday>> {
        Binding(
            get: { profile.trainingDays },
            set: { onScheduleChange($0) }
        )
    }

    var body: some View {
        TrainingDaysPicker(selectedDays: selectedDays, title: "Strength days")
    }
}

private struct RaceGoalSection: View {
    var profile: UserProfile
    var raceGoal: RaceGoal?
    var hasConfirmedRuns: Bool = false
    var onCreateGoal: () -> Void
    var onRemoveGoal: () -> Void
    var onRunningDaysChange: (Set<TrainingWeekday>) -> Void
    var onLongRunDayChange: (TrainingWeekday) -> Void
    var onGoalChange: () -> Void

    var body: some View {
        FormGroup("Race goal") {
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
                VStack(alignment: .leading, spacing: 12) {
                    NoteText("Set a race goal to unlock the ultra coach. It plans your runs around the race and sends them to your watch.")
                    Button(action: onCreateGoal) {
                        Label("Set up running", systemImage: "figure.run")
                    }
                    .buttonStyle(SecondaryActionButtonStyle())
                    .accessibilityIdentifier("running-setup-button")
                }
            }
        }
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
            Signpost(
                eyebrow: "Race day, \(goal.raceDate.formatted(.dateTime.day().month(.abbreviated)))",
                title: goal.name.isEmpty ? "Race" : goal.name,
                trailing: raceCountdownText(goal.raceDate),
                grade: .mountain,
                size: .small
            )

            ListCard {
                ListCardRow {
                    Text("Race name")
                        .font(.lockinBody)
                        .foregroundStyle(AppTheme.text)
                    TextField("Race name", text: nameBinding)
                        .textInputAutocapitalization(.words)
                        .multilineTextAlignment(.trailing)
                        .font(.trail(16, .semibold, relativeTo: .body))
                        .foregroundStyle(AppTheme.text)
                        .tint(AppTheme.text)
                }
                ListCardRule()
                ListCardRow {
                    DatePicker("Race date", selection: raceDateBinding, displayedComponents: .date)
                        .font(.lockinBody)
                        .tint(AppTheme.text)
                }
                ListCardRule()
                ListCardRow {
                    IntegerField(title: "Distance", value: distanceBinding, range: 1...500, suffix: "km")
                }
                ListCardRule()
                ListCardRow {
                    IntegerField(title: "Climb", value: elevationBinding, range: 0...30_000, suffix: "m")
                }
                ListCardRule()
                if hasConfirmedRuns {
                    // Real run history owns these numbers; editable fields here
                    // would be silently overwritten on the next sync.
                    ListCardValueRow(title: "Weekly base", value: "\(Int(goal.baselineWeeklyKm.rounded())) km")
                    ListCardRule()
                    ListCardValueRow(title: "Longest recent run", value: "\(Int(goal.longestRecentRunKm.rounded())) km")
                } else {
                    ListCardRow {
                        IntegerField(title: "Weekly base", value: baselineWeeklyBinding, range: 0...300, suffix: "km")
                    }
                    ListCardRule()
                    ListCardRow {
                        IntegerField(title: "Longest recent run", value: longestRecentRunBinding, range: 0...200, suffix: "km")
                    }
                }
            }

            NoteText(hasConfirmedRuns
                ? "Weekly base and longest run update from your Garmin runs."
                : "Weekly base and longest run are starting estimates. Once runs sync from Garmin, they update themselves.")

            TrainingDaysPicker(
                selectedDays: runningDaysBinding,
                title: "Running days",
                minDays: 1,
                maxDays: 7,
                caption: "Pick the days you can run. The coach may leave some of them as rest days while you build.",
                preventsEmptySelection: true
            )
            .padding(.top, 6)

            if !orderedRunningDays.isEmpty {
                ListCard {
                    ListCardRow {
                        Text("Long run day")
                            .font(.lockinBody)
                            .foregroundStyle(AppTheme.text)
                        Spacer()
                        Picker("Long run day", selection: longRunDayBinding) {
                            ForEach(orderedRunningDays) { day in
                                Text(day.title).tag(day)
                            }
                        }
                        .pickerStyle(.menu)
                        .tint(AppTheme.text)
                        .labelsHidden()
                    }
                }
            }

            Button(role: .destructive, action: onRemoveGoal) {
                Text("Remove race goal")
                    .font(.trail(15, .semibold, relativeTo: .subheadline))
                    .foregroundStyle(AppTheme.markerRedText)
                    .frame(minHeight: 44)
            }
            .buttonStyle(.plain)
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

private struct GarminSection: View {
    var endpoint: String
    var userId: String
    var profile: UserProfile

    @Environment(\.modelContext) private var modelContext
    @AppStorage("coachModelID") private var selectedModelID = CoachModelCatalog.defaultModelID
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
        FormGroup("Garmin") {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .center, spacing: 12) {
                    Image(systemName: "applewatch")
                        .font(.system(size: 22, weight: .regular))
                        .foregroundStyle(AppTheme.text)
                        .frame(width: 28)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(statusText)
                            .font(.trail(16, .semibold, relativeTo: .body))
                            .foregroundStyle(needsAttention ? AppTheme.markerRedText : AppTheme.text)
                        Text(lastSyncText)
                            .font(.trail(13, .regular, relativeTo: .footnote))
                            .foregroundStyle(AppTheme.muted)
                    }
                    Spacer(minLength: 8)
                    if status?.displayState.isHealthy == true {
                        Label("Two-way", systemImage: "checkmark")
                            .font(.trail(12, .semibold, relativeTo: .caption1))
                            .foregroundStyle(Color.white)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 4)
                            .background(Capsule().fill(AppTheme.text))
                    }
                }
                .accessibilityElement(children: .combine)

                NoteText("Pulls sleep, HRV, body battery and runs. Sends planned runs to your watch.")

                if isConnected {
                    VStack(spacing: 10) {
                        if let connectedEmail = status?.connectedEmail, !connectedEmail.isEmpty {
                            InfoLine(title: "Account", value: connectedEmail)
                        }
                        InfoLine(
                            title: "Watch plan",
                            value: watchPlanText,
                            valueColor: watchSyncStatus?.status == .failed ? AppTheme.markerRedText : AppTheme.text
                        )
                    }
                    .padding(.vertical, 2)
                }

                if let watchError = watchSyncStatus?.lastError, !watchError.isEmpty {
                    NoteText(watchError, isError: watchSyncStatus?.status == .failed)
                }

                HStack(spacing: 8) {
                    if isConnected {
                        Button(action: syncNow) {
                            Text(isSyncing ? "Syncing" : "Sync now")
                        }
                        .buttonStyle(SecondaryActionButtonStyle())
                        .accessibilityIdentifier("garmin-sync-now")
                        .disabled(isSyncing)
                        .opacity(isSyncing ? 0.55 : 1)
                    } else {
                        Button(action: { isShowingConnectForm.toggle() }) {
                            Text(isShowingConnectForm ? "Cancel" : "Connect")
                        }
                        .buttonStyle(SecondaryActionButtonStyle())
                        .accessibilityIdentifier("garmin-connect-toggle")
                    }

                    Button(action: { isShowingTroubleshoot.toggle() }) {
                        Text("Troubleshoot")
                    }
                    .buttonStyle(QuietActionButtonStyle())
                    .accessibilityIdentifier("garmin-troubleshoot")
                }

                if isShowingConnectForm && !isConnected {
                    connectForm
                }

                if let syncResult {
                    NoteText(syncResult)
                }
                if let syncError {
                    NoteText(syncError, isError: true)
                }

                if shouldShowWatchRetry && isConnected {
                    Button(action: retryWatchSync) {
                        Label(isRetryingWatchSync ? "Retrying watch sync" : "Retry watch sync", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(SecondaryActionButtonStyle())
                    .accessibilityIdentifier("garmin-watch-sync-retry")
                    .disabled(isRetryingWatchSync)
                    .opacity(isRetryingWatchSync ? 0.55 : 1)
                }

                if let watchRetryStatus {
                    NoteText(watchRetryStatus)
                }
                if let connectMessage {
                    NoteText(connectMessage)
                }
                if let connectError {
                    NoteText(connectError, isError: true)
                }

                if isShowingTroubleshoot {
                    troubleshootPanel
                }
            }
            .card(padding: 14)
        }
        .task { await loadStatus() }
    }

    private var connectForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Garmin email", text: $garminEmail)
                .textInputAutocapitalization(.never)
                .keyboardType(.emailAddress)
                .font(.lockinBody)
                .tint(AppTheme.text)
                .lockinField()
                .accessibilityIdentifier("garmin-email-field")

            SecureField("Garmin password", text: $garminPassword)
                .font(.lockinBody)
                .tint(AppTheme.text)
                .lockinField()
                .accessibilityIdentifier("garmin-password-field")

            if shouldShowMFAField {
                TextField("MFA code", text: $garminMFACode)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.numberPad)
                    .font(.lockinBody)
                    .tint(AppTheme.text)
                    .lockinField()
                    .accessibilityIdentifier("garmin-mfa-field")
            }

            Button(action: connectGarmin) {
                Text(isConnecting ? "Connecting" : connectButtonTitle)
            }
            .buttonStyle(PrimaryActionButtonStyle())
            .accessibilityIdentifier("garmin-connect-submit")
            .disabled(isConnecting || garminEmail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || garminPassword.isEmpty)
            .opacity(isConnecting ? 0.55 : 1)
        }
    }

    private var troubleshootPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            Hairline()
            InfoLine(title: "Connection", value: statusText)
            if let lastError = status?.lastError, !lastError.isEmpty {
                NoteText(lastError, isError: true)
            } else if statusFailed {
                NoteText("Lockin could not reach the coach proxy.", isError: true)
            } else {
                NoteText("No errors reported.")
            }
            if isConnected {
                Button(role: .destructive, action: disconnectGarmin) {
                    Text(isDisconnecting ? "Disconnecting" : "Disconnect Garmin")
                        .font(.trail(15, .semibold, relativeTo: .subheadline))
                        .foregroundStyle(AppTheme.markerRedText)
                        .frame(minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("garmin-disconnect")
                .disabled(isDisconnecting)
                .opacity(isDisconnecting ? 0.55 : 1)
            }
        }
    }

    private var lastSyncText: String {
        garminLastSyncAt > 0 ? "Last sync \(relativeSyncText(epochSeconds: garminLastSyncAt))" : "Never synced"
    }

    /// Red only for states the athlete should act on; "Not connected" and
    /// "Checking" stay neutral.
    private var needsAttention: Bool {
        guard let status else { return statusFailed }
        return status.loggedIn ? !status.ok : status.state == .mfaRequired
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
                garminConnectionActive = true
                await refreshWorkoutReminders(in: modelContext)
                if ingested.completedRuns > 0 || ingested.partialRuns > 0 || ingested.importedRuns > 0 {
                    // Don't hold the "Sync now" result for the coach call.
                    Task {
                        await CoachReadRefresher.refresh(endpoint: endpoint, profile: profile, modelID: selectedModelID, in: modelContext)
                    }
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


private struct ReminderSection: View {
    var profile: UserProfile
    var onReminderToggle: (Bool) -> Void
    var onReminderTimeChange: (Date) -> Void

    var body: some View {
        FormGroup("Reminder") {
            ListCard {
                ListCardRow(minHeight: 54) {
                    Toggle("Training reminder", isOn: Binding(
                        get: { profile.remindersEnabled },
                        set: { newValue in
                            onReminderToggle(newValue)
                        }
                    ))
                    .font(.lockinBody)
                    .foregroundStyle(AppTheme.text)
                    .tint(AppTheme.text)
                }
                ListCardRule()
                ListCardRow {
                    DatePicker(
                        "Time",
                        selection: Binding(
                            get: { profile.reminderTime },
                            set: { onReminderTimeChange($0) }
                        ),
                        displayedComponents: .hourAndMinute
                    )
                    .font(.lockinBody)
                    .foregroundStyle(AppTheme.text)
                    .tint(AppTheme.text)
                    .accessibilityIdentifier("reminder-time-picker")
                }
            }
        }
    }
}

/// The restart that keeps history; "Wipe all app data" below is the one
/// that doesn't.
private struct NewPlanSection: View {
    var onStartTap: () -> Void

    var body: some View {
        FormGroup("New plan") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Want a fresh start? Redo your race, goals, numbers and training days, and the coach plans a new week. Your logs, runs, streaks and coach chat stay.")
                    .font(.trail(14, .regular, relativeTo: .subheadline))
                    .foregroundStyle(AppTheme.muted)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                Button(action: onStartTap) {
                    Text("Start a new plan")
                }
                .buttonStyle(PrimaryActionButtonStyle())
                .accessibilityIdentifier("start-new-plan-button")
            }
        }
    }
}

private struct DataSection: View {
    var resetError: String?
    var onResetTap: () -> Void

    var body: some View {
        FormGroup("Data") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Training data stays on this iPhone, with a private iCloud backup. Wiping deletes your profile, goals, race goal, sessions, logs, runs, streaks, coach history and pending reminders.")
                    .font(.trail(14, .regular, relativeTo: .subheadline))
                    .foregroundStyle(AppTheme.muted)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                Button(role: .destructive, action: onResetTap) {
                    Text("Wipe all app data")
                }
                .buttonStyle(SecondaryActionButtonStyle())
                if let resetError {
                    NoteText(resetError, isError: true)
                }
            }
        }
    }
}

#if DEBUG && targetEnvironment(simulator)
private struct DemoHistorySeedSection: View {
    var seedMessage: String?
    var seedError: String?
    var onSeedTap: () -> Void

    var body: some View {
        FormGroup("Demo data") {
            VStack(alignment: .leading, spacing: 12) {
                NoteText("Loads a fake two-week training block with strength logs, Garmin-style runs, readiness, a race goal and a coach read. Simulator builds only.")
                Button(action: onSeedTap) {
                    Text("Seed demo history")
                }
                .buttonStyle(QuietActionButtonStyle())
                .accessibilityIdentifier("seed-demo-history-button")

                if let seedMessage {
                    NoteText(seedMessage)
                }
                if let seedError {
                    NoteText(seedError, isError: true)
                }
            }
        }
    }
}
#endif
