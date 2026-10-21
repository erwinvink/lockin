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
                .presentationDragIndicator(.visible)
                .presentationBackground(AppTheme.background)
        }
    }
}

/// The exercise sheet: the sets and rests as a short trail, one big timer,
/// and what the movement is.
struct WorkoutInfoContent: View {
    var prescription: SetPrescription
    var block: WorkoutBlock?
    var onDone: () -> Void = {}
    @Environment(\.dismiss) private var dismiss
    @State private var previousIdleTimerDisabled: Bool?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(prescription.exercise.title)
                            .font(.trail(28, .bold, relativeTo: .title1))
                            .foregroundStyle(AppTheme.text)
                        if let effortLabel = prescription.plannedEffortLabel {
                            EffortPill(
                                label: effortLabel,
                                targetRPE: prescription.plannedEffortTargetRPE > 0 ? prescription.plannedEffortTargetRPE : nil
                            )
                        }
                    }
                    Spacer(minLength: 8)
                    Button("Done") { dismiss() }
                        .font(.trail(17, .semibold, relativeTo: .headline))
                        .foregroundStyle(AppTheme.text)
                        .frame(minWidth: 44, minHeight: 44)
                }

                WorkoutTimerCard(prescription: prescription, onDone: onDone)

                WorkoutSummaryCard(prescription: prescription)

                WorkoutInfoSection(
                    title: "What it is",
                    bodyText: exerciseMovementDescription(prescription.exercise)
                )
            }
            .padding(.horizontal, AppTheme.screenMargin)
            .padding(.top, 20)
            .padding(.bottom, 32)
            .frame(maxWidth: 440, alignment: .leading)
        }
        .scrollIndicators(.hidden)
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

    private var restText: String {
        prescription.restSeconds > 0 ? "\(durationText(seconds: prescription.restSeconds)) between sets" : "No rest"
    }

    private var reasonText: String {
        prescription.plannedEffortReason.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(spacing: 0) {
            SummaryRow(title: "Target", value: workoutTargetText(prescription))
            Hairline()
            SummaryRow(title: "Rest", value: restText)
            if let effortLabel = prescription.plannedEffortLabel {
                Hairline()
                HStack(alignment: .center, spacing: 16) {
                    Text("Planned effort")
                        .font(.trail(15, .regular, relativeTo: .subheadline))
                        .foregroundStyle(AppTheme.muted)
                    Spacer(minLength: 8)
                    EffortPill(
                        label: effortLabel,
                        targetRPE: prescription.plannedEffortTargetRPE > 0 ? prescription.plannedEffortTargetRPE : nil
                    )
                }
                .frame(minHeight: 48)
            }
            if !reasonText.isEmpty {
                Hairline()
                SummaryRow(title: "Why", value: reasonText)
            }
        }
        .padding(.horizontal, 16)
        .card(padding: 0)
    }
}

private struct SummaryRow: View {
    var title: String
    var value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text(title)
                .font(.trail(15, .regular, relativeTo: .subheadline))
                .foregroundStyle(AppTheme.muted)
            Spacer(minLength: 8)
            Text(value)
                .font(.trail(15, .semibold, relativeTo: .subheadline))
                .foregroundStyle(AppTheme.text)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 14)
        .accessibilityElement(children: .combine)
    }
}

private struct WorkoutInfoSection: View {
    var title: String
    var bodyText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.trail(17, .semibold, relativeTo: .headline))
                .foregroundStyle(AppTheme.text)
            Text(bodyText)
                .font(.lockinBody)
                .foregroundStyle(AppTheme.bodyText)
                .lineSpacing(2)
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
        VStack(alignment: .leading, spacing: 16) {
            if phases.isEmpty {
                Text("No sets are planned for this exercise.")
                    .font(.lockinBody)
                    .foregroundStyle(AppTheme.muted)
            } else {
                TimerPhaseTrail(
                    phases: phases,
                    phaseIndex: phaseIndex,
                    isFinished: isFinished,
                    onSelect: { selectPhase(at: $0) }
                )

                phaseDisplay

                controls
            }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: phaseIndex)
        .sensoryFeedback(.success, trigger: isFinished) { _, newValue in newValue }
        .onAppear(perform: resetTimer)
        .onReceive(ticker) { _ in
            tickTimer()
        }
    }

    // MARK: Display

    private var phaseDisplay: some View {
        VStack(spacing: 2) {
            Text(phaseLabel)
                .font(.trail(15, .semibold, relativeTo: .subheadline))
                .foregroundStyle(AppTheme.muted)
            Text(displayValueText)
                .font(.lockinNumeral(96))
                .foregroundStyle(AppTheme.text)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .contentTransition(.numericText(countsDown: true))
                .animation(.snappy(duration: 0.25), value: displayValueText)
            Text(displayUnitText)
                .font(.trail(17, .semibold, relativeTo: .headline))
                .foregroundStyle(AppTheme.text)
            Text(nextPhaseText)
                .font(.lockinMeta)
                .foregroundStyle(AppTheme.muted)
                .multilineTextAlignment(.center)
                .padding(.top, 10)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 22)
        .padding(.horizontal, 16)
        .card(padding: 0)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityTimerLabel)
    }

    private var controls: some View {
        HStack(spacing: 10) {
            Button(action: goToPreviousPhase) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 20, weight: .semibold))
                    .frame(width: 56, height: 56)
            }
            .buttonStyle(OutlinedIconButtonStyle())
            .disabled(!canGoToPreviousPhase)
            .accessibilityLabel("Previous phase")

            Button(primaryTitle, action: primaryAction)
                .buttonStyle(PrimaryActionButtonStyle())
                .accessibilityLabel(primaryAccessibilityLabel)
        }
    }

    private var currentPhase: WorkoutTimerPhase? {
        guard !phases.isEmpty else { return nil }
        return phases[min(phaseIndex, phases.count - 1)]
    }

    private var phaseLabel: String {
        guard let currentPhase else { return "" }
        if isFinished { return "All sets" }
        switch currentPhase.kind {
        case .work: return "Set \(currentPhase.setNumber) of \(prescription.sets)"
        case .rest: return "Rest"
        }
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
        if isFinished { return "Nice work" }
        switch (currentPhase.kind, currentPhase.target) {
        case (.work, .reps): return "strict reps"
        case (.work, .seconds): return "hold"
        case (.rest, _):
            let nextSet = currentPhase.setNumber + 1
            return nextSet <= prescription.sets ? "until set \(nextSet)" : "then you're done"
        }
    }

    private var nextPhaseText: String {
        guard !isFinished else { return "Close this sheet to log the rest of the session." }
        let nextIndex = phaseIndex + 1
        guard phases.indices.contains(nextIndex) else {
            return currentPhase?.kind == .rest ? "Last rest." : "Last set."
        }
        let next = phases[nextIndex]
        switch (next.kind, next.target) {
        case let (.work, .reps(reps)):
            return "Up next: set \(next.setNumber), \(reps) reps."
        case let (.work, .seconds(seconds)):
            return "Up next: set \(next.setNumber), \(durationText(seconds: seconds)) hold."
        case let (.rest, .seconds(seconds)):
            return "Up next: \(durationText(seconds: seconds)) rest."
        case (.rest, .reps):
            return "Up next: rest."
        }
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

    // MARK: Primary action

    private var primaryTitle: String {
        if canStartSequence { return "Start" }
        if isFinalPhase { return "Finish \(prescription.exercise.title.lowercased())" }
        guard let currentPhase else { return "Next" }
        switch (currentPhase.kind, currentPhase.target) {
        case (.rest, _): return "Skip rest"
        case (.work, .reps): return "Set done"
        case (.work, .seconds): return "Next"
        }
    }

    private var primaryAccessibilityLabel: String {
        if canStartSequence { return "Start timer" }
        if isFinalPhase { return "Finish exercise" }
        if currentPhase?.kind == .rest { return "Skip rest" }
        return "Next phase"
    }

    private func primaryAction() {
        if canStartSequence {
            startSequence()
        } else {
            goToNextPhase()
        }
    }

    private var accessibilityTimerLabel: String {
        guard let currentPhase else { return "Workout phase" }
        if isFinished { return "Exercise timer complete." }
        if currentPhase.isTimed {
            return "\(currentPhase.title), \(format(seconds: displayedRemainingSeconds)) remaining."
        }
        return "\(currentPhase.title), \(currentPhase.displayValue) \(currentPhase.displayUnit)."
    }

    // MARK: Timer state

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

/// Square outlined icon button next to the primary action.
private struct OutlinedIconButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isEnabled ? AppTheme.text : AppTheme.post)
            .background(
                RoundedRectangle(cornerRadius: AppTheme.buttonRadius, style: .continuous)
                    .fill(configuration.isPressed ? AppTheme.surfaceRaised : AppTheme.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.buttonRadius, style: .continuous)
                    .strokeBorder(isEnabled ? AppTheme.text : AppTheme.divider, lineWidth: 2)
            )
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .animation(.snappy(duration: 0.2), value: configuration.isPressed)
    }
}

/// Sets as waypoints and rests as small stops on one dashed trail. The
/// current step is the yellow "you are here" marker; tap any step to jump.
private struct TimerPhaseTrail: View {
    var phases: [WorkoutTimerPhase]
    var phaseIndex: Int
    var isFinished: Bool
    var onSelect: (Int) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(phases.enumerated()), id: \.element.id) { index, phase in
                Button {
                    onSelect(index)
                } label: {
                    ZStack {
                        HStack(spacing: 0) {
                            halfTrail(visible: index > 0)
                            halfTrail(visible: index < phases.count - 1)
                        }
                        marker(for: phase, at: index)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(phase.stripAccessibilityLabel)
            }
        }
        .animation(.snappy(duration: 0.25), value: phaseIndex)
        .animation(.snappy(duration: 0.25), value: isFinished)
    }

    private func halfTrail(visible: Bool) -> some View {
        TrailLine(axis: .horizontal)
            .stroke(AppTheme.post, style: StrokeStyle(lineWidth: 3, dash: [5, 5]))
            .frame(height: 3)
            .opacity(visible ? 1 : 0)
    }

    @ViewBuilder
    private func marker(for phase: WorkoutTimerPhase, at index: Int) -> some View {
        let isDone = isFinished || index < phaseIndex
        let isNow = !isFinished && index == phaseIndex
        switch phase.kind {
        case .work:
            WaypointMarker(state: isDone ? .done : (isNow ? .current : .planned), size: 26)
                .background(Circle().fill(AppTheme.background).padding(-3))
        case .rest:
            if isNow {
                WaypointMarker(state: .current, size: 18)
                    .background(Circle().fill(AppTheme.background).padding(-3))
            } else {
                Circle()
                    .fill(isDone ? AppTheme.text : AppTheme.post)
                    .frame(width: 10, height: 10)
                    .background(Circle().fill(AppTheme.background).padding(-3))
            }
        }
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
