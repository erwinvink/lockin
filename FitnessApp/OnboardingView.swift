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
    @State private var targetRaceDate = Calendar.current.date(byAdding: .year, value: 2, to: Date()) ?? Date()
    @State private var targetRaceKm = 160
    @State private var weeklyRunSessions = 4
    @State private var currentWeeklyDistanceKm = 25
    @State private var currentLongRunKm = 10
    @State private var easyPaceSecondsPerKm = 420
    @State private var easyHeartRate = 140
    @State private var thresholdHeartRate = 165
    @State private var runningBackground = RunningBackground.triathleteIronman
    @State private var runningDurability = RunningDurability.fragile
    @State private var runningTerrain = RunningTerrain.mixed
    @State private var walkStrategy = WalkStrategy.climbsOnly
    @State private var runWalkStrategy = "Walk climbs early to keep heart rate controlled."
    @State private var runningInjuryNotes = ""

    var body: some View {
        NavigationStack {
            ScreenBackground {
                BrandHeader(subtitle: "One athlete profile for strength, running, and the coaches that adapt around both.")
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

                UltraRunnerSetupCard(
                    targetRaceDate: $targetRaceDate,
                    targetRaceKm: $targetRaceKm,
                    weeklyRunSessions: $weeklyRunSessions,
                    currentWeeklyDistanceKm: $currentWeeklyDistanceKm,
                    currentLongRunKm: $currentLongRunKm,
                    easyPaceSecondsPerKm: $easyPaceSecondsPerKm,
                    easyHeartRate: $easyHeartRate,
                    thresholdHeartRate: $thresholdHeartRate,
                    runningBackground: $runningBackground,
                    runningDurability: $runningDurability,
                    runningTerrain: $runningTerrain,
                    walkStrategy: $walkStrategy,
                    runWalkStrategy: $runWalkStrategy,
                    runningInjuryNotes: $runningInjuryNotes
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
        modelContext.insert(RunningTrainingProfile(
            userProfileId: profile.id,
            targetRaceKm: targetRaceKm,
            targetRaceDate: targetRaceDate,
            weeklyRunSessions: weeklyRunSessions,
            currentWeeklyDistanceKm: currentWeeklyDistanceKm,
            currentLongRunKm: currentLongRunKm,
            easyPaceSecondsPerKm: easyPaceSecondsPerKm,
            easyHeartRate: easyHeartRate,
            thresholdHeartRate: thresholdHeartRate,
            background: runningBackground,
            durability: runningDurability,
            terrain: runningTerrain,
            walkStrategy: walkStrategy,
            runWalkStrategy: runWalkStrategy,
            injuryNotes: runningInjuryNotes
        ))
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

private struct UltraRunnerSetupCard: View {
    @Binding var targetRaceDate: Date
    @Binding var targetRaceKm: Int
    @Binding var weeklyRunSessions: Int
    @Binding var currentWeeklyDistanceKm: Int
    @Binding var currentLongRunKm: Int
    @Binding var easyPaceSecondsPerKm: Int
    @Binding var easyHeartRate: Int
    @Binding var thresholdHeartRate: Int
    @Binding var runningBackground: RunningBackground
    @Binding var runningDurability: RunningDurability
    @Binding var runningTerrain: RunningTerrain
    @Binding var walkStrategy: WalkStrategy
    @Binding var runWalkStrategy: String
    @Binding var runningInjuryNotes: String

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Ultra runner coach")
                .font(.headline)
            Text("Built around your athlete baseline: endurance background, current durability, easy pace, HR, and the race distance you actually want.")
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
            DatePicker("Target date", selection: $targetRaceDate, displayedComponents: .date)
            IntegerField(title: "Target distance", value: $targetRaceKm, range: 10...300, suffix: "km")
            IntegerField(title: "Run sessions/week", value: $weeklyRunSessions, range: 3...6)
            IntegerField(title: "Current weekly km", value: $currentWeeklyDistanceKm, range: 5...250, suffix: "km")
            IntegerField(title: "Current long run", value: $currentLongRunKm, range: 3...120, suffix: "km")
            PaceField(title: "Easy pace", secondsPerKm: $easyPaceSecondsPerKm)
            IntegerField(title: "Easy HR", value: $easyHeartRate, range: 90...190, suffix: "bpm")
            IntegerField(title: "Threshold HR", value: $thresholdHeartRate, range: 110...210, suffix: "bpm")

            Picker("Running background", selection: $runningBackground) {
                ForEach(RunningBackground.allCases) { background in
                    Text(background.title).tag(background)
                }
            }
            .pickerStyle(.menu)

            Picker("Current durability", selection: $runningDurability) {
                ForEach(RunningDurability.allCases) { durability in
                    Text(durability.title).tag(durability)
                }
            }
            .pickerStyle(.menu)

            Picker("Main terrain", selection: $runningTerrain) {
                ForEach(RunningTerrain.allCases) { terrain in
                    Text(terrain.title).tag(terrain)
                }
            }
            .pickerStyle(.menu)

            Picker("Walk strategy", selection: $walkStrategy) {
                ForEach(WalkStrategy.allCases) { strategy in
                    Text(strategy.title).tag(strategy)
                }
            }
            .pickerStyle(.menu)

            if walkStrategy == .timed || walkStrategy == .custom {
                TextField("Walk strategy details", text: $runWalkStrategy)
                    .textFieldStyle(.roundedBorder)
            } else {
                Text(walkStrategy == .climbsOnly ? "Walk climbs early to keep heart rate controlled." : "No planned walk breaks; keep the run conversational.")
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            }
            TextField("Running injury, shoe, or GI notes", text: $runningInjuryNotes, axis: .vertical)
                .textFieldStyle(.roundedBorder)
        }
        .card()
    }
}
