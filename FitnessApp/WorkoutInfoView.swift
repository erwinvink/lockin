import SwiftUI

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

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(prescription.exercise.title)
                    .font(.headline)

                WorkoutSummaryCard(prescription: prescription)

                WorkoutTimerCard(prescription: prescription, onDone: onDone)

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
    }
}

private struct WorkoutSummaryCard: View {
    var prescription: SetPrescription

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            InfoLine(title: "Target", value: workoutTargetText(prescription))
            InfoLine(title: "Rest", value: durationText(seconds: prescription.restSeconds))
            InfoLine(title: "Effort", value: prescription.intensity)
        }
        .padding(10)
        .background(AppTheme.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
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

    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var phases: [WorkoutTimerPhase] {
        workoutTimerPhases(for: prescription)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center) {
                Text("Timer")
                    .font(.subheadline.bold())
                    .foregroundStyle(AppTheme.text)
                Spacer()
                StatusPill(text: statusText, color: statusColor, systemImage: statusIcon)
            }

            if phases.isEmpty {
                InfoLine(title: "Timed target", value: "None")
                Button(action: finishExercise) {
                    Label("Done", systemImage: "checkmark.circle.fill")
                }
                .buttonStyle(PrimaryActionButtonStyle())
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .lastTextBaseline, spacing: 8) {
                        Text(format(seconds: displayedRemainingSeconds))
                            .font(.system(size: 52, weight: .bold, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(AppTheme.text)
                            .lineLimit(1)
                            .minimumScaleFactor(0.72)
                        Text(currentPhaseCaption)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(AppTheme.muted)
                            .lineLimit(2)
                    }

                    TimerPhaseStrip(phases: phases, phaseIndex: phaseIndex, isFinished: isFinished)

                    Text(nextPhaseText)
                        .font(.caption)
                        .foregroundStyle(AppTheme.muted)
                        .lineLimit(2)
                }

                HStack(spacing: 8) {
                    Button(action: toggleTimer) {
                        Label(startButtonTitle, systemImage: startButtonIcon)
                    }
                    .buttonStyle(PrimaryActionButtonStyle())

                    Button(action: resetTimer) {
                        Label("Restart", systemImage: "arrow.counterclockwise")
                    }
                    .buttonStyle(SecondaryActionButtonStyle())

                    Button(action: finishExercise) {
                        Label("Done", systemImage: "checkmark.circle.fill")
                    }
                    .buttonStyle(SecondaryActionButtonStyle())
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

    private var displayedRemainingSeconds: Int {
        if remainingSeconds > 0 || isFinished {
            return remainingSeconds
        }
        return currentPhase?.durationSeconds ?? 0
    }

    private var currentPhase: WorkoutTimerPhase? {
        guard !phases.isEmpty else { return nil }
        return phases[min(phaseIndex, phases.count - 1)]
    }

    private var statusText: String {
        guard let currentPhase else { return "No timer" }
        if isFinished { return "Complete" }
        return currentPhase.title
    }

    private var statusIcon: String {
        if isFinished { return "checkmark.circle.fill" }
        guard let currentPhase else { return "timer" }
        return currentPhase.kind == .work ? "figure.strengthtraining.traditional" : "pause.circle.fill"
    }

    private var statusColor: Color {
        if isFinished { return AppTheme.accent }
        guard let currentPhase else { return AppTheme.muted }
        return currentPhase.kind == .work ? AppTheme.accent : AppTheme.gold
    }

    private var currentPhaseCaption: String {
        guard let currentPhase else { return "" }
        if isFinished { return "complete" }
        return currentPhase.caption
    }

    private var nextPhaseText: String {
        guard !isFinished else { return "Exercise timer complete." }
        let nextIndex = phaseIndex + 1
        guard phases.indices.contains(nextIndex) else { return "Last interval." }
        return "Next: \(phases[nextIndex].title.lowercased()) for \(durationText(seconds: phases[nextIndex].durationSeconds))."
    }

    private var startButtonTitle: String {
        isRunning ? "Pause" : "Start"
    }

    private var startButtonIcon: String {
        isRunning ? "pause.fill" : "play.fill"
    }

    private func toggleTimer() {
        guard !phases.isEmpty else { return }
        if isFinished || remainingSeconds == 0 {
            resetTimer()
        }
        isRunning.toggle()
    }

    private func resetTimer() {
        phaseIndex = 0
        remainingSeconds = phases.first?.durationSeconds ?? 0
        isRunning = false
        isFinished = false
    }

    private func tickTimer() {
        guard isRunning, !phases.isEmpty else { return }

        if remainingSeconds <= 1 {
            advanceTimer()
        } else {
            remainingSeconds -= 1
        }
    }

    private func advanceTimer() {
        let nextIndex = phaseIndex + 1
        if phases.indices.contains(nextIndex) {
            phaseIndex = nextIndex
            remainingSeconds = phases[nextIndex].durationSeconds
        } else {
            remainingSeconds = 0
            isRunning = false
            isFinished = true
        }
    }

    private func finishExercise() {
        onDone()
        dismiss()
    }
}

private struct TimerPhaseStrip: View {
    var phases: [WorkoutTimerPhase]
    var phaseIndex: Int
    var isFinished: Bool

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(phases.enumerated()), id: \.element.id) { index, phase in
                Capsule()
                    .fill(color(for: phase, at: index))
                    .frame(height: 7)
                    .frame(maxWidth: .infinity)
            }
        }
        .accessibilityHidden(true)
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

private enum WorkoutTimerPhaseKind: String {
    case work
    case rest
}

private struct WorkoutTimerPhase: Identifiable {
    var kind: WorkoutTimerPhaseKind
    var setNumber: Int
    var durationSeconds: Int

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

    var caption: String {
        switch kind {
        case .work:
            "work"
        case .rest:
            "before set \(setNumber + 1)"
        }
    }
}

private func workoutTimerPhases(for prescription: SetPrescription) -> [WorkoutTimerPhase] {
    guard prescription.sets > 0, prescription.targetSeconds > 0 else { return [] }

    var phases: [WorkoutTimerPhase] = []
    for setNumber in 1...prescription.sets {
        phases.append(
            WorkoutTimerPhase(
                kind: .work,
                setNumber: setNumber,
                durationSeconds: prescription.targetSeconds
            )
        )

        if setNumber < prescription.sets, prescription.restSeconds > 0 {
            phases.append(
                WorkoutTimerPhase(
                    kind: .rest,
                    setNumber: setNumber,
                    durationSeconds: prescription.restSeconds
                )
            )
        }
    }
    return phases
}
