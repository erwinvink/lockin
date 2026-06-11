import SwiftUI
import UIKit

struct WorkoutInfoPopover<Label: View>: View {
    var prescription: SetPrescription
    var block: WorkoutBlock?
    var onDone: () -> Void
    private let label: Label
    @State private var isPresented = false

    init(
        prescription: SetPrescription,
        block: WorkoutBlock?,
        onDone: @escaping () -> Void,
        @ViewBuilder label: () -> Label
    ) {
        self.prescription = prescription
        self.block = block
        self.onDone = onDone
        self.label = label()
    }

    var body: some View {
        Button {
            isPresented = true
        } label: {
            label
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .help("What this exercise is")
        .accessibilityLabel("\(prescription.exercise.title) details")
        .popover(isPresented: $isPresented, arrowEdge: .top) {
            WorkoutInfoContent(prescription: prescription, block: block, onDone: onDone)
                .presentationCompactAdaptation(.sheet)
                .presentationDetents([.medium, .large])
        }
    }
}

struct WorkoutInfoContent: View {
    var prescription: SetPrescription
    var block: WorkoutBlock?
    var onDone: () -> Void = {}
    @State private var previousIdleTimerDisabled: Bool?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(prescription.exercise.title)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(AppTheme.text)

                WorkoutTimerCard(prescription: prescription, onDone: onDone)

                WorkoutSummaryCard(prescription: prescription)

                WorkoutInfoSection(
                    title: "What it is",
                    bodyText: exerciseMovementDescription(prescription.exercise)
                )
            }
            .padding(AppTheme.screenMargin)
            .frame(maxWidth: 380, alignment: .leading)
        }
        .background(AppTheme.background)
        .onAppear(perform: disableIdleTimer)
        .onDisappear(perform: restoreIdleTimer)
    }

    private func disableIdleTimer() {
        guard previousIdleTimerDisabled == nil else { return }
        previousIdleTimerDisabled = UIApplication.shared.isIdleTimerDisabled
        UIApplication.shared.isIdleTimerDisabled = true
    }

    private func restoreIdleTimer() {
        guard let previousIdleTimerDisabled else { return }
        UIApplication.shared.isIdleTimerDisabled = previousIdleTimerDisabled
        self.previousIdleTimerDisabled = nil
    }
}

private struct WorkoutSummaryCard: View {
    var prescription: SetPrescription

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            InfoLine(title: "Target", value: workoutTargetText(prescription))
            InfoLine(title: "Rest", value: durationText(seconds: prescription.restSeconds))
            if let effortLabel = prescription.plannedEffortLabel {
                InfoLine(
                    title: "Planned effort",
                    value: plannedEffortText(effortLabel),
                    valueColor: AppTheme.effortColor(effortLabel)
                )
            }
            if !prescription.plannedEffortReason.isEmpty {
                Text(prescription.plannedEffortReason)
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.faint)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .ruled(verticalPadding: 14)
    }

    private func plannedEffortText(_ label: PlannedEffortLabel) -> String {
        if prescription.plannedEffortTargetRPE > 0 {
            return "\(label.title), RPE \(prescription.plannedEffortTargetRPE)"
        }
        return label.title
    }
}

private struct WorkoutInfoSection: View {
    var title: String
    var bodyText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            MicroLabel(text: title.uppercased())
            Text(bodyText)
                .font(.subheadline)
                .foregroundStyle(AppTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct WorkoutTimerCard: View {
    var prescription: SetPrescription
    var onDone: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var phaseIndex = 0
    @State private var remainingSeconds = 0
    @State private var isRunning = false
    @State private var isFinished = false
    @State private var hasStartedSequence = false

    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var phases: [WorkoutTimerPhase] {
        workoutTimerPhases(for: prescription)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if phases.isEmpty {
                InfoLine(title: "Target", value: "None")
            } else {
                VStack(alignment: .leading, spacing: 14) {
                    phaseControls

                    TimerPhaseStrip(
                        phases: phases,
                        phaseIndex: phaseIndex,
                        isFinished: isFinished,
                        onSelect: { selectPhase(at: $0) }
                    )

                    Text(nextPhaseText)
                        .font(.system(size: 12))
                        .foregroundStyle(AppTheme.faint)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
            }
        }
        .padding(.vertical, 6)
        .sensoryFeedback(.impact(weight: .light), trigger: phaseIndex)
        .sensoryFeedback(.success, trigger: isFinished) { _, newValue in newValue }
        .onAppear(perform: resetTimer)
        .onReceive(ticker) { _ in
            tickTimer()
        }
    }

    private var phaseControls: some View {
        VStack(spacing: 8) {
            HStack(alignment: .center, spacing: 10) {
                PhaseControlButton(
                    systemImage: "backward.end.fill",
                    accessibilityLabel: "Previous phase",
                    isEnabled: canGoToPreviousPhase,
                    action: goToPreviousPhase
                )

                phaseValueLabel
                    .accessibilityLabel(accessibilityTimerLabel)
                    .frame(maxWidth: .infinity, alignment: .center)

                PhaseControlButton(
                    systemImage: isFinalPhase ? "checkmark.circle.fill" : "forward.end.fill",
                    accessibilityLabel: nextControlAccessibilityLabel,
                    isEnabled: true,
                    action: goToNextPhase
                )
            }

            if canStartSequence {
                TimerPlaybackButton(
                    title: "Start",
                    systemImage: "play.fill",
                    action: startSequence
                )
            }
        }
    }

    private var phaseValueLabel: some View {
        VStack(spacing: 0) {
            Text(displayValueText)
                .font(.system(size: 56, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(AppTheme.text)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .contentTransition(.numericText(countsDown: true))
                .animation(.snappy(duration: 0.25), value: displayValueText)
            Text(displayUnitText)
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.4)
                .textCase(.uppercase)
                .foregroundStyle(currentPhase?.kind == .rest && !isFinished ? AppTheme.accent : AppTheme.muted)
                .lineLimit(1)
        }
        .contentShape(Rectangle())
    }

    private var currentPhase: WorkoutTimerPhase? {
        guard !phases.isEmpty else { return nil }
        return phases[min(phaseIndex, phases.count - 1)]
    }

    private var displayValueText: String {
        guard let currentPhase else { return "--" }
        if isFinished { return "Done" }
        if currentPhase.isTimed {
            return format(seconds: displayedRemainingSeconds)
        }
        return currentPhase.displayValue
    }

    private var displayUnitText: String {
        guard let currentPhase else { return "" }
        if isFinished { return "complete" }
        return currentPhase.displayUnit
    }

    private var nextPhaseText: String {
        guard !isFinished else { return "Exercise timer complete." }
        let nextIndex = phaseIndex + 1
        guard phases.indices.contains(nextIndex) else {
            return currentPhase?.kind == .rest ? "Final rest." : "Final set."
        }
        return "Up next: \(phases[nextIndex].summaryText.lowercased())."
    }

    private var displayedRemainingSeconds: Int {
        if remainingSeconds > 0 || isFinished {
            return remainingSeconds
        }
        return currentPhase?.durationSeconds ?? 0
    }

    private var canGoToPreviousPhase: Bool {
        phaseIndex > 0
    }

    private var isFinalPhase: Bool {
        isFinished || (!phases.isEmpty && phaseIndex == phases.count - 1)
    }

    private var canStartSequence: Bool {
        phaseIndex == 0 && currentPhase?.isTimed == true && !hasStartedSequence && !isFinished
    }

    private var nextControlAccessibilityLabel: String {
        if isFinalPhase {
            return "Finish exercise"
        }
        if currentPhase?.kind == .rest {
            return "Skip rest"
        }
        return "Next phase"
    }

    private var accessibilityTimerLabel: String {
        guard let currentPhase else { return "Workout phase" }
        if isFinished { return "Exercise timer complete." }
        if currentPhase.isTimed {
            return "\(currentPhase.title), \(format(seconds: displayedRemainingSeconds)) remaining."
        }
        return "\(currentPhase.title), \(currentPhase.displayValue) \(currentPhase.displayUnit)."
    }

    private func goToNextPhase() {
        if isFinalPhase {
            finishExercise()
        } else {
            hasStartedSequence = true
            advanceTimer(autoStartTimedPhase: true)
        }
    }

    private func goToPreviousPhase() {
        guard canGoToPreviousPhase else { return }
        selectPhase(at: phaseIndex - 1)
    }

    private func resetTimer() {
        phaseIndex = 0
        isFinished = false
        hasStartedSequence = false
        activateCurrentPhase(autoStartTimedPhase: false)
    }

    private func selectPhase(at index: Int) {
        guard phases.indices.contains(index) else { return }
        phaseIndex = index
        isFinished = false
        let shouldAutoStart = hasStartedSequence || index > 0
        activateCurrentPhase(autoStartTimedPhase: shouldAutoStart)
    }

    private func tickTimer() {
        guard isRunning, let currentPhase, currentPhase.isTimed else { return }

        if remainingSeconds <= 1 {
            advanceTimer(autoStartTimedPhase: true)
        } else {
            remainingSeconds -= 1
        }
    }

    private func advanceTimer(autoStartTimedPhase: Bool = true) {
        let nextIndex = phaseIndex + 1
        if phases.indices.contains(nextIndex) {
            phaseIndex = nextIndex
            activateCurrentPhase(autoStartTimedPhase: autoStartTimedPhase)
        } else {
            remainingSeconds = 0
            isRunning = false
            isFinished = true
        }
    }

    private func activateCurrentPhase(autoStartTimedPhase: Bool) {
        guard let currentPhase else {
            remainingSeconds = 0
            isRunning = false
            return
        }
        remainingSeconds = currentPhase.durationSeconds ?? 0
        isRunning = autoStartTimedPhase && currentPhase.isTimed
    }

    private func startSequence() {
        guard canStartSequence else { return }
        hasStartedSequence = true
        isRunning = true
    }

    private func finishExercise() {
        onDone()
        dismiss()
    }
}

private struct TimerPlaybackButton: View {
    var title: String
    var systemImage: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(AppTheme.accentInk)
                .padding(.horizontal, 18)
                .padding(.vertical, 9)
                .background(Capsule().fill(AppTheme.accent))
        }
        .buttonStyle(PressableCircleStyle())
        .frame(maxWidth: .infinity, alignment: .center)
        .accessibilityLabel(title)
    }
}

/// Shared press physics for the timer's compact controls.
private struct PressableCircleStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .brightness(configuration.isPressed ? -0.07 : 0)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.94 : 1)
            .animation(.snappy(duration: 0.2), value: configuration.isPressed)
    }
}

private struct PhaseControlButton: View {
    var systemImage: String
    var accessibilityLabel: String
    var isEnabled: Bool = true
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(isEnabled ? AppTheme.text : AppTheme.faint.opacity(0.6))
                .frame(width: 44, height: 44)
                .background(Circle().fill(AppTheme.surfaceRaised))
                .overlay(Circle().strokeBorder(AppTheme.divider, lineWidth: 1))
        }
        .buttonStyle(PressableCircleStyle())
        .disabled(!isEnabled)
        .accessibilityLabel(accessibilityLabel)
    }
}

private struct TimerPhaseStrip: View {
    var phases: [WorkoutTimerPhase]
    var phaseIndex: Int
    var isFinished: Bool
    var onSelect: (Int) -> Void

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(phases.enumerated()), id: \.element.id) { index, phase in
                Button {
                    onSelect(index)
                } label: {
                    Capsule()
                        .fill(color(for: phase, at: index))
                        .frame(height: index == phaseIndex && !isFinished ? 7 : 4)
                        .frame(maxWidth: .infinity)
                        .frame(height: 16)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(phase.stripAccessibilityLabel)
            }
        }
        .animation(.snappy(duration: 0.25), value: phaseIndex)
        .animation(.snappy(duration: 0.25), value: isFinished)
    }

    private func color(for phase: WorkoutTimerPhase, at index: Int) -> Color {
        if isFinished || index < phaseIndex {
            return AppTheme.accent
        }
        if index == phaseIndex {
            return phase.kind == .work ? AppTheme.accent : AppTheme.accent.opacity(0.55)
        }
        return AppTheme.divider
    }
}

enum WorkoutTimerPhaseKind: String {
    case work
    case rest
}

enum WorkoutTimerPhaseTarget: Equatable {
    case reps(Int)
    case seconds(Int)
}

struct WorkoutTimerPhase: Identifiable, Equatable {
    var kind: WorkoutTimerPhaseKind
    var setNumber: Int
    var target: WorkoutTimerPhaseTarget

    var id: String {
        "\(kind.rawValue)-\(setNumber)"
    }

    var title: String {
        switch kind {
        case .work:
            "Set \(setNumber)"
        case .rest:
            "Rest"
        }
    }

    var durationSeconds: Int? {
        guard case let .seconds(seconds) = target else { return nil }
        return seconds
    }

    var isTimed: Bool {
        durationSeconds != nil
    }

    var isManual: Bool {
        guard kind == .work else { return false }
        if case .reps = target { return true }
        return false
    }

    var displayValue: String {
        switch target {
        case let .reps(reps):
            "\(reps)"
        case let .seconds(seconds):
            format(seconds: seconds)
        }
    }

    var displayUnit: String {
        switch target {
        case .reps:
            "reps"
        case .seconds:
            kind == .rest ? "rest" : "work"
        }
    }

    var summaryText: String {
        switch target {
        case let .reps(reps):
            "\(title): \(reps) reps"
        case let .seconds(seconds):
            kind == .rest ? "rest for \(durationText(seconds: seconds))" : "\(title): \(durationText(seconds: seconds))"
        }
    }

    var stripAccessibilityLabel: String {
        switch target {
        case let .reps(reps):
            return "Go to \(title), \(reps) reps"
        case let .seconds(seconds):
            if kind == .rest {
                return "Go to rest after set \(setNumber), \(durationText(seconds: seconds))"
            }
            return "Go to \(title), \(durationText(seconds: seconds))"
        }
    }
}

func workoutTimerPhases(for prescription: SetPrescription) -> [WorkoutTimerPhase] {
    guard prescription.sets > 0 else { return [] }
    let workTarget: WorkoutTimerPhaseTarget
    if prescription.targetSeconds > 0 {
        workTarget = .seconds(prescription.targetSeconds)
    } else if prescription.targetReps > 0 {
        workTarget = .reps(prescription.targetReps)
    } else {
        return []
    }

    var phases: [WorkoutTimerPhase] = []
    for setNumber in 1...prescription.sets {
        phases.append(
            WorkoutTimerPhase(
                kind: .work,
                setNumber: setNumber,
                target: workTarget
            )
        )

        if prescription.restSeconds > 0 {
            phases.append(
                WorkoutTimerPhase(
                    kind: .rest,
                    setNumber: setNumber,
                    target: .seconds(prescription.restSeconds)
                )
            )
        }
    }
    return phases
}
