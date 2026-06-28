import SwiftData
import SwiftUI

struct OnboardingView: View {
    @Environment(\.modelContext) private var modelContext
    @State private var name = LockinCurrentUser.displayName
    @State private var pullUps = 5
    @State private var pushUps = 20
    @State private var plankSeconds = 60
    @State private var goalPullUps = 50
    @State private var goalPushUps = 100
    @State private var goalPlankSeconds = 300
    @State private var selectedTrainingDays: Set<TrainingWeekday> = TrainingWeekday.defaultTrainingDays(for: 4)
    @State private var targetDate = Calendar.current.date(byAdding: .year, value: 1, to: Date()) ?? Date()
    @State private var selectedEquipment: Set<EquipmentKind> = [.pullUpBar, .yogaMat]
    @State private var strictForm = true
    @State private var painNotes = ""
    @State private var isTrainingForRace = false
    @State private var raceName = ""
    @State private var raceDate = Calendar.current.date(byAdding: .weekOfYear, value: 16, to: Date()) ?? Date()
    @State private var raceDistanceKm = 50
    @State private var raceElevationGainM = 1000
    @State private var runningDays: Set<TrainingWeekday> = [.tuesday, .thursday, .saturday]
    @State private var longRunDay: TrainingWeekday = .saturday

    private var canCreateProfile: Bool {
        strictForm &&
        selectedEquipment.contains(.pullUpBar) &&
        (2...6).contains(selectedTrainingDays.count) &&
        (!isTrainingForRace || !runningDays.isEmpty)
    }

    var body: some View {
        NavigationStack {
            ScreenBackground {
                BrandHeader(subtitle: "Exact work. Visible standards.")
                    .padding(.top, 18)

                MeasurementCard(
                    name: $name,
                    pullUps: $pullUps,
                    pushUps: $pushUps,
                    plankSeconds: $plankSeconds
                )

                // Race-first athlete: the running block comes right after the
                // measurements, before strength goal targets.
                RaceGoalCard(
                    isTrainingForRace: $isTrainingForRace,
                    raceName: $raceName,
                    raceDate: $raceDate,
                    raceDistanceKm: $raceDistanceKm,
                    raceElevationGainM: $raceElevationGainM,
                    runningDays: $runningDays,
                    longRunDay: $longRunDay
                )

                GoalTargetCard(
                    goalPullUps: $goalPullUps,
                    goalPushUps: $goalPushUps,
                    goalPlankSeconds: $goalPlankSeconds
                )

                ScheduleCard(
                    targetDate: $targetDate,
                    selectedTrainingDays: $selectedTrainingDays
                )

                EquipmentCard(selectedEquipment: $selectedEquipment)

                GuardrailsCard(
                    strictForm: $strictForm,
                    painNotes: $painNotes
                )

                Button(action: completeOnboarding) {
                    Label("Create profile", systemImage: "checkmark.circle.fill")
                }
                .buttonStyle(PrimaryActionButtonStyle())
                .disabled(!canCreateProfile)
            }
            .navigationTitle("Setup")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func completeOnboarding() {
        let profile = UserProfile(
            name: LockinCurrentUser.normalizedProfileName(name),
            targetDate: targetDate,
            weeklySessions: selectedTrainingDays.count,
            trainingDays: selectedTrainingDays,
            equipment: selectedEquipment,
            baselinePullUps: pullUps,
            baselinePushUps: pushUps,
            baselinePlankSeconds: plankSeconds,
            goalPullUps: goalPullUps,
            goalPushUps: goalPushUps,
            goalPlankSeconds: goalPlankSeconds,
            strictFormAccepted: strictForm,
            painNotes: painNotes
        )
        modelContext.insert(profile)
        modelContext.insert(RankState())
        if isTrainingForRace {
            modelContext.insert(
                RaceGoal(
                    name: raceName,
                    raceDate: raceDate,
                    distanceKm: Double(raceDistanceKm),
                    elevationGainM: raceElevationGainM
                )
            )
            profile.runningDays = runningDays
            profile.longRunDay = runningDays.contains(longRunDay)
                ? longRunDay
                : TrainingWeekday.allCases.last { runningDays.contains($0) }
        }
        try? modelContext.save()
    }
}

private struct MeasurementCard: View {
    @Binding var name: String
    @Binding var pullUps: Int
    @Binding var pushUps: Int
    @Binding var plankSeconds: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader("Start measurement")
            TextField("Name", text: $name)
                .textInputAutocapitalization(.words)
                .font(.subheadline)
                .lockinField()
            IntegerField(title: "Current pull-up max", value: $pullUps, range: 0...100)
            IntegerField(title: "Current push-up max", value: $pushUps, range: 0...300)
            IntegerField(title: "Current plank max", value: $plankSeconds, range: 0...1_800, suffix: "sec")
        }
        .ruled(verticalPadding: 16)
    }
}

private struct GoalTargetCard: View {
    @Binding var goalPullUps: Int
    @Binding var goalPushUps: Int
    @Binding var goalPlankSeconds: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader("Goal targets")
            IntegerField(title: "Target pull-ups", value: $goalPullUps, range: 1...300)
            IntegerField(title: "Target push-ups", value: $goalPushUps, range: 1...500)
            IntegerField(title: "Target plank", value: $goalPlankSeconds, range: 10...3_600, suffix: "sec")
        }
        .ruled(verticalPadding: 16)
    }
}

private struct RaceGoalCard: View {
    @Binding var isTrainingForRace: Bool
    @Binding var raceName: String
    @Binding var raceDate: Date
    @Binding var raceDistanceKm: Int
    @Binding var raceElevationGainM: Int
    @Binding var runningDays: Set<TrainingWeekday>
    @Binding var longRunDay: TrainingWeekday

    private var orderedRunningDays: [TrainingWeekday] {
        TrainingWeekday.allCases.filter { runningDays.contains($0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader("Running")
            Toggle("I'm also training for a race", isOn: $isTrainingForRace.animation(.smooth(duration: 0.3)))
                .font(.subheadline.weight(.medium))
                .tint(AppTheme.accent)
            if isTrainingForRace {
                TextField("Race name", text: $raceName)
                    .textInputAutocapitalization(.words)
                    .font(.subheadline)
                    .lockinField()
                DatePicker("Race date", selection: $raceDate, displayedComponents: .date)
                    .font(.subheadline.weight(.medium))
                    .tint(AppTheme.accent)
                IntegerField(title: "Distance", value: $raceDistanceKm, range: 1...500, suffix: "km")
                IntegerField(title: "Elevation gain", value: $raceElevationGainM, range: 0...30_000, suffix: "m+")
                TrainingDaysPicker(
                    selectedDays: $runningDays,
                    title: "Available running days",
                    minDays: 1,
                    maxDays: 7,
                    caption: "Pick the days you can run. The coach may leave rest days open while you build."
                )
                if !orderedRunningDays.isEmpty {
                    HStack {
                        Text("Long run day")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(AppTheme.text)
                        Spacer()
                        Picker("Long run day", selection: $longRunDay) {
                            ForEach(orderedRunningDays) { day in
                                Text(day.title).tag(day)
                            }
                        }
                        .pickerStyle(.menu)
                        .tint(AppTheme.accent)
                        .labelsHidden()
                    }
                }
            }
        }
        .ruled(verticalPadding: 16)
        .onChange(of: runningDays) { _, newDays in
            guard !newDays.isEmpty, !newDays.contains(longRunDay) else { return }
            if let fallback = TrainingWeekday.allCases.last(where: { newDays.contains($0) }) {
                longRunDay = fallback
            }
        }
    }
}

private struct ScheduleCard: View {
    @Binding var targetDate: Date
    @Binding var selectedTrainingDays: Set<TrainingWeekday>

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader("Training shape")
            DatePicker("Target date", selection: $targetDate, displayedComponents: .date)
                .font(.subheadline.weight(.medium))
                .tint(AppTheme.accent)
            TrainingDaysPicker(selectedDays: $selectedTrainingDays)
            Text("Session length follows the generated prescription for that week.")
                .font(.system(size: 12))
                .foregroundStyle(AppTheme.faint)
        }
        .ruled(verticalPadding: 16)
    }
}

struct TrainingDaysPicker: View {
    @Binding var selectedDays: Set<TrainingWeekday>
    var title: String = "Training days"
    var minDays: Int = 2
    var maxDays: Int = 6
    var caption: String? = "Pick 2 to 6 days. The AI coach will only schedule future sessions on those selected days."
    var preventsEmptySelection: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(selectedDays.count) per week")
                    .font(.caption.weight(.medium))
                    .foregroundStyle((minDays...maxDays).contains(selectedDays.count) ? AppTheme.muted : AppTheme.warning)
            }
            HStack(spacing: 6) {
                ForEach(TrainingWeekday.allCases) { day in
                    let isSelected = selectedDays.contains(day)
                    Button {
                        toggle(day)
                    } label: {
                        Text(day.shortTitle)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(isSelected ? AppTheme.accentInk : AppTheme.muted)
                            .frame(maxWidth: .infinity)
                            .frame(height: 36)
                            .background(isSelected ? AppTheme.accent : AppTheme.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                                    .strokeBorder(isSelected ? .clear : AppTheme.divider, lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                    .disabled(isToggleDisabled(for: day))
                    .animation(.snappy(duration: 0.2), value: isSelected)
                    .sensoryFeedback(.selection, trigger: isSelected)
                }
            }
            if let caption {
                Text(caption)
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.faint)
            }
        }
    }

    private func isToggleDisabled(for day: TrainingWeekday) -> Bool {
        if selectedDays.contains(day) {
            return preventsEmptySelection && selectedDays.count <= 1
        }
        return selectedDays.count >= maxDays
    }

    private func toggle(_ day: TrainingWeekday) {
        if selectedDays.contains(day) {
            guard !(preventsEmptySelection && selectedDays.count <= 1) else { return }
            selectedDays.remove(day)
        } else if selectedDays.count < maxDays {
            selectedDays.insert(day)
        }
    }
}

private struct EquipmentCard: View {
    @Binding var selectedEquipment: Set<EquipmentKind>

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader("Equipment")
            ForEach(EquipmentKind.allCases) { item in
                Toggle(item.title, isOn: Binding(
                    get: { selectedEquipment.contains(item) },
                    set: { isOn in
                        if isOn {
                            selectedEquipment.insert(item)
                        } else {
                            selectedEquipment.remove(item)
                        }
                    }
                ))
                .font(.subheadline.weight(.medium))
                .tint(AppTheme.accent)
            }
        }
        .ruled(verticalPadding: 16)
    }
}

private struct GuardrailsCard: View {
    @Binding var strictForm: Bool
    @Binding var painNotes: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Toggle("Only count strict valid reps and holds", isOn: $strictForm)
                .font(.subheadline.weight(.medium))
                .tint(AppTheme.accent)
            TextField("Pain, injury, or limitation notes", text: $painNotes, axis: .vertical)
                .font(.subheadline)
                .lockinField()
        }
        .ruled(verticalPadding: 16)
    }
}
