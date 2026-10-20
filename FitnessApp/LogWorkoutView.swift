import SwiftData
import SwiftUI

private enum LogMetricField: Hashable {
    case pullUps
    case pushUps
    case plankSeconds
}

struct LogWorkoutView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \SetPrescription.orderIndex) private var prescriptions: [SetPrescription]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var previousLogs: [PerformanceLog]
    // Configuration, not state: fixed per build flavor (see LocalCoachClient).
    private let endpoint = LocalCoachClient.defaultEndpointString
    @AppStorage("coachModelID") private var selectedModelID = CoachModelCatalog.defaultModelID

    var session: WorkoutSession
    var profile: UserProfile

    @FocusState private var focusedLogField: LogMetricField?
    @State private var pullUpsText = ""
    @State private var pushUpsText = ""
    @State private var plankSecondsText = ""
    @State private var rpe: Int
    @State private var painLevel = 0
    @State private var howFelt = 3
    @State private var notes = ""
    @State private var isSaving = false
    @State private var saveError: String?

    init(session: WorkoutSession, profile: UserProfile) {
        self.session = session
        self.profile = profile
        _rpe = State(initialValue: initialLoggedRPE(for: session))
    }

    private var sessionPrescriptions: [SetPrescription] {
        prescriptions
            .filter { $0.sessionId == session.id }
            .sorted { $0.orderIndex < $1.orderIndex }
    }

    private var sessionExercises: [ExerciseKind] {
        var seen: Set<ExerciseKind> = []
        return sessionPrescriptions.compactMap { prescription in
            guard !seen.contains(prescription.exercise) else { return nil }
            seen.insert(prescription.exercise)
            return prescription.exercise
        }
    }

    private var shouldLogPullUps: Bool {
        sessionExercises.contains(.pullUp)
    }

    private var shouldLogPushUps: Bool {
        sessionExercises.contains(.pushUp)
    }

    private var shouldLogPlank: Bool {
        sessionExercises.contains(.plank)
    }

    private var latestPullUps: Int {
        previousLogs.first(where: { $0.loggedPullUps })?.pullUps ?? profile.baselinePullUps
    }

    private var latestPushUps: Int {
        previousLogs.first(where: { $0.loggedPushUps })?.pushUps ?? profile.baselinePushUps
    }

    private var latestPlankSeconds: Int {
        previousLogs.first(where: { $0.loggedPlankSeconds })?.plankSeconds ?? profile.baselinePlankSeconds
    }

    private var requiredLogFieldsAreValid: Bool {
        (!shouldLogPullUps || parsedLogValue(pullUpsText, range: 0...300) != nil)
            && (!shouldLogPushUps || parsedLogValue(pushUpsText, range: 0...500) != nil)
            && (!shouldLogPlank || parsedLogValue(plankSecondsText, range: 0...3_600) != nil)
    }

    var body: some View {
        NavigationStack {
            ScreenBackground {
                LoggedWorkCard(
                    shouldLogPullUps: shouldLogPullUps,
                    shouldLogPushUps: shouldLogPushUps,
                    shouldLogPlank: shouldLogPlank,
                    pullUpsText: $pullUpsText,
                    pushUpsText: $pushUpsText,
                    plankSecondsText: $plankSecondsText,
                    focusedField: $focusedLogField
                )

                ReadinessInputCard(
                    rpe: $rpe,
                    painLevel: $painLevel,
                    howFelt: $howFelt
                )

                NotesCard(notes: $notes)

                if let saveError {
                    Text(saveError)
                        .font(.footnote)
                        .foregroundStyle(AppTheme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button("Save log", action: save)
                    .buttonStyle(PrimaryActionButtonStyle())
                    .disabled(!requiredLogFieldsAreValid || isSaving)
            }
            .navigationTitle("Log")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") {
                        focusedLogField = nil
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private func save() {
        focusedLogField = nil
        guard requiredLogFieldsAreValid, !isSaving else { return }
        isSaving = true
        saveError = nil

        let entry = StrengthLogEntry(
            pullUps: shouldLogPullUps ? parsedLogValue(pullUpsText, range: 0...300) ?? 0 : latestPullUps,
            pushUps: shouldLogPushUps ? parsedLogValue(pushUpsText, range: 0...500) ?? 0 : latestPushUps,
            plankSeconds: shouldLogPlank ? parsedLogValue(plankSecondsText, range: 0...3_600) ?? 0 : latestPlankSeconds,
            loggedPullUps: shouldLogPullUps,
            loggedPushUps: shouldLogPushUps,
            loggedPlankSeconds: shouldLogPlank,
            rpe: rpe,
            painLevel: painLevel,
            howFelt: howFelt,
            notes: notes
        )

        let result: (log: PerformanceLog, outcome: ScoreOutcome)
        do {
            result = try recordStrengthLog(entry, for: session, in: modelContext)
        } catch {
            // Nothing was saved; keep the sheet open so the athlete can retry.
            isSaving = false
            saveError = "Could not save this log: \(error.localizedDescription)"
            return
        }

        let sourceLogID = result.log.id
        let didTriggerDeload = result.outcome.didTriggerDeload
        Task {
            await afterTrainingLogged(
                endpoint: endpoint,
                profile: profile,
                modelID: selectedModelID,
                sourceLogId: sourceLogID,
                didTriggerDeload: didTriggerDeload,
                reason: "Strength training was completed.",
                in: modelContext
            )
        }
        dismiss()
    }

    private func parsedLogValue(_ text: String, range: ClosedRange<Int>) -> Int? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value = Int(trimmed) else { return nil }
        return min(range.upperBound, max(range.lowerBound, value))
    }
}

/// Everything that follows a saved log: reminders, the coach read, and a
/// post-training replan. When pain or a "very weak" feel asked for a deload
/// and the coach did not deliver a new plan (offline, busy, or skipped), the
/// next planned strength session is cut locally so the promise holds.
@MainActor
func afterTrainingLogged(
    endpoint: String,
    profile: UserProfile,
    modelID: String,
    sourceLogId: UUID?,
    didTriggerDeload: Bool,
    reason: String,
    in modelContext: ModelContext
) async {
    await refreshWorkoutReminders(in: modelContext)
    await CoachReadRefresher.refresh(endpoint: endpoint, profile: profile, modelID: modelID, sourceLogId: sourceLogId, in: modelContext)
    var appliedNewPlan = false
    if let request = try? makeCoachRequestFromStore(profile: profile, modelID: modelID, in: modelContext) {
        let outcome = await AutoPlanCoordinator.trigger(
            endpoint: endpoint,
            source: .postTraining,
            reason: reason,
            request: request,
            profile: profile,
            in: modelContext
        )
        appliedNewPlan = outcome.appliedNewPlan
    }
    if didTriggerDeload, !appliedNewPlan {
        _ = try? applyLocalDeload(in: modelContext)
        await refreshWorkoutReminders(in: modelContext)
    }
}

/// Logs a run by hand (no Garmin, watch not worn) or adds RPE and feel to a
/// run Garmin already completed.
struct LogRunView: View {
    enum Mode {
        case log(WorkoutSession)
        case rate(RunLog, WorkoutSession?)
    }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    // Configuration, not state: fixed per build flavor (see LocalCoachClient).
    private let endpoint = LocalCoachClient.defaultEndpointString
    @AppStorage("coachModelID") private var selectedModelID = CoachModelCatalog.defaultModelID

    var mode: Mode
    var profile: UserProfile

    @State private var distanceText: String
    @State private var minutesText = ""
    @State private var rpe: Int
    @State private var howFelt = 3
    @State private var notes = ""
    @State private var isSaving = false
    @State private var saveError: String?

    init(mode: Mode, profile: UserProfile) {
        self.mode = mode
        self.profile = profile
        switch mode {
        case .log(let session):
            let planned = session.plannedDistanceKm
            _distanceText = State(initialValue: planned > 0 ? planned.formatted(.number.precision(.fractionLength(0...1)).grouping(.never)) : "")
            _rpe = State(initialValue: initialLoggedRPE(for: session))
        case .rate(let log, let session):
            _distanceText = State(initialValue: "")
            _rpe = State(initialValue: log.rpe > 0 ? log.rpe : session.map(initialLoggedRPE(for:)) ?? 4)
            _howFelt = State(initialValue: log.rpe > 0 ? log.feelScore : 3)
        }
    }

    private var isLogMode: Bool {
        if case .log = mode { return true }
        return false
    }

    private var parsedDistanceKm: Double? {
        let trimmed = distanceText.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return 0 }
        guard let value = Double(trimmed.replacingOccurrences(of: ",", with: ".")), value >= 0, value <= 400 else { return nil }
        return value
    }

    private var parsedMinutes: Int? {
        let trimmed = minutesText.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return 0 }
        guard let value = Int(trimmed), value >= 0, value <= 3_000 else { return nil }
        return value
    }

    var body: some View {
        NavigationStack {
            ScreenBackground {
                if isLogMode {
                    VStack(alignment: .leading, spacing: 12) {
                        SectionHeader("Run")
                        runField(title: "Distance", text: $distanceText, suffix: "km", keyboard: .decimalPad)
                        Hairline()
                        runField(title: "Moving time", text: $minutesText, suffix: "min", keyboard: .numberPad)
                    }
                    .ruled(verticalPadding: 16)
                }

                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader("How it went")
                    ReadinessSlider(
                        title: "Perceived effort",
                        systemImage: "speedometer",
                        value: $rpe,
                        range: 1...10,
                        descriptor: ReadinessScale.perceivedEffort
                    )
                    Hairline()
                    ReadinessSlider(
                        title: "How did you feel?",
                        systemImage: "face.smiling",
                        value: $howFelt,
                        range: 1...5,
                        descriptor: ReadinessScale.howIFelt
                    )
                }
                .ruled(verticalPadding: 16)

                if isLogMode {
                    NotesCard(notes: $notes)
                }

                if let saveError {
                    Text(saveError)
                        .font(.footnote)
                        .foregroundStyle(AppTheme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button(isLogMode ? "Save run" : "Save rating", action: save)
                    .buttonStyle(PrimaryActionButtonStyle())
                    .disabled(isSaving || parsedDistanceKm == nil || parsedMinutes == nil)
                    .accessibilityIdentifier("save-run-log-button")
            }
            .navigationTitle(isLogMode ? "Log run" : "Rate run")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private func runField(title: String, text: Binding<String>, suffix: String, keyboard: UIKeyboardType) -> some View {
        HStack(spacing: 10) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AppTheme.text)
            Spacer()
            TextField("", text: text)
                .keyboardType(keyboard)
                .multilineTextAlignment(.trailing)
                .font(.system(size: 16, weight: .semibold).monospacedDigit())
                .foregroundStyle(AppTheme.text)
                .frame(width: 80)
                .accessibilityLabel(title)
            Text(suffix)
                .font(.footnote)
                .foregroundStyle(AppTheme.muted)
        }
    }

    private func save() {
        guard !isSaving, let distanceKm = parsedDistanceKm, let minutes = parsedMinutes else { return }
        isSaving = true
        saveError = nil
        let didTriggerDeload: Bool
        do {
            switch mode {
            case .log(let session):
                let status = try recordManualRun(
                    RunLogEntry(distanceKm: distanceKm, movingSeconds: minutes * 60, rpe: rpe, howFelt: howFelt, notes: notes),
                    for: session,
                    in: modelContext
                )
                didTriggerDeload = status == .deload
            case .rate(let log, let session):
                try rateRun(log, rpe: rpe, howFelt: howFelt, session: session, in: modelContext)
                didTriggerDeload = ReadinessScale.fatigueLevel(fromHowFelt: howFelt) >= 9
            }
        } catch {
            isSaving = false
            saveError = "Could not save this run: \(error.localizedDescription)"
            return
        }

        Task {
            await afterTrainingLogged(
                endpoint: endpoint,
                profile: profile,
                modelID: selectedModelID,
                sourceLogId: nil,
                didTriggerDeload: didTriggerDeload,
                reason: isLogMode ? "A run was logged." : "Run feedback was added.",
                in: modelContext
            )
        }
        dismiss()
    }
}

private struct LoggedWorkCard: View {
    var shouldLogPullUps: Bool
    var shouldLogPushUps: Bool
    var shouldLogPlank: Bool
    @Binding var pullUpsText: String
    @Binding var pushUpsText: String
    @Binding var plankSecondsText: String
    @FocusState.Binding var focusedField: LogMetricField?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader("Logged work") {
                if shouldLogPullUps || shouldLogPushUps || shouldLogPlank {
                    MicroLabel(text: "REQUIRED", color: AppTheme.accent)
                }
            }
            if shouldLogPullUps {
                LogNumberField(
                    title: "Best pull-up set",
                    text: $pullUpsText,
                    range: 0...300,
                    focusedField: $focusedField,
                    focusID: .pullUps
                )
            }
            if shouldLogPushUps {
                LogNumberField(
                    title: "Best push-up set",
                    text: $pushUpsText,
                    range: 0...500,
                    focusedField: $focusedField,
                    focusID: .pushUps
                )
            }
            if shouldLogPlank {
                LogNumberField(
                    title: "Longest plank hold",
                    text: $plankSecondsText,
                    range: 0...3_600,
                    suffix: "sec",
                    focusedField: $focusedField,
                    focusID: .plankSeconds
                )
            }
            if !shouldLogPullUps && !shouldLogPushUps && !shouldLogPlank {
                Text("No goal max test is planned in this session. Log readiness and notes only.")
                    .font(.footnote)
                    .foregroundStyle(AppTheme.muted)
            }
        }
        .ruled(verticalPadding: 16)
    }
}

private struct LogNumberField: View {
    var title: String
    @Binding var text: String
    var range: ClosedRange<Int>
    var suffix: String = ""
    @FocusState.Binding var focusedField: LogMetricField?
    var focusID: LogMetricField

    var body: some View {
        HStack(spacing: 10) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AppTheme.text)
                .lineLimit(2)
            Spacer()
            HStack(spacing: 6) {
                TextField("", text: $text)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.trailing)
                    .font(.system(size: 16, weight: .semibold).monospacedDigit())
                    .foregroundStyle(AppTheme.text)
                    .frame(width: 70)
                    .accessibilityLabel(title)
                    .focused($focusedField, equals: focusID)
                    .onChange(of: text) { _, newValue in
                        text = sanitized(newValue)
                    }
                if !suffix.isEmpty {
                    Text(suffix)
                        .font(.footnote)
                        .foregroundStyle(AppTheme.muted)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(AppTheme.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                    .strokeBorder(focusedField == focusID ? AppTheme.accent : AppTheme.divider, lineWidth: 1)
            )
            .animation(.easeOut(duration: 0.15), value: focusedField == focusID)
        }
    }

    private func sanitized(_ value: String) -> String {
        let digits = value.filter(\.isNumber)
        guard let intValue = Int(digits) else { return digits }
        if intValue > range.upperBound { return "\(range.upperBound)" }
        if intValue < range.lowerBound { return "\(range.lowerBound)" }
        return digits
    }
}

private struct ReadinessInputCard: View {
    @Binding var rpe: Int
    @Binding var painLevel: Int
    @Binding var howFelt: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader("Readiness")
            ReadinessSlider(
                title: "Perceived effort",
                systemImage: "speedometer",
                value: $rpe,
                range: 1...10,
                descriptor: ReadinessScale.perceivedEffort
            )
            Hairline()
            ReadinessSlider(
                title: "Pain",
                systemImage: "heart",
                value: $painLevel,
                range: 0...10,
                descriptor: ReadinessScale.pain
            )
            Hairline()
            ReadinessSlider(
                title: "How did you feel?",
                systemImage: "face.smiling",
                value: $howFelt,
                range: 1...5,
                descriptor: ReadinessScale.howIFelt
            )
        }
        .ruled(verticalPadding: 16)
    }
}

struct ReadinessSlider: View {
    var title: String
    var systemImage: String
    @Binding var value: Int
    var range: ClosedRange<Int>
    var descriptor: (Int) -> ReadinessDescriptor
    @State private var draftValue: Double?

    private var displayedValue: Int {
        let rawValue = Int((draftValue ?? Double(value)).rounded())
        return min(range.upperBound, max(range.lowerBound, rawValue))
    }

    private var sliderValue: Binding<Double> {
        Binding(
            get: { draftValue ?? Double(value) },
            set: { newValue in
                draftValue = min(Double(range.upperBound), max(Double(range.lowerBound), newValue))
            }
        )
    }

    var body: some View {
        let current = descriptor(displayedValue)

        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Label(title, systemImage: systemImage)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(AppTheme.text)
                        .lineLimit(2)
                        .minimumScaleFactor(0.85)

                    Text(current.detail)
                        .font(.system(size: 12))
                        .foregroundStyle(AppTheme.faint)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("\(displayedValue)")
                        .font(.lockinNumeral(20))
                        .contentTransition(.numericText())
                        .animation(.snappy(duration: 0.2), value: displayedValue)
                    Text(current.label)
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                }
                .foregroundStyle(current.color)
            }

            Slider(
                value: sliderValue,
                in: Double(range.lowerBound)...Double(range.upperBound),
                step: 1,
                onEditingChanged: handleEditingChanged
            )
            .tint(current.color)
            .controlSize(.small)
            .sensoryFeedback(.selection, trigger: displayedValue)
            // VoiceOver adjusts without drag callbacks, so commit directly.
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: value = min(range.upperBound, value + 1)
                case .decrement: value = max(range.lowerBound, value - 1)
                @unknown default: break
                }
                draftValue = nil
            }
        }
        .padding(.vertical, 4)
    }

    private func handleEditingChanged(_ isEditing: Bool) {
        if isEditing {
            draftValue = draftValue ?? Double(value)
        } else {
            value = displayedValue
            draftValue = nil
        }
    }
}

struct ReadinessDescriptor {
    var label: String
    var detail: String
    var color: Color
}

enum ReadinessScale {
    static func perceivedEffort(_ value: Int) -> ReadinessDescriptor {
        switch value {
        case 1:
            ReadinessDescriptor(label: "Very light", detail: "Warm-up effort. Plenty left in the tank.", color: AppTheme.accent)
        case 2:
            ReadinessDescriptor(label: "Easy", detail: "Breathing is calm and the work feels repeatable.", color: AppTheme.accent)
        case 3:
            ReadinessDescriptor(label: "Light", detail: "Comfortable effort with no real strain.", color: AppTheme.accent)
        case 4:
            ReadinessDescriptor(label: "Steady", detail: "Working, but you could keep this pace cleanly.", color: AppTheme.accent)
        case 5:
            ReadinessDescriptor(label: "Moderate", detail: "Solid effort. Challenging without feeling heavy.", color: AppTheme.gold)
        case 6:
            ReadinessDescriptor(label: "Somewhat hard", detail: "Focus required. Several clean reps still left.", color: AppTheme.gold)
        case 7:
            ReadinessDescriptor(label: "Hard", detail: "Hard set. Roughly three clean reps left.", color: AppTheme.gold)
        case 8:
            ReadinessDescriptor(label: "Very hard", detail: "Very hard. Around two clean reps left.", color: AppTheme.gold)
        case 9:
            ReadinessDescriptor(label: "Near max", detail: "Near your limit. About one clean rep left.", color: AppTheme.warning)
        default:
            ReadinessDescriptor(label: "Max effort", detail: "Maximum effort. No clean reps left.", color: AppTheme.warning)
        }
    }

    static func pain(_ value: Int) -> ReadinessDescriptor {
        switch value {
        case 0:
            ReadinessDescriptor(label: "None", detail: "No pain.", color: AppTheme.accent)
        case 1:
            ReadinessDescriptor(label: "Tiny", detail: "Barely noticeable discomfort.", color: AppTheme.accent)
        case 2:
            ReadinessDescriptor(label: "Mild", detail: "Annoying, but not limiting your movement.", color: AppTheme.accent)
        case 3:
            ReadinessDescriptor(label: "Manageable", detail: "Noticeable, but clean form still feels normal.", color: AppTheme.gold)
        case 4:
            ReadinessDescriptor(label: "Moderate", detail: "Moderate pain. Lockin will deload after saving.", color: AppTheme.warning)
        case 5:
            ReadinessDescriptor(label: "Moderate", detail: "Pain is affecting comfort or mechanics.", color: AppTheme.warning)
        case 6:
            ReadinessDescriptor(label: "Strong", detail: "Hard to ignore. Keep stress low.", color: AppTheme.warning)
        case 7:
            ReadinessDescriptor(label: "Severe", detail: "Severe pain. Hard training is a bad signal today.", color: AppTheme.warning)
        case 8:
            ReadinessDescriptor(label: "Very severe", detail: "Movement quality is compromised.", color: AppTheme.warning)
        case 9:
            ReadinessDescriptor(label: "Extreme", detail: "Nearly intolerable pain.", color: AppTheme.warning)
        default:
            ReadinessDescriptor(label: "Worst", detail: "Worst imaginable pain.", color: AppTheme.warning)
        }
    }

    static func howIFelt(_ value: Int) -> ReadinessDescriptor {
        switch value {
        case 1:
            ReadinessDescriptor(label: "Very weak", detail: "Bad day. Recovery should win.", color: AppTheme.warning)
        case 2:
            ReadinessDescriptor(label: "Weak", detail: "Off or heavy. Keep stress modest.", color: AppTheme.gold)
        case 3:
            ReadinessDescriptor(label: "Normal", detail: "Fine enough. Nothing special to flag.", color: AppTheme.accent)
        case 4:
            ReadinessDescriptor(label: "Strong", detail: "Good day. You felt solid after training.", color: AppTheme.accent)
        default:
            ReadinessDescriptor(label: "Very strong", detail: "Great day. You finished feeling sharp.", color: AppTheme.accent)
        }
    }

    static func fatigueLevel(fromHowFelt value: Int) -> Int {
        switch value {
        case 1:
            return 10
        case 2:
            return 8
        case 3:
            return 5
        case 4:
            return 2
        default:
            return 0
        }
    }
}

private struct NotesCard: View {
    @Binding var notes: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader("Notes")
            TextField("What changed?", text: $notes, axis: .vertical)
                .font(.subheadline)
                .lockinField()
        }
        .ruled(verticalPadding: 16)
    }
}
