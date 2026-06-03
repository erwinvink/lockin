import SwiftData
import SwiftUI

struct SettingsView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query(sort: \RunningProfile.createdAt) private var runningProfiles: [RunningProfile]
    @Query private var ranks: [RankState]
    @State private var notificationStatus = "Not requested"
    @State private var isShowingResetConfirmation = false
    @State private var resetError: String?
    @State private var isEditingStrength = false
    @State private var isEditingRunning = false

    var profile: UserProfile

    private var rank: RankState { ranks.first ?? RankState() }
    private var runningProfile: RunningProfile {
        runningProfiles.first ?? RunningProfile(
            targetRaceName: "Comrades Marathon",
            raceDate: Calendar.current.date(byAdding: .month, value: 10, to: Date()) ?? Date(),
            weeklyDistanceTargetKm: 42,
            longRunTargetKm: 28
        )
    }

    var body: some View {
        NavigationStack {
            ScreenBackground(
                title: "Profile",
                trailing: AnyView(Button { } label: {
                    Image(systemName: "gearshape")
                        .frame(width: 44, height: 44)
                        .foregroundStyle(AppTheme.textPrimary)
                }.buttonStyle(.plain))
            ) {
                AthleteCard(profile: profile, rank: rank)
                StrengthTargetsProfileCard(profile: profile, logs: logs, onEdit: { isEditingStrength = true })
                RunningProfileCard(profile: runningProfile, onEdit: { isEditingRunning = true })
                EquipmentProfileCard(profile: profile)
                InjuryNotesCard(profile: profile)
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
            .sheet(isPresented: $isEditingStrength) {
                StrengthTargetsEditView(profile: profile)
            }
            .sheet(isPresented: $isEditingRunning) {
                RunningProfileEditView(profile: runningProfile)
            }
            .alert("Wipe all app data?", isPresented: $isShowingResetConfirmation) {
                Button("Cancel", role: .cancel) {}
                Button("Wipe everything", role: .destructive, action: resetAllData)
            } message: {
                Text("This removes every measurement, workout, log, consistency, achievement, running, and coach record from the app.")
            }
            .onAppear(perform: ensureRunningProfile)
        }
    }

    private func ensureRunningProfile() {
        guard runningProfiles.isEmpty else { return }
        modelContext.insert(runningProfile)
        try? modelContext.save()
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

private struct AthleteCard: View {
    var profile: UserProfile
    var rank: RankState

    var body: some View {
        LockinCard {
            HStack(spacing: 14) {
                AvatarCircle(initials: initials(from: profile.name), size: 54)
                VStack(alignment: .leading, spacing: 4) {
                    Text(profile.name)
                        .font(.system(size: 18, weight: .semibold))
                    Text("Endurance-minded Athlete")
                        .font(.system(size: 12))
                        .foregroundStyle(AppTheme.textSecondary)
                }
                Spacer()
                Text("\(rank.streak)d streak")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(AppTheme.forest)
            }
        }
    }
}

private struct StrengthTargetsProfileCard: View {
    var profile: UserProfile
    var logs: [PerformanceLog]
    var onEdit: () -> Void

    private var latestPullUps: Int { logs.first(where: { $0.loggedPullUps })?.pullUps ?? profile.baselinePullUps }
    private var latestPushUps: Int { logs.first(where: { $0.loggedPushUps })?.pushUps ?? profile.baselinePushUps }
    private var latestPlankSeconds: Int { logs.first(where: { $0.loggedPlankSeconds })?.plankSeconds ?? profile.baselinePlankSeconds }

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    SectionLabel(text: "Strength Targets")
                    Spacer()
                    Button("Edit", action: onEdit)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(AppTheme.forest)
                }
                TargetProgressRow(title: "Pull-ups", current: latestPullUps, goal: profile.goalPullUps, valueText: "\(latestPullUps) / \(profile.goalPullUps)")
                TargetProgressRow(title: "Push-ups", current: latestPushUps, goal: profile.goalPushUps, valueText: "\(latestPushUps) / \(profile.goalPushUps)")
                TargetProgressRow(title: "Plank", current: latestPlankSeconds, goal: profile.goalPlankSeconds, valueText: "\(format(seconds: latestPlankSeconds)) / \(format(seconds: profile.goalPlankSeconds))")
            }
        }
    }
}

private struct TargetProgressRow: View {
    var title: String
    var current: Int
    var goal: Int
    var valueText: String

    private var progress: Double {
        min(1, max(0, Double(current) / Double(max(goal, 1))))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(title)
                    .font(.system(size: 13))
                Spacer()
                Text(valueText)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(AppTheme.textSecondary)
            }
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(AppTheme.border)
                    Capsule()
                        .fill(AppTheme.olive)
                        .frame(width: proxy.size.width * progress)
                }
            }
            .frame(height: 4)
        }
    }
}

private struct RunningProfileCard: View {
    var profile: RunningProfile
    var onEdit: () -> Void

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    SectionLabel(text: "Running Profile")
                    Spacer()
                    Button("Edit", action: onEdit)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(AppTheme.forest)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(profile.targetRaceName)
                        .font(.system(size: 17, weight: .semibold))
                    Text(profile.raceDate.formatted(date: .abbreviated, time: .omitted))
                        .font(.system(size: 12))
                        .foregroundStyle(AppTheme.textSecondary)
                    HStack {
                        MetricPill(title: "Weekly target", value: "\(format(kilometers: profile.weeklyDistanceTargetKm)) km", color: AppTheme.blueRunning)
                        MetricPill(title: "Long run", value: "\(format(kilometers: profile.longRunTargetKm)) km", color: AppTheme.olive)
                    }
                    MetricPill(title: "Running days", value: profile.runningDayLabels.joined(separator: ", "), color: AppTheme.forest)
                }
            }
        }
    }
}

private struct EquipmentProfileCard: View {
    var profile: UserProfile

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Equipment")
                let equipment = profile.equipment.sorted { $0.title < $1.title }
                if equipment.isEmpty {
                    Text("No equipment saved.")
                        .font(.system(size: 14))
                        .foregroundStyle(AppTheme.textSecondary)
                } else {
                    ForEach(equipment) { item in
                        Label(item.title, systemImage: "checkmark.circle")
                            .font(.system(size: 14))
                            .foregroundStyle(AppTheme.textPrimary)
                    }
                }
            }
        }
    }
}

private struct InjuryNotesCard: View {
    var profile: UserProfile

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Injury & Notes")
                Text(profile.painNotes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "No injury notes saved." : profile.painNotes)
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.textSecondary)
            }
        }
    }
}

private struct ReminderSettingsCard: View {
    var profile: UserProfile
    var sessions: [WorkoutSession]
    var notificationStatus: String
    var onReminderToggle: (Bool) -> Void
    var onStatusChange: (String) -> Void

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Reminders")
                Toggle("Strict reminders", isOn: Binding(
                    get: { profile.remindersEnabled },
                    set: { onReminderToggle($0) }
                ))
                .tint(AppTheme.forest)

                SecondaryButton(title: "Request and schedule", systemImage: "bell", action: scheduleReminders)
                InfoLine(title: "Status", value: notificationStatus)
            }
        }
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
        LockinCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Data & Reset")
                Text("Deletes profile, measurements, goals, sessions, logs, running, consistency, achievements, coach plans, and pending workout reminders.")
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
                Button(role: .destructive, action: onResetTap) {
                    Label("Wipe all app data", systemImage: "trash")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryActionButtonStyle())
                if let resetError {
                    Text(resetError)
                        .font(.caption)
                        .foregroundStyle(AppTheme.danger)
                }
            }
        }
    }
}

private struct StrengthTargetsEditView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    var profile: UserProfile
    @State private var pullUps: Int
    @State private var pushUps: Int
    @State private var plankSeconds: Int

    init(profile: UserProfile) {
        self.profile = profile
        _pullUps = State(initialValue: profile.goalPullUps)
        _pushUps = State(initialValue: profile.goalPushUps)
        _plankSeconds = State(initialValue: profile.goalPlankSeconds)
    }

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "Strength Targets") {
                LockinCard {
                    VStack(alignment: .leading, spacing: 14) {
                        IntegerField(title: "Pull-ups", value: $pullUps, range: 1...300)
                        IntegerField(title: "Push-ups", value: $pushUps, range: 1...500)
                        IntegerField(title: "Plank", value: $plankSeconds, range: 10...3_600, suffix: "sec")
                    }
                }
                PrimaryActionButton(title: "Save targets", systemImage: "checkmark") {
                    profile.goalPullUps = pullUps
                    profile.goalPushUps = pushUps
                    profile.goalPlankSeconds = plankSeconds
                    try? modelContext.save()
                    dismiss()
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

private struct RunningProfileEditView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    var profile: RunningProfile
    @State private var raceName: String
    @State private var raceDate: Date
    @State private var weeklyDistance: Int
    @State private var longRun: Int
    @State private var selectedRunningDays: Set<TrainingWeekday>

    init(profile: RunningProfile) {
        self.profile = profile
        _raceName = State(initialValue: profile.targetRaceName)
        _raceDate = State(initialValue: profile.raceDate)
        _weeklyDistance = State(initialValue: Int(profile.weeklyDistanceTargetKm))
        _longRun = State(initialValue: Int(profile.longRunTargetKm))
        _selectedRunningDays = State(initialValue: profile.runningDays)
    }

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "Running Profile") {
                LockinCard {
                    VStack(alignment: .leading, spacing: 14) {
                        TextField("Target race", text: $raceName)
                            .textFieldStyle(.roundedBorder)
                        DatePicker("Race date", selection: $raceDate, displayedComponents: .date)
                        IntegerField(title: "Weekly distance", value: $weeklyDistance, range: 0...250, suffix: "km")
                        IntegerField(title: "Long run", value: $longRun, range: 0...100, suffix: "km")
                        Divider()
                        SettingsTrainingDaysPicker(selectedDays: $selectedRunningDays)
                    }
                }
                PrimaryActionButton(title: "Save running profile", systemImage: "checkmark") {
                    profile.targetRaceName = raceName
                    profile.raceDate = raceDate
                    profile.weeklyDistanceTargetKm = Double(weeklyDistance)
                    profile.longRunTargetKm = Double(longRun)
                    profile.runningDays = selectedRunningDays
                    try? modelContext.save()
                    dismiss()
                }
                .disabled(!(3...5).contains(selectedRunningDays.count))
                .opacity((3...5).contains(selectedRunningDays.count) ? 1 : 0.48)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

private struct SettingsTrainingDaysPicker: View {
    @Binding var selectedDays: Set<TrainingWeekday>

    private var selectedSummary: String {
        selectedDays.count == 1 ? "1 running day" : "\(selectedDays.count) running days"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Running days")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(AppTheme.textPrimary)
                Spacer()
                Text(selectedSummary)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle((3...5).contains(selectedDays.count) ? AppTheme.textSecondary : AppTheme.danger)
            }

            HStack(spacing: 6) {
                ForEach(TrainingWeekday.allCases) { weekday in
                    SettingsTrainingDayCircle(
                        weekday: weekday,
                        isSelected: selectedDays.contains(weekday),
                        isDisabled: !selectedDays.contains(weekday) && selectedDays.count >= 5
                    ) {
                        toggle(weekday)
                    }
                }
            }
        }
    }

    private func toggle(_ weekday: TrainingWeekday) {
        if selectedDays.contains(weekday) {
            selectedDays.remove(weekday)
        } else if selectedDays.count < 5 {
            selectedDays.insert(weekday)
        }
    }
}

private struct SettingsTrainingDayCircle: View {
    var weekday: TrainingWeekday
    var isSelected: Bool
    var isDisabled: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(weekday.shortTitle)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(isSelected ? AppTheme.primaryButtonForeground : AppTheme.textSecondary)
                .frame(width: 34, height: 34)
                .background(Circle().fill(isSelected ? AppTheme.forest : AppTheme.surfaceWarm))
                .overlay(Circle().stroke(isSelected ? AppTheme.forest : AppTheme.borderStrong, lineWidth: 1))
                .opacity(isDisabled ? 0.42 : 1)
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .accessibilityLabel(weekday.title)
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
    }
}

private func initials(from name: String) -> String {
    let parts = name.split(separator: " ")
    let first = parts.first?.prefix(1) ?? "A"
    let second = parts.dropFirst().first?.prefix(1) ?? ""
    return "\(first)\(second)".uppercased()
}
