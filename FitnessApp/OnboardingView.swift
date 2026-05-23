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
    @State private var weeklySessions = 4
    @State private var targetDate = Calendar.current.date(byAdding: .year, value: 1, to: Date()) ?? Date()
    @State private var selectedEquipment: Set<EquipmentKind> = [.pullUpBar, .yogaMat]
    @State private var strictForm = true
    @State private var painNotes = ""

    var body: some View {
        NavigationStack {
            ScreenBackground {
                BrandHeader(subtitle: "Strict calisthenics goals. Exact work. Visible standards.")
                    .padding(.top, 18)

                MeasurementCard(
                    name: $name,
                    pullUps: $pullUps,
                    pushUps: $pushUps,
                    plankSeconds: $plankSeconds
                )

                GoalTargetCard(
                    goalPullUps: $goalPullUps,
                    goalPushUps: $goalPushUps,
                    goalPlankSeconds: $goalPlankSeconds
                )

                ScheduleCard(
                    targetDate: $targetDate,
                    weeklySessions: $weeklySessions
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
                .disabled(!strictForm || !selectedEquipment.contains(.pullUpBar))
                .opacity(strictForm && selectedEquipment.contains(.pullUpBar) ? 1 : 0.48)
            }
            .navigationTitle("Setup")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(AppTheme.background, for: .navigationBar)
        }
    }

    private func completeOnboarding() {
        let profile = UserProfile(
            name: name.isEmpty ? "Athlete" : name,
            targetDate: targetDate,
            weeklySessions: weeklySessions,
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
            Text("Start measurement")
                .font(.headline)
            TextField("Name", text: $name)
                .textInputAutocapitalization(.words)
                .textFieldStyle(.roundedBorder)
            IntegerField(title: "Current pull-up max", value: $pullUps, range: 0...100)
            IntegerField(title: "Current push-up max", value: $pushUps, range: 0...300)
            IntegerField(title: "Current plank max", value: $plankSeconds, range: 0...1_800, suffix: "sec")
        }
        .card()
    }
}

private struct GoalTargetCard: View {
    @Binding var goalPullUps: Int
    @Binding var goalPushUps: Int
    @Binding var goalPlankSeconds: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Goal targets")
                .font(.headline)
            IntegerField(title: "Target pull-ups", value: $goalPullUps, range: 1...300)
            IntegerField(title: "Target push-ups", value: $goalPushUps, range: 1...500)
            IntegerField(title: "Target plank", value: $goalPlankSeconds, range: 10...3_600, suffix: "sec")
        }
        .card()
    }
}

private struct ScheduleCard: View {
    @Binding var targetDate: Date
    @Binding var weeklySessions: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Training shape")
                .font(.headline)
            DatePicker("Target date", selection: $targetDate, displayedComponents: .date)
            IntegerField(title: "Sessions per week", value: $weeklySessions, range: 2...6)
            Text("Session length follows the generated prescription for that week.")
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
        }
        .card()
    }
}

private struct EquipmentCard: View {
    @Binding var selectedEquipment: Set<EquipmentKind>

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Equipment")
                .font(.headline)
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
                .tint(AppTheme.accent)
            }
        }
        .card()
    }
}

private struct GuardrailsCard: View {
    @Binding var strictForm: Bool
    @Binding var painNotes: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Toggle("Only count strict valid reps and holds", isOn: $strictForm)
                .tint(AppTheme.accent)
            TextField("Pain, injury, or limitation notes", text: $painNotes, axis: .vertical)
                .textFieldStyle(.roundedBorder)
        }
        .card()
    }
}
