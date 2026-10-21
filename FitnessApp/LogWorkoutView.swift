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
    @Query private var ranks: [RankState]
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \SetPrescription.orderIndex) private var prescriptions: [SetPrescription]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var previousLogs: [PerformanceLog]
    @Query(sort: \RaceGoal.createdAt) private var raceGoals: [RaceGoal]
    @Query(sort: \RunLog.completedAt, order: .reverse) private var runLogs: [RunLog]
    // Configuration, not state: fixed per build flavor (see LocalCoachClient).
    private let endpoint = LocalCoachClient.defaultEndpointString
    @AppStorage("coachModelID") private var selectedModelID = CoachModelCatalog.defaultModelID

    var session: WorkoutSession
    var profile: UserProfile

    @FocusState private var focusedLogField: LogMetricField?
    @State private var pullUpsText = ""
    @State private var pushUpsText = ""
    @State private var plankSecondsText = ""
    @State private var rpe = 7
    @State private var didApplyPlannedRPE = false
    @State private var painLevel = 0
    @State private var howFelt = 3
    @State private var notes = ""

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

    private var plannedRPEForLog: Int {
        if (1...10).contains(session.plannedEffortTargetRPE) {
            return session.plannedEffortTargetRPE
        }
        return session.plannedEffortLabel?.defaultTargetRPE ?? 0
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
                    plannedRPE: plannedRPEForLog
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

                EffortSection(rpe: $rpe, plannedRPE: plannedRPEForLog)

                PainSection(painLevel: $painLevel)

                FeelSection(howFelt: $howFelt)

                NotesSection(notes: $notes)

                Button("Save log", action: save)
                    .buttonStyle(PrimaryActionButtonStyle())
                    .disabled(!requiredLogFieldsAreValid)
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
            .onAppear(perform: applyPlannedRPE)
        }
        .presentationBackground(AppTheme.background)
    }

    /// Effort starts at what the plan asked for, so logging "as planned" is
    /// one tap and a harder or easier session is a deliberate change.
    private func applyPlannedRPE() {
        guard !didApplyPlannedRPE else { return }
        didApplyPlannedRPE = true
        if (1...10).contains(plannedRPEForLog) {
            rpe = plannedRPEForLog
        }
    }

    private func save() {
        focusedLogField = nil
        guard requiredLogFieldsAreValid else { return }

        let loggedPullUps = shouldLogPullUps
        let loggedPushUps = shouldLogPushUps
        let loggedPlankSeconds = shouldLogPlank
        let savedPullUps = shouldLogPullUps ? parsedLogValue(pullUpsText, range: 0...300) ?? 0 : latestPullUps
        let savedPushUps = shouldLogPushUps ? parsedLogValue(pushUpsText, range: 0...500) ?? 0 : latestPushUps
        let savedPlankSeconds = shouldLogPlank ? parsedLogValue(plankSecondsText, range: 0...3_600) ?? 0 : latestPlankSeconds
        let fatigueLevel = ReadinessScale.fatigueLevel(fromHowFelt: howFelt)
        let log = PerformanceLog(
            sessionId: session.id,
            pullUps: savedPullUps,
            pushUps: savedPushUps,
            plankSeconds: savedPlankSeconds,
            loggedPullUps: loggedPullUps,
            loggedPushUps: loggedPushUps,
            loggedPlankSeconds: loggedPlankSeconds,
            rpe: rpe,
            plannedRPE: plannedRPEForLog,
            plannedEffortLabelAtLog: session.plannedEffortLabel,
            plannedEffortReasonAtLog: session.plannedEffortReason,
            painLevel: painLevel,
            fatigueLevel: fatigueLevel,
            notes: notes
        )
        modelContext.insert(log)
        session.status = painLevel >= 4 || fatigueLevel >= 9 ? .deload : .completed

        let outcome = TrainingEngine().score(
            log: SessionLogInput(
                completed: true,
                pullUps: savedPullUps,
                pushUps: savedPushUps,
                plankSeconds: savedPlankSeconds,
                loggedPullUps: loggedPullUps,
                loggedPushUps: loggedPushUps,
                loggedPlankSeconds: loggedPlankSeconds,
                rpe: rpe,
                painLevel: painLevel,
                fatigueLevel: fatigueLevel
            ),
            plannedSession: nil
        )
        let rank = ranks.first ?? RankState()
        if ranks.isEmpty { modelContext.insert(rank) }
        applyScoreOutcome(outcome, to: rank)

        if outcome.didTriggerDeload {
            let coachPlan = CoachPlan(weekStart: Date(), summary: outcome.reason, source: .rules, validationStatus: .clamped)
            modelContext.insert(coachPlan)
            modelContext.insert(CoachDecision(planId: coachPlan.id, rationale: outcome.reason, safetyFlags: ["auto-deload"]))
        }

        do {
            try modelContext.save()
            queueCoachVerdictRefresh(sourceLogID: log.id, logsIncludingSavedLog: previousLogs + [log])
            queueAutoPlanAfterTraining(logsIncludingSavedLog: previousLogs + [log])
        } catch {
            // Keep the current UX quiet; failed saves leave the sheet without starting a coach refresh.
        }
        dismiss()
    }

    private func queueCoachVerdictRefresh(sourceLogID: UUID, logsIncludingSavedLog: [PerformanceLog]) {
        UserDefaults.standard.set(true, forKey: CoachVerdictRefreshFlag.needsRefreshKey)
        let request = makeCoachRequest(
            profile: profile,
            modelID: selectedModelID,
            logs: logsIncludingSavedLog,
            sessions: sessions,
            prescriptions: prescriptions,
            raceGoal: raceGoals.first,
            runLogs: runLogs,
            weekStart: rollingPlanStart()
        )

        Task {
            await refreshCoachVerdict(request: request, sourceLogID: sourceLogID)
        }
    }

    private func refreshCoachVerdict(request: CoachPlanRequest, sourceLogID: UUID) async {
        do {
            let response = try await LocalCoachClient(endpointString: endpoint).generateVerdict(request: request)
            modelContext.insert(CoachVerdict(response: response, sourceLogId: sourceLogID))
            try modelContext.save()
            UserDefaults.standard.set(false, forKey: CoachVerdictRefreshFlag.needsRefreshKey)
        } catch {
            UserDefaults.standard.set(true, forKey: CoachVerdictRefreshFlag.needsRefreshKey)
        }
    }

    private func queueAutoPlanAfterTraining(logsIncludingSavedLog: [PerformanceLog]) {
        let request = makeCoachRequest(
            profile: profile,
            modelID: selectedModelID,
            logs: logsIncludingSavedLog,
            sessions: sessions,
            prescriptions: prescriptions,
            raceGoal: raceGoals.first,
            runLogs: runLogs,
            weekStart: rollingPlanStart()
        )

        Task {
            _ = await AutoPlanCoordinator.trigger(
                endpoint: endpoint,
                source: .postTraining,
                reason: "Strength training was completed.",
                request: request,
                profile: profile,
                in: modelContext
            )
        }
    }

    private func parsedLogValue(_ text: String, range: ClosedRange<Int>) -> Int? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value = Int(trimmed) else { return nil }
        return min(range.upperBound, max(range.lowerBound, value))
    }
}

// MARK: - Header

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

/// A row of tappable values; the selected one is filled granite.
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
