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
            VStack(alignment: .leading, spacing: 14) {
                Text(prescription.exercise.title)
                    .font(.headline)

                WorkoutTimerCard(prescription: prescription, onDone: onDone)

                WorkoutSummaryCard(prescription: prescription)

                WorkoutInfoSection(
                    title: "What it is",
                    bodyText: exerciseMovementDescription(prescription.exercise)
                )

                WorkoutInfoSection(
                    title: "Workout context",
                    bodyText: exerciseWorkoutContext(prescription.exercise, block: block)
                )
            }
            .padding(16)
            .frame(maxWidth: 360, alignment: .leading)
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
        VStack(alignment: .leading, spacing: 8) {
            InfoLine(title: "Target", value: workoutTargetText(prescription))
            InfoLine(title: "Rest", value: durationText(seconds: prescription.restSeconds))
            if let effortLabel = prescription.plannedEffortLabel {
                InfoLine(
                    title: "Planned effort",
                    value: plannedEffortText(effortLabel),
                    valueColor: effortValueColor(effortLabel)
                )
            }
            if !prescription.plannedEffortReason.isEmpty {
                Text(prescription.plannedEffortReason)
                    .font(.caption2)
                    .foregroundStyle(AppTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10)
        .background(AppTheme.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
    }

    private func plannedEffortText(_ label: PlannedEffortLabel) -> String {
        if prescription.plannedEffortTargetRPE > 0 {
            return "\(label.title), RPE \(prescription.plannedEffortTargetRPE)"
        }
        return label.title
    }

    private func effortValueColor(_ label: PlannedEffortLabel) -> Color {
        switch label {
        case .light: AppTheme.accent
        case .medium: AppTheme.gold
        case .hard, .veryHard, .maxOutput: AppTheme.warning
        }
    }
}

private struct WorkoutInfoSection: View {
    var title: String
    var bodyText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.subheadline.bold())
                .foregroundStyle(AppTheme.text)
            Text(bodyText)
                .font(.caption)
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
                VStack(alignment: .leading, spacing: 10) {
                    phaseControls

                    TimerPhaseStrip(
                        phases: phases,
                        phaseIndex: phaseIndex,
                        isFinished: isFinished,
                        onSelect: { selectPhase(at: $0) }
                    )

                    Text(nextPhaseText)
                        .font(.caption)
                        .foregroundStyle(AppTheme.muted)
                        .lineLimit(2)
                }
            }
        }
        .padding(10)
        .background(AppTheme.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
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
        HStack(alignment: .lastTextBaseline, spacing: 8) {
            Text(displayValueText)
                .font(.system(size: 52, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(AppTheme.text)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
            Text(displayUnitText)
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppTheme.muted)
                .lineLimit(2)
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
                .font(.caption.weight(.bold))
                .foregroundStyle(AppTheme.text)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Capsule().fill(AppTheme.surface))
                .overlay(Capsule().stroke(AppTheme.divider, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
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
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(isEnabled ? AppTheme.text : AppTheme.muted.opacity(0.45))
                .frame(width: 38, height: 38)
                .background(Circle().fill(AppTheme.surface))
                .overlay(Circle().stroke(AppTheme.divider, lineWidth: 1))
        }
        .buttonStyle(.plain)
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
                        .frame(height: 7)
                        .frame(maxWidth: .infinity)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(phase.stripAccessibilityLabel)
            }
        }
    }

    private func color(for phase: WorkoutTimerPhase, at index: Int) -> Color {
        if isFinished || index < phaseIndex {
            return AppTheme.accent
        }
        if index == phaseIndex {
            return phase.kind == .work ? AppTheme.accent : AppTheme.gold
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
