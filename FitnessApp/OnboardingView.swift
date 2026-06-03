import SwiftData
import SwiftUI

struct OnboardingView: View {
    @Environment(\.modelContext) private var modelContext
    @State private var name = "Erwin"
    @State private var pullUps = 5
    @State private var pushUps = 20
    @State private var plankSeconds = 60
    @State private var goalPullUps = 50
    @State private var goalPushUps = 100
    @State private var goalPlankSeconds = 300
    @State private var selectedTrainingDays: Set<TrainingWeekday> = TrainingWeekday.defaultTrainingDays(for: 4)
    @State private var selectedRunningDays: Set<TrainingWeekday> = TrainingWeekday.defaultTrainingDays(for: 4)
    @State private var targetDate = Calendar.current.date(byAdding: .year, value: 1, to: Date()) ?? Date()
    @State private var targetRaceName = "Comrades Marathon"
    @State private var raceDate = Calendar.current.date(byAdding: .month, value: 10, to: Date()) ?? Date()
    @State private var weeklyDistanceTarget = 42
    @State private var longRunTarget = 28
    @State private var selectedEquipment: Set<EquipmentKind> = [.pullUpBar, .yogaMat]
    @State private var strictForm = true
    @State private var painNotes = ""

    private var canCreateProfile: Bool {
            strictForm &&
            (2...6).contains(selectedTrainingDays.count) &&
            (3...5).contains(selectedRunningDays.count) &&
            !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !targetRaceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            selectedEquipment.contains(.pullUpBar)
    }

    var body: some View {
        NavigationStack {
            ScreenBackground {
                VStack(alignment: .leading, spacing: 16) {
                    BrandHeader(subtitle: "A calm training notebook for strength, running, consistency, and coach feedback.")

                    Text("LOCKED IN")
                        .font(.system(size: 38, weight: .semibold, design: .serif))
                        .foregroundStyle(AppTheme.forest)
                    Rectangle()
                        .fill(AppTheme.olive)
                        .frame(width: 44, height: 3)
                }
                .padding(.top, 18)

                IdentityCard(name: $name)

                StrengthStartCard(
                    pullUps: $pullUps,
                    pushUps: $pushUps,
                    plankSeconds: $plankSeconds
                )

                StrengthGoalCard(
                    goalPullUps: $goalPullUps,
                    goalPushUps: $goalPushUps,
                    goalPlankSeconds: $goalPlankSeconds,
                    selectedTrainingDays: $selectedTrainingDays,
                    targetDate: $targetDate
                )

                RunningSetupCard(
                    targetRaceName: $targetRaceName,
                    raceDate: $raceDate,
                    weeklyDistanceTarget: $weeklyDistanceTarget,
                    longRunTarget: $longRunTarget,
                    selectedRunningDays: $selectedRunningDays
                )

                EquipmentSetupCard(selectedEquipment: $selectedEquipment)

                GuardrailsSetupCard(strictForm: $strictForm, painNotes: $painNotes)

                PrimaryActionButton(title: "Create profile", systemImage: "checkmark") {
                    completeOnboarding()
                }
                .disabled(!canCreateProfile)
                .opacity(canCreateProfile ? 1 : 0.48)
            }
            .navigationBarHidden(true)
        }
    }

    private func completeOnboarding() {
        guard canCreateProfile else { return }

        let profile = UserProfile(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
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
        modelContext.insert(RunningProfile(
            targetRaceName: targetRaceName.trimmingCharacters(in: .whitespacesAndNewlines),
            raceDate: raceDate,
            weeklyDistanceTargetKm: Double(weeklyDistanceTarget),
            longRunTargetKm: Double(longRunTarget),
            easyPaceSecondsPerKm: 360,
            preferredTerrain: "Road and trail",
            injuryNotes: painNotes,
            runningDays: selectedRunningDays
        ))
        let rank = RankState()
        modelContext.insert(rank)
        for kind in LockinAchievementKind.allCases {
            modelContext.insert(AchievementState(kind: kind))
        }
        try? modelContext.save()
    }
}

private struct IdentityCard: View {
    @Binding var name: String

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Athlete")
                TextField("Name", text: $name)
                    .textInputAutocapitalization(.words)
                    .textFieldStyle(.roundedBorder)
            }
        }
    }
}

private struct StrengthStartCard: View {
    @Binding var pullUps: Int
    @Binding var pushUps: Int
    @Binding var plankSeconds: Int

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 14) {
                SectionLabel(text: "Strength baseline")
                IntegerField(title: "Current pull-up max", value: $pullUps, range: 0...100)
                IntegerField(title: "Current push-up max", value: $pushUps, range: 0...300)
                IntegerField(title: "Current plank max", value: $plankSeconds, range: 0...1_800, suffix: "sec")
            }
        }
    }
}

private struct StrengthGoalCard: View {
    @Binding var goalPullUps: Int
    @Binding var goalPushUps: Int
    @Binding var goalPlankSeconds: Int
    @Binding var selectedTrainingDays: Set<TrainingWeekday>
    @Binding var targetDate: Date

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 14) {
                SectionLabel(text: "Strength targets")
                IntegerField(title: "Target pull-ups", value: $goalPullUps, range: 1...300)
                IntegerField(title: "Target push-ups", value: $goalPushUps, range: 1...500)
                IntegerField(title: "Target plank", value: $goalPlankSeconds, range: 10...3_600, suffix: "sec")
                Divider()
                TrainingDaysPicker(title: "Training days", selectedDays: $selectedTrainingDays, validRange: 2...6)
                DatePicker("Target date", selection: $targetDate, displayedComponents: .date)
                    .font(.system(size: 14, weight: .medium))
            }
        }
    }
}

private struct TrainingDaysPicker: View {
    var title: String
    @Binding var selectedDays: Set<TrainingWeekday>
    var validRange: ClosedRange<Int>

    private var selectedSummary: String {
        let count = selectedDays.count
        return count == 1 ? "1 training day" : "\(count) training days"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(AppTheme.textPrimary)
                Spacer()
                Text(selectedSummary)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(validRange.contains(selectedDays.count) ? AppTheme.textSecondary : AppTheme.danger)
            }

            HStack(spacing: 6) {
                ForEach(TrainingWeekday.allCases) { weekday in
                    TrainingDayCircle(
                        weekday: weekday,
                        isSelected: selectedDays.contains(weekday),
                        isDisabled: !selectedDays.contains(weekday) && selectedDays.count >= validRange.upperBound
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
        } else if selectedDays.count < validRange.upperBound {
            selectedDays.insert(weekday)
        }
    }
}

private struct TrainingDayCircle: View {
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
                .background(
                    Circle()
                        .fill(isSelected ? AppTheme.forest : AppTheme.surfaceWarm)
                )
                .overlay(
                    Circle()
                        .stroke(isSelected ? AppTheme.forest : AppTheme.borderStrong, lineWidth: 1)
                )
                .opacity(isDisabled ? 0.42 : 1)
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .accessibilityLabel(weekday.title)
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
    }
}

private struct RunningSetupCard: View {
    @Binding var targetRaceName: String
    @Binding var raceDate: Date
    @Binding var weeklyDistanceTarget: Int
    @Binding var longRunTarget: Int
    @Binding var selectedRunningDays: Set<TrainingWeekday>

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 14) {
                SectionLabel(text: "Running profile")
                TextField("Target race", text: $targetRaceName)
                    .textInputAutocapitalization(.words)
                    .textFieldStyle(.roundedBorder)
                DatePicker("Race date", selection: $raceDate, displayedComponents: .date)
                    .font(.system(size: 14, weight: .medium))
                IntegerField(title: "Weekly distance target", value: $weeklyDistanceTarget, range: 0...250, suffix: "km")
                IntegerField(title: "Long-run target", value: $longRunTarget, range: 0...100, suffix: "km")
                Divider()
                TrainingDaysPicker(title: "Running days", selectedDays: $selectedRunningDays, validRange: 3...5)
            }
        }
    }
}

private struct EquipmentSetupCard: View {
    @Binding var selectedEquipment: Set<EquipmentKind>

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Equipment")
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
                    .tint(AppTheme.forest)
                }
            }
        }
    }
}

private struct GuardrailsSetupCard: View {
    @Binding var strictForm: Bool
    @Binding var painNotes: String

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Guardrails")
                Toggle("Only count strict valid reps and holds", isOn: $strictForm)
                    .tint(AppTheme.forest)
                TextField("Pain, injury, or limitation notes", text: $painNotes, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
            }
        }
    }
}
