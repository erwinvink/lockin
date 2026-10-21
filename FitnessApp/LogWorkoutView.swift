import SwiftData
import SwiftUI

private enum LogMetricField: Hashable {
    case pullUps
    case pushUps
    case plankSeconds
}

/// The RPE the plan asked for, or 0 when the session has none. Display only:
/// the slider's starting value comes from `initialLoggedRPE(for:)`.
private func plannedRPE(for session: WorkoutSession) -> Int {
    if (1...10).contains(session.plannedEffortTargetRPE) {
        return session.plannedEffortTargetRPE
    }
    return session.plannedEffortLabel?.defaultTargetRPE ?? 0
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

    private var sessionMetaText: String {
        let date = session.scheduledDate.formatted(.dateTime.weekday(.wide).day().month(.wide))
        let minutes = estimatedWorkoutDurationMinutes(for: session, prescriptions: sessionPrescriptions)
        return minutes > 0 ? "\(date), \(signDurationText(minutes: minutes)) planned" : date
    }

    var body: some View {
        NavigationStack {
            ScreenBackground {
                LogSessionHeader(
                    title: session.title,
                    meta: sessionMetaText,
                    plannedRPE: plannedRPE(for: session)
                )

                LoggedWorkSection(
                    shouldLogPullUps: shouldLogPullUps,
                    shouldLogPushUps: shouldLogPushUps,
                    shouldLogPlank: shouldLogPlank,
                    latestPullUps: latestPullUps,
                    latestPushUps: latestPushUps,
                    latestPlankSeconds: latestPlankSeconds,
                    pullUpsText: $pullUpsText,
                    pushUpsText: $pushUpsText,
                    plankSecondsText: $plankSecondsText,
                    focusedField: $focusedLogField
                )

                EffortSection(rpe: $rpe, plannedRPE: plannedRPE(for: session))

                PainSection(painLevel: $painLevel)

                FeelSection(howFelt: $howFelt)

                NotesSection(notes: $notes)

                if let saveError {
                    SaveErrorText(text: saveError)
                }

                Button("Save log", action: save)
                    .buttonStyle(PrimaryActionButtonStyle())
                    .disabled(!requiredLogFieldsAreValid || isSaving)
            }
            .navigationTitle("Log session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(AppTheme.muted)
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
        .presentationBackground(AppTheme.background)
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

    private enum RunField: Hashable {
        case distance
        case minutes
    }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    // Configuration, not state: fixed per build flavor (see LocalCoachClient).
    private let endpoint = LocalCoachClient.defaultEndpointString
    @AppStorage("coachModelID") private var selectedModelID = CoachModelCatalog.defaultModelID

    var mode: Mode
    var profile: UserProfile

    @FocusState private var focusedField: RunField?
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

    private var session: WorkoutSession? {
        switch mode {
        case .log(let session): session
        case .rate(_, let session): session
        }
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
                if let session {
                    LogSessionHeader(
                        title: session.title,
                        meta: session.scheduledDate.formatted(.dateTime.weekday(.wide).day().month(.wide)),
                        plannedRPE: plannedRPE(for: session)
                    )
                }

                if isLogMode {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Run")
                            .font(.trail(17, .semibold, relativeTo: .headline))
                            .foregroundStyle(AppTheme.text)
                        VStack(spacing: 0) {
                            runField(title: "Distance", text: $distanceText, suffix: "km", keyboard: .decimalPad, field: .distance)
                            Hairline()
                            runField(title: "Moving time", text: $minutesText, suffix: "min", keyboard: .numberPad, field: .minutes)
                        }
                        .padding(.horizontal, 14)
                        .card(padding: 0)
                    }
                }

                EffortSection(rpe: $rpe, plannedRPE: session.map(plannedRPE(for:)) ?? 0)

                FeelSection(howFelt: $howFelt)

                if isLogMode {
                    NotesSection(notes: $notes)
                }

                if let saveError {
                    SaveErrorText(text: saveError)
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
                        .foregroundStyle(AppTheme.muted)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") {
                        focusedField = nil
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .presentationBackground(AppTheme.background)
    }

    private func runField(
        title: String,
        text: Binding<String>,
        suffix: String,
        keyboard: UIKeyboardType,
        field: RunField
    ) -> some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.trail(16, .medium, relativeTo: .body))
                .foregroundStyle(AppTheme.text)
            Spacer(minLength: 8)
            TextField("–", text: text)
                .keyboardType(keyboard)
                .multilineTextAlignment(.trailing)
                .font(.trail(22, .bold, relativeTo: .title2).monospacedDigit())
                .foregroundStyle(AppTheme.text)
                .frame(width: 90)
                .focused($focusedField, equals: field)
                .accessibilityLabel(title)
            Text(suffix)
                .font(.lockinMeta)
                .foregroundStyle(AppTheme.muted)
                .frame(width: 28, alignment: .leading)
        }
        .frame(minHeight: 60)
    }

    private func save() {
        focusedField = nil
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

// MARK: - Header and errors

private struct LogSessionHeader: View {
    var title: String
    var meta: String
    var plannedRPE: Int

    var body: some View {
        HStack(alignment: .bottom, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.trail(24, .bold, relativeTo: .title2))
                    .foregroundStyle(AppTheme.text)
                Text(meta)
                    .font(.trail(14, .regular, relativeTo: .subheadline))
                    .foregroundStyle(AppTheme.muted)
            }
            Spacer(minLength: 8)
            if (1...10).contains(plannedRPE) {
                HStack(spacing: 7) {
                    TrailMark(grade: TrailGrade(PlannedEffortLabel.fromRPE(plannedRPE)))
                    Text("Planned RPE \(plannedRPE)")
                        .font(.lockinMeta.monospacedDigit())
                        .foregroundStyle(AppTheme.muted)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// A failed save keeps the sheet open and says why, in the marker red.
private struct SaveErrorText: View {
    var text: String

    var body: some View {
        Label {
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
        }
        .font(.trail(14, .semibold, relativeTo: .subheadline))
        .foregroundStyle(AppTheme.markerRedText)
    }
}

// MARK: - Logged work

private struct LoggedWorkSection: View {
    var shouldLogPullUps: Bool
    var shouldLogPushUps: Bool
    var shouldLogPlank: Bool
    var latestPullUps: Int
    var latestPushUps: Int
    var latestPlankSeconds: Int
    @Binding var pullUpsText: String
    @Binding var pushUpsText: String
    @Binding var plankSecondsText: String
    @FocusState.Binding var focusedField: LogMetricField?

    private var hasRequiredWork: Bool {
        shouldLogPullUps || shouldLogPushUps || shouldLogPlank
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Best strict set")
                    .font(.trail(17, .semibold, relativeTo: .headline))
                Spacer()
                if hasRequiredWork {
                    Text("Required")
                        .font(.trail(12, .semibold, relativeTo: .caption1))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(RoundedRectangle(cornerRadius: 4).fill(AppTheme.sign))
                }
            }
            .foregroundStyle(AppTheme.text)

            if hasRequiredWork {
                VStack(spacing: 0) {
                    if shouldLogPullUps {
                        LogStepperRow(
                            title: "Pull-ups",
                            text: $pullUpsText,
                            range: 0...300,
                            step: 1,
                            startValue: latestPullUps,
                            hint: "Last \(latestPullUps)",
                            focusedField: $focusedField,
                            focusID: .pullUps
                        )
                    }
                    if shouldLogPullUps && (shouldLogPushUps || shouldLogPlank) {
                        Hairline()
                    }
                    if shouldLogPushUps {
                        LogStepperRow(
                            title: "Push-ups",
                            text: $pushUpsText,
                            range: 0...500,
                            step: 1,
                            startValue: latestPushUps,
                            hint: "Last \(latestPushUps)",
                            focusedField: $focusedField,
                            focusID: .pushUps
                        )
                    }
                    if shouldLogPushUps && shouldLogPlank {
                        Hairline()
                    }
                    if shouldLogPlank {
                        LogStepperRow(
                            title: "Plank",
                            text: $plankSecondsText,
                            range: 0...3_600,
                            step: 5,
                            startValue: latestPlankSeconds,
                            hint: "Last \(latestPlankSeconds) sec",
                            suffix: "sec",
                            focusedField: $focusedField,
                            focusID: .plankSeconds
                        )
                    }
                }
                .padding(.horizontal, 14)
                .card(padding: 0)
            } else {
                Text("No max test in this session. Log effort and notes only.")
                    .font(.lockinBody)
                    .foregroundStyle(AppTheme.muted)
            }
        }
    }
}

/// One logged number: type it, or nudge it with − and +. An empty field
/// starts from the last logged value on the first nudge.
private struct LogStepperRow: View {
    var title: String
    @Binding var text: String
    var range: ClosedRange<Int>
    var step: Int
    var startValue: Int
    var hint: String
    var suffix: String = ""
    @FocusState.Binding var focusedField: LogMetricField?
    var focusID: LogMetricField

    private var currentValue: Int? {
        Int(text)
    }

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.trail(16, .medium, relativeTo: .body))
                    .foregroundStyle(AppTheme.text)
                Text(hint)
                    .font(.lockinMeta.monospacedDigit())
                    .foregroundStyle(AppTheme.muted)
            }
            Spacer(minLength: 8)

            stepButton(systemImage: "minus", label: "Less \(title.lowercased())") {
                let base = currentValue ?? startValue
                text = "\(max(range.lowerBound, currentValue == nil ? base : base - step))"
            }

            HStack(spacing: 4) {
                TextField("–", text: $text)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.center)
                    .font(.trail(22, .bold, relativeTo: .title2).monospacedDigit())
                    .foregroundStyle(AppTheme.text)
                    .frame(width: suffix.isEmpty ? 64 : 56)
                    .accessibilityLabel(title)
                    .focused($focusedField, equals: focusID)
                    .onChange(of: text) { _, newValue in
                        text = sanitized(newValue)
                    }
                if !suffix.isEmpty {
                    Text(suffix)
                        .font(.lockinMeta)
                        .foregroundStyle(AppTheme.muted)
                }
            }

            stepButton(systemImage: "plus", label: "More \(title.lowercased())") {
                let base = currentValue ?? startValue
                text = "\(min(range.upperBound, currentValue == nil ? base : base + step))"
            }
        }
        .frame(minHeight: 64)
    }

    private func stepButton(systemImage: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(AppTheme.text)
                .frame(width: 44, height: 44)
                .background(
                    RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                        .strokeBorder(AppTheme.post.opacity(0.7), lineWidth: 1)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func sanitized(_ value: String) -> String {
        let digits = value.filter(\.isNumber)
        guard let intValue = Int(digits) else { return digits }
        if intValue > range.upperBound { return "\(range.upperBound)" }
        if intValue < range.lowerBound { return "\(range.lowerBound)" }
        return digits
    }
}

// MARK: - Scales

/// A row of tappable values; the selected one is filled granite. Each value
/// is its own button, so VoiceOver can pick any value directly.
private struct ScaleSelector<Cell: View>: View {
    var accessibilityName: String
    var values: [Int]
    @Binding var selection: Int
    var spacing: CGFloat = 4
    var minHeight: CGFloat = 44
    @ViewBuilder var cell: (Int, Bool) -> Cell

    var body: some View {
        HStack(spacing: spacing) {
            ForEach(values, id: \.self) { value in
                let isSelected = value == selection
                Button {
                    selection = value
                } label: {
                    cell(value, isSelected)
                        .foregroundStyle(isSelected ? Color.white : AppTheme.text)
                        .frame(maxWidth: .infinity, minHeight: minHeight)
                        .background(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(isSelected ? AppTheme.text : AppTheme.surface)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .strokeBorder(isSelected ? Color.clear : AppTheme.divider, lineWidth: 1)
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .sensoryFeedback(.selection, trigger: selection)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityName)
    }
}

private struct ScaleHeading: View {
    var title: String
    var valueText: String

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.trail(17, .semibold, relativeTo: .headline))
            Spacer()
            Text(valueText)
                .font(.trail(15, .semibold, relativeTo: .subheadline).monospacedDigit())
        }
        .foregroundStyle(AppTheme.text)
    }
}

private struct EffortSection: View {
    @Binding var rpe: Int
    var plannedRPE: Int

    private var comparisonText: String? {
        guard (1...10).contains(plannedRPE) else { return nil }
        let difference = rpe - plannedRPE
        if difference == 0 { return "Right on plan (planned \(plannedRPE))" }
        return difference > 0
            ? "\(difference) above plan (planned \(plannedRPE))"
            : "\(-difference) below plan (planned \(plannedRPE))"
    }

    var body: some View {
        let descriptor = ReadinessScale.perceivedEffort(rpe)
        VStack(alignment: .leading, spacing: 8) {
            ScaleHeading(title: "Perceived effort", valueText: "\(rpe), \(descriptor.label)")

            VStack(spacing: 4) {
                ScaleSelector(accessibilityName: "Perceived effort", values: Array(1...10), selection: $rpe) { value, _ in
                    Text("\(value)")
                        .font(.trail(16, .bold, relativeTo: .headline).monospacedDigit())
                        .accessibilityLabel("RPE \(value)")
                }
                // Each value's trail grade, so the scale reads like the plan.
                HStack(spacing: 4) {
                    ForEach(1...10, id: \.self) { value in
                        TrailMark(grade: TrailGrade(PlannedEffortLabel.fromRPE(value)), width: nil, height: 6)
                    }
                }
                .accessibilityHidden(true)
            }

            Text([descriptor.detail, comparisonText].compactMap { $0 }.joined(separator: " "))
                .font(.lockinMeta)
                .foregroundStyle(AppTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct PainSection: View {
    @Binding var painLevel: Int

    var body: some View {
        let descriptor = ReadinessScale.pain(painLevel)
        VStack(alignment: .leading, spacing: 8) {
            ScaleHeading(
                title: "Pain",
                valueText: painLevel == 0 ? "No pain" : "\(painLevel), \(descriptor.label)"
            )

            ScaleSelector(accessibilityName: "Pain", values: Array(0...10), selection: $painLevel, spacing: 3) { value, _ in
                Text("\(value)")
                    .font(.trail(15, .bold, relativeTo: .headline).monospacedDigit())
                    .accessibilityLabel("Pain \(value)")
            }

            Text(descriptor.detail)
                .font(.lockinMeta)
                .foregroundStyle(painLevel >= 4 ? AppTheme.markerRedText : AppTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct FeelSection: View {
    @Binding var howFelt: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScaleHeading(title: "How did you feel?", valueText: "")

            ScaleSelector(accessibilityName: "How did you feel", values: Array(1...5), selection: $howFelt, minHeight: 52) { value, _ in
                Text(ReadinessScale.howIFelt(value).label)
                    .font(.trail(13, .semibold, relativeTo: .footnote))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
                    .padding(.horizontal, 2)
            }

            Text(ReadinessScale.howIFelt(howFelt).detail)
                .font(.lockinMeta)
                .foregroundStyle(AppTheme.muted)
        }
    }
}

private struct NotesSection: View {
    @Binding var notes: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Notes")
                .font(.trail(17, .semibold, relativeTo: .headline))
                .foregroundStyle(AppTheme.text)
            TextField("What changed? Grip, sleep, soreness…", text: $notes, axis: .vertical)
                .font(.lockinBody)
                .lineLimit(3...6)
                .lockinField()
        }
    }
}

// MARK: - Readiness scales

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
