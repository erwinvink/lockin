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

    /// Why "Create profile" is off, in the order the athlete meets the
    /// controls. Nil when the profile can be created.
    private var blockingReason: String? {
        if !(2...6).contains(selectedTrainingDays.count) { return "Pick 2 to 6 strength days." }
        if isTrainingForRace && runningDays.isEmpty { return "Pick at least one running day." }
        if !selectedEquipment.contains(.pullUpBar) { return "Add a pull-up bar to continue." }
        if !strictForm { return "Turn on strict reps to continue." }
        return nil
    }

    var body: some View {
        NavigationStack {
            ScreenBackground {
                SignpostStack {
                    Signpost(eyebrow: "Start here", title: "Set up lockin", trailing: "2 min")
                }
                .padding(.top, 6)

                Text("Start from your real numbers. The coach plans every week from here and only counts strict reps.")
                    .font(.trail(17, .regular, relativeTo: .body))
                    .foregroundStyle(AppTheme.text)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, -14)

                FormGroup("Name") {
                    TextField("Name", text: $name)
                        .textInputAutocapitalization(.words)
                        .font(.trail(17, .regular, relativeTo: .body))
                        .tint(AppTheme.text)
                        .lockinField()
                }

                NowAndGoalSection(
                    pullUps: $pullUps,
                    pushUps: $pushUps,
                    plankSeconds: $plankSeconds,
                    goalPullUps: $goalPullUps,
                    goalPushUps: $goalPushUps,
                    goalPlankSeconds: $goalPlankSeconds,
                    targetDate: $targetDate
                )

                TrainingDaysPicker(
                    selectedDays: $selectedTrainingDays,
                    title: "Strength days",
                    caption: "Pick 2 to 6 days. The coach only plans on these days."
                )

                RaceSection(
                    isTrainingForRace: $isTrainingForRace,
                    raceName: $raceName,
                    raceDate: $raceDate,
                    raceDistanceKm: $raceDistanceKm,
                    raceElevationGainM: $raceElevationGainM,
                    runningDays: $runningDays,
                    longRunDay: $longRunDay
                )

                EquipmentSection(selectedEquipment: $selectedEquipment)

                GuardrailsSection(
                    strictForm: $strictForm,
                    painNotes: $painNotes
                )

                VStack(alignment: .leading, spacing: 8) {
                    Button("Create profile", action: completeOnboarding)
                        .buttonStyle(PrimaryActionButtonStyle())
                        .disabled(blockingReason != nil)
                    if let blockingReason {
                        Text(blockingReason)
                            .font(.trail(14, .semibold, relativeTo: .subheadline))
                            .foregroundStyle(AppTheme.markerRedText)
                            .accessibilityAddTraits(.updatesFrequently)
                    }
                }
                .padding(.top, 4)
            }
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

// MARK: - Sections

/// Where the athlete is now against where they want to get, one row per
/// movement: the goal column carries the heavier outline.
private struct NowAndGoalSection: View {
    @Binding var pullUps: Int
    @Binding var pushUps: Int
    @Binding var plankSeconds: Int
    @Binding var goalPullUps: Int
    @Binding var goalPushUps: Int
    @Binding var goalPlankSeconds: Int
    @Binding var targetDate: Date

    var body: some View {
        FormGroup("Now and goal") {
            NoteText("Your best strict set today, and where you want to get.")
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    Text("Now")
                        .frame(width: NowGoalField.width)
                    Text("Goal")
                        .frame(width: NowGoalField.width)
                }
                .font(.trail(12, .semibold, relativeTo: .caption1))
                .foregroundStyle(AppTheme.muted)
                .padding(.top, 8)
                .padding(.bottom, 4)
                .accessibilityHidden(true)

                ListCardRule()
                NowGoalRow(title: "Pull-ups", now: $pullUps, nowRange: 0...100, goal: $goalPullUps, goalRange: 1...300)
                ListCardRule()
                NowGoalRow(title: "Push-ups", now: $pushUps, nowRange: 0...300, goal: $goalPushUps, goalRange: 1...500)
                ListCardRule()
                NowGoalRow(title: "Plank", now: $plankSeconds, nowRange: 0...1_800, goal: $goalPlankSeconds, goalRange: 10...3_600, isDuration: true)
                ListCardRule()
                DatePicker("Target date", selection: $targetDate, displayedComponents: .date)
                    .font(.lockinBody)
                    .foregroundStyle(AppTheme.text)
                    .tint(AppTheme.text)
                    .frame(minHeight: 56)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 4)
            .card(padding: 0)
        }
    }
}

private struct NowGoalRow: View {
    var title: String
    @Binding var now: Int
    var nowRange: ClosedRange<Int>
    @Binding var goal: Int
    var goalRange: ClosedRange<Int>
    var isDuration = false

    var body: some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.lockinBody)
                .foregroundStyle(AppTheme.text)
                .frame(maxWidth: .infinity, alignment: .leading)
            NowGoalField(label: "\(title) now", value: $now, range: nowRange, isDuration: isDuration, isGoal: false)
            NowGoalField(label: "\(title) goal", value: $goal, range: goalRange, isDuration: isDuration, isGoal: true)
        }
        .frame(minHeight: 56)
    }
}

private struct NowGoalField: View {
    static let width: CGFloat = 80

    var label: String
    @Binding var value: Int
    var range: ClosedRange<Int>
    var isDuration: Bool
    var isGoal: Bool

    @FocusState private var isFocused: Bool

    private var clampedValue: Binding<Int> {
        Binding(
            get: { value },
            set: { value = min(range.upperBound, max(range.lowerBound, $0)) }
        )
    }

    private var isStrong: Bool { isGoal || isFocused }

    var body: some View {
        field
            .keyboardType(isDuration ? .numbersAndPunctuation : .numberPad)
            .multilineTextAlignment(.center)
            .font(.trail(17, isGoal ? .bold : .semibold, relativeTo: .body).monospacedDigit())
            .foregroundStyle(AppTheme.text)
            .tint(AppTheme.text)
            .focused($isFocused)
            .frame(width: Self.width, height: 42)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(isGoal ? AppTheme.surface : AppTheme.background)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(isStrong ? AppTheme.text : AppTheme.post.opacity(0.6), lineWidth: isStrong ? 2 : 1)
            )
            .animation(.easeOut(duration: 0.15), value: isFocused)
            .accessibilityLabel(label)
    }

    @ViewBuilder
    private var field: some View {
        if isDuration {
            TextField(label, value: clampedValue, format: MinuteSecondFormat())
        } else {
            TextField(label, value: clampedValue, format: .number.grouping(.never))
        }
    }
}

/// Seconds shown and typed as m:ss ("1:30"). A bare number reads as
/// seconds, and a dot works as the separator too.
private struct MinuteSecondFormat: ParseableFormatStyle {
    var parseStrategy: MinuteSecondParser { MinuteSecondParser() }

    func format(_ value: Int) -> String {
        "\(value / 60):" + String(format: "%02d", value % 60)
    }
}

private struct MinuteSecondParser: ParseStrategy {
    func parse(_ value: String) throws -> Int {
        let parts = value
            .split(omittingEmptySubsequences: false) { $0 == ":" || $0 == "." }
            .map { $0.trimmingCharacters(in: .whitespaces) }
        switch parts.count {
        case 1:
            if let seconds = Int(parts[0]) { return seconds }
        case 2:
            if let minutes = Int(parts[0].isEmpty ? "0" : parts[0]),
               let seconds = Int(parts[1]),
               (0..<60).contains(seconds) {
                return minutes * 60 + seconds
            }
        default:
            break
        }
        throw CocoaError(.formatting)
    }
}

private struct RaceSection: View {
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
        VStack(alignment: .leading, spacing: 10) {
            Toggle(isOn: $isTrainingForRace.animation(.smooth(duration: 0.3))) {
                Text("I'm training for a race")
                    .font(.trail(17, .semibold, relativeTo: .headline))
                    .foregroundStyle(AppTheme.text)
            }
            .tint(AppTheme.text)
            .frame(minHeight: 44)

            if isTrainingForRace {
                ListCard {
                    ListCardRow(minHeight: 52) {
                        Text("Race")
                            .font(.lockinBody)
                            .foregroundStyle(AppTheme.text)
                        Spacer(minLength: 8)
                        TextField("Race name", text: $raceName)
                            .textInputAutocapitalization(.words)
                            .multilineTextAlignment(.trailing)
                            .font(.trail(16, .semibold, relativeTo: .body))
                            .foregroundStyle(AppTheme.text)
                            .tint(AppTheme.text)
                            .padding(.horizontal, 10)
                            .frame(width: 180, height: 40)
                            .background(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .fill(AppTheme.surfaceRaised)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .strokeBorder(AppTheme.divider, lineWidth: 1)
                            )
                    }
                    ListCardRule()
                    ListCardRow(minHeight: 52) {
                        DatePicker("Race date", selection: $raceDate, displayedComponents: .date)
                            .font(.lockinBody)
                            .foregroundStyle(AppTheme.text)
                            .tint(AppTheme.text)
                    }
                    ListCardRule()
                    ListCardRow(minHeight: 52) {
                        IntegerField(title: "Distance", value: $raceDistanceKm, range: 1...500, suffix: "km")
                    }
                    ListCardRule()
                    ListCardRow(minHeight: 52) {
                        IntegerField(title: "Climb", value: $raceElevationGainM, range: 0...30_000, suffix: "m")
                    }
                }

                TrainingDaysPicker(
                    selectedDays: $runningDays,
                    title: "Running days",
                    minDays: 1,
                    maxDays: 7,
                    caption: "Pick the days you can run. The coach may leave some of them as rest days while you build."
                )
                .padding(.top, 6)

                if !orderedRunningDays.isEmpty {
                    ListCard {
                        ListCardRow(minHeight: 52) {
                            Text("Long run day")
                                .font(.lockinBody)
                                .foregroundStyle(AppTheme.text)
                            Spacer()
                            Picker("Long run day", selection: $longRunDay) {
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
            }
        }
        .onChange(of: runningDays) { _, newDays in
            guard !newDays.isEmpty, !newDays.contains(longRunDay) else { return }
            if let fallback = TrainingWeekday.allCases.last(where: { newDays.contains($0) }) {
                longRunDay = fallback
            }
        }
    }
}

private struct EquipmentSection: View {
    @Binding var selectedEquipment: Set<EquipmentKind>

    var body: some View {
        FormGroup("Equipment") {
            FlowLayout(spacing: 6) {
                ForEach(EquipmentKind.allCases) { item in
                    let isOn = selectedEquipment.contains(item)
                    Button {
                        if isOn {
                            selectedEquipment.remove(item)
                        } else {
                            selectedEquipment.insert(item)
                        }
                    } label: {
                        HStack(spacing: 6) {
                            if isOn {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 12, weight: .bold))
                            }
                            Text(item.title)
                        }
                        .font(.trail(15, isOn ? .semibold : .medium, relativeTo: .subheadline))
                        .foregroundStyle(isOn ? Color.white : AppTheme.text)
                        .padding(.horizontal, 14)
                        .frame(height: 44)
                        .background(Capsule().fill(isOn ? AppTheme.text : AppTheme.surface))
                        .overlay(Capsule().strokeBorder(isOn ? Color.clear : AppTheme.post.opacity(0.6), lineWidth: 1))
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(item.title)
                    .accessibilityAddTraits(isOn ? .isSelected : [])
                    .animation(.snappy(duration: 0.2), value: isOn)
                    .sensoryFeedback(.selection, trigger: isOn)
                }
            }
            NoteText(
                "A pull-up bar is required. The rest is optional.",
                isError: !selectedEquipment.contains(.pullUpBar)
            )
        }
    }
}

private struct GuardrailsSection: View {
    @Binding var strictForm: Bool
    @Binding var painNotes: String

    var body: some View {
        FormGroup("Guardrails") {
            Toggle(isOn: $strictForm) {
                Text("Only count strict reps and holds")
                    .font(.lockinBody)
                    .foregroundStyle(AppTheme.text)
            }
            .tint(AppTheme.text)
            .padding(.horizontal, 14)
            .frame(minHeight: 56)
            .card(padding: 0)

            Text("Pain, injuries or limits")
                .font(.trail(15, .semibold, relativeTo: .subheadline))
                .foregroundStyle(AppTheme.text)
                .padding(.top, 4)
            TextField("For example: left shoulder pinches above head", text: $painNotes, axis: .vertical)
                .lineLimit(3...6)
                .font(.lockinBody)
                .tint(AppTheme.text)
                .lockinField()
        }
    }
}

// MARK: - Shared

struct TrainingDaysPicker: View {
    @Binding var selectedDays: Set<TrainingWeekday>
    var title: String = "Training days"
    var minDays: Int = 2
    var maxDays: Int = 6
    var caption: String? = "Pick 2 to 6 days. The coach only plans future sessions on these days."
    var preventsEmptySelection: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.trail(17, .semibold, relativeTo: .headline))
                    .foregroundStyle(AppTheme.text)
                Spacer()
                Text("\(selectedDays.count) per week")
                    .font(.trail(14, .regular, relativeTo: .subheadline))
                    .foregroundStyle((minDays...maxDays).contains(selectedDays.count) ? AppTheme.muted : AppTheme.markerRedText)
            }
            HStack(spacing: 5) {
                ForEach(TrainingWeekday.allCases) { day in
                    let isSelected = selectedDays.contains(day)
                    let isDisabled = isToggleDisabled(for: day)
                    Button {
                        toggle(day)
                    } label: {
                        Text(day.shortTitle)
                            .font(.trail(14, isSelected ? .bold : .semibold, relativeTo: .subheadline))
                            .foregroundStyle(isSelected ? Color.white : (isDisabled ? AppTheme.faint : AppTheme.text))
                            .frame(maxWidth: .infinity)
                            .frame(height: 44)
                            .background(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .fill(isSelected ? AppTheme.text : AppTheme.surface)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .strokeBorder(isSelected ? .clear : AppTheme.divider, lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                    .disabled(isDisabled)
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                    .animation(.snappy(duration: 0.2), value: isSelected)
                    .sensoryFeedback(.selection, trigger: isSelected)
                }
            }
            if let caption {
                Text(caption)
                    .font(.trail(13, .regular, relativeTo: .footnote))
                    .foregroundStyle(AppTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
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
