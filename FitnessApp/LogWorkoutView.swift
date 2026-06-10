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
    @AppStorage("coachProxyEndpoint") private var endpoint = LocalCoachClient.defaultEndpointString
    @AppStorage("coachModelID") private var selectedModelID = CoachModelCatalog.defaultModelID

    var session: WorkoutSession
    var profile: UserProfile

    @FocusState private var focusedLogField: LogMetricField?
    @State private var pullUpsText = ""
    @State private var pushUpsText = ""
    @State private var plankSecondsText = ""
    @State private var rpe = 7
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

                Button("Save log", action: save)
                    .buttonStyle(PrimaryActionButtonStyle())
                    .disabled(!requiredLogFieldsAreValid)
                    .opacity(requiredLogFieldsAreValid ? 1 : 0.45)
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

    private func parsedLogValue(_ text: String, range: ClosedRange<Int>) -> Int? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value = Int(trimmed) else { return nil }
        return min(range.upperBound, max(range.lowerBound, value))
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
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Logged work")
                    .font(.headline)
                Spacer()
                if shouldLogPullUps || shouldLogPushUps || shouldLogPlank {
                    Text("Required")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(AppTheme.accent)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(AppTheme.accentSoft)
                        .clipShape(Capsule())
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
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            }
        }
        .card(padding: 12)
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
                    .font(.system(.body, design: .rounded, weight: .semibold))
                    .foregroundStyle(AppTheme.text)
                    .frame(width: 70)
                    .accessibilityLabel(title)
                    .focused($focusedField, equals: focusID)
                    .onChange(of: text) { _, newValue in
                        text = sanitized(newValue)
                    }
                if !suffix.isEmpty {
                    Text(suffix)
                        .font(.caption)
                        .foregroundStyle(AppTheme.muted)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(AppTheme.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                    .stroke(focusedField == focusID ? AppTheme.accent.opacity(0.7) : AppTheme.divider, lineWidth: 1)
            )
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
        VStack(alignment: .leading, spacing: 6) {
            Text("Readiness")
                .font(.headline)
            ReadinessSlider(
                title: "Perceived effort",
                systemImage: "speedometer",
                value: $rpe,
                range: 1...10,
                descriptor: ReadinessScale.perceivedEffort
            )
            Divider()
            ReadinessSlider(
                title: "Pain",
                systemImage: "heart",
                value: $painLevel,
                range: 0...10,
                descriptor: ReadinessScale.pain
            )
            Divider()
            ReadinessSlider(
                title: "How did you feel?",
                systemImage: "face.smiling",
                value: $howFelt,
                range: 1...5,
                descriptor: ReadinessScale.howIFelt
            )
        }
        .card(padding: 10)
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

        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    Label(title, systemImage: systemImage)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppTheme.text)
                        .lineLimit(2)
                        .minimumScaleFactor(0.85)

                    Text(current.detail)
                        .font(.caption2)
                        .foregroundStyle(AppTheme.muted)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                HStack(spacing: 6) {
                    Text("\(displayedValue)")
                        .font(.system(.body, design: .rounded, weight: .bold))
                    Text(current.label)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                }
                .foregroundStyle(current.color)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(current.color.opacity(0.12))
                .clipShape(Capsule())
            }

            Slider(
                value: sliderValue,
                in: Double(range.lowerBound)...Double(range.upperBound),
                step: 1,
                onEditingChanged: handleEditingChanged
            )
                .tint(current.color)
                .controlSize(.small)
        }
        .padding(.vertical, 1)
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
            Text("Notes")
                .font(.headline)
            TextField("What changed?", text: $notes, axis: .vertical)
                .textFieldStyle(.roundedBorder)
        }
        .card(padding: 12)
    }
}

struct LogRunView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Query private var ranks: [RankState]

    var session: WorkoutSession

    /// Pending Garmin log being edited; save() updates it in place instead of
    /// inserting a duplicate.
    private let prefillLog: RunLog?

    @FocusState private var distanceFieldIsFocused: Bool
    @State private var distanceText: String
    @State private var movingMinutes: Int
    @State private var elevationGainM: Int
    @State private var averageHr = 0
    @State private var rpe = 6
    @State private var howFelt = 3
    @State private var notes = ""

    init(session: WorkoutSession) {
        self.session = session
        self.prefillLog = nil
        _distanceText = State(initialValue: session.plannedDistanceKm > 0
            ? session.plannedDistanceKm.formatted(.number.precision(.fractionLength(0...1)).grouping(.never))
            : "")
        _movingMinutes = State(initialValue: max(0, session.estimatedDurationMinutes))
        _elevationGainM = State(initialValue: max(0, session.plannedElevationM))
    }

    init(session: WorkoutSession, prefilledFrom log: RunLog) {
        self.session = session
        self.prefillLog = log
        _distanceText = State(initialValue: log.distanceKm > 0
            ? log.distanceKm.formatted(.number.precision(.fractionLength(0...2)).grouping(.never))
            : "")
        _movingMinutes = State(initialValue: max(0, log.movingSeconds / 60))
        _elevationGainM = State(initialValue: max(0, log.elevationGainM))
        _averageHr = State(initialValue: max(0, log.averageHr))
        _rpe = State(initialValue: (1...10).contains(log.rpe) ? log.rpe : 6)
        _howFelt = State(initialValue: (1...5).contains(log.feelScore) ? log.feelScore : 3)
        _notes = State(initialValue: log.notes)
    }

    private var parsedDistanceKm: Double? {
        let normalized = distanceText
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: ",", with: ".")
        guard let value = Double(normalized), value > 0, value <= 500 else { return nil }
        return value
    }

    private var canSave: Bool {
        parsedDistanceKm != nil
    }

    var body: some View {
        NavigationStack {
            ScreenBackground {
                RunWorkCard(
                    distanceText: $distanceText,
                    movingMinutes: $movingMinutes,
                    elevationGainM: $elevationGainM,
                    averageHr: $averageHr,
                    distanceIsValid: parsedDistanceKm != nil,
                    distanceFieldIsFocused: $distanceFieldIsFocused
                )

                VStack(alignment: .leading, spacing: 6) {
                    Text("Readiness")
                        .font(.headline)
                    ReadinessSlider(
                        title: "Perceived effort",
                        systemImage: "speedometer",
                        value: $rpe,
                        range: 1...10,
                        descriptor: ReadinessScale.perceivedEffort
                    )
                    Divider()
                    ReadinessSlider(
                        title: "How did you feel?",
                        systemImage: "face.smiling",
                        value: $howFelt,
                        range: 1...5,
                        descriptor: ReadinessScale.howIFelt
                    )
                }
                .card(padding: 10)

                NotesCard(notes: $notes)

                Button("Save run", action: save)
                    .buttonStyle(PrimaryActionButtonStyle())
                    .disabled(!canSave)
                    .opacity(canSave ? 1 : 0.45)
                    .accessibilityIdentifier("save-run-button")
            }
            .navigationTitle("Log run")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") {
                        distanceFieldIsFocused = false
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private func save() {
        guard session.status == .planned else { return }
        distanceFieldIsFocused = false
        guard let distanceKm = parsedDistanceKm else { return }

        let movingSeconds = max(0, movingMinutes) * 60
        let pace = distanceKm > 0 && movingSeconds > 0 ? Int(Double(movingSeconds) / distanceKm) : 0
        let fatigueLevel = ReadinessScale.fatigueLevel(fromHowFelt: howFelt)
        if let prefillLog {
            // Editing a synced Garmin log: update it in place (keeping its
            // completedAt, source, and activity id) instead of duplicating it.
            prefillLog.distanceKm = distanceKm
            prefillLog.movingSeconds = movingSeconds
            prefillLog.elevationGainM = max(0, elevationGainM)
            prefillLog.averageHr = max(0, averageHr)
            prefillLog.averagePaceSecPerKm = pace
            prefillLog.rpe = rpe
            prefillLog.feelScore = howFelt
            prefillLog.notes = notes
            prefillLog.needsConfirmation = false
        } else {
            modelContext.insert(RunLog(
                sessionId: session.id,
                completedAt: Date(),
                distanceKm: distanceKm,
                movingSeconds: movingSeconds,
                elevationGainM: max(0, elevationGainM),
                averageHr: max(0, averageHr),
                averagePaceSecPerKm: pace,
                rpe: rpe,
                feelScore: howFelt,
                notes: notes,
                source: .manual,
                needsConfirmation: false
            ))
        }
        session.status = .completed

        let outcome = TrainingEngine().score(
            log: SessionLogInput(
                completed: true,
                pullUps: 0,
                pushUps: 0,
                plankSeconds: 0,
                loggedPullUps: false,
                loggedPushUps: false,
                loggedPlankSeconds: false,
                rpe: rpe,
                painLevel: 0,
                fatigueLevel: fatigueLevel
            ),
            plannedSession: nil
        )
        let rank = ranks.first ?? RankState()
        if ranks.isEmpty { modelContext.insert(rank) }
        applyScoreOutcome(outcome, to: rank)
        session.scoreImpact = outcome.consistencyDelta

        do {
            try modelContext.save()
        } catch {
            // Keep the current UX quiet; a failed save just leaves the sheet.
        }
        dismiss()
    }
}

private struct RunWorkCard: View {
    @Binding var distanceText: String
    @Binding var movingMinutes: Int
    @Binding var elevationGainM: Int
    @Binding var averageHr: Int
    var distanceIsValid: Bool
    @FocusState.Binding var distanceFieldIsFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Run data")
                    .font(.headline)
                Spacer()
                Text("Required")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(AppTheme.accent)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(AppTheme.accentSoft)
                    .clipShape(Capsule())
            }

            RunDistanceField(
                text: $distanceText,
                isValid: distanceIsValid,
                isFocused: $distanceFieldIsFocused
            )
            IntegerField(title: "Moving time", value: $movingMinutes, range: 0...1_440, suffix: "min")
            IntegerField(title: "Elevation gain", value: $elevationGainM, range: 0...10_000, suffix: "m")
            IntegerField(title: "Average heart rate", value: $averageHr, range: 0...250, suffix: "bpm")
            Text("Leave average heart rate at 0 if you did not measure it.")
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
        }
        .card(padding: 12)
    }
}

private struct RunDistanceField: View {
    @Binding var text: String
    var isValid: Bool
    @FocusState.Binding var isFocused: Bool

    var body: some View {
        HStack(spacing: 10) {
            Text("Distance")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AppTheme.text)
                .lineLimit(2)
            Spacer()
            HStack(spacing: 6) {
                TextField("", text: $text)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .font(.system(.body, design: .rounded, weight: .semibold))
                    .foregroundStyle(AppTheme.text)
                    .frame(width: 70)
                    .accessibilityLabel("Distance in kilometres")
                    .accessibilityIdentifier("run-distance-field")
                    .focused($isFocused)
                    .onChange(of: text) { _, newValue in
                        text = String(newValue.filter { $0.isNumber || $0 == "." || $0 == "," }.prefix(6))
                    }
                Text("km")
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(AppTheme.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                    .stroke(strokeColor, lineWidth: 1)
            )
        }
    }

    private var strokeColor: Color {
        if !isValid {
            return AppTheme.warning.opacity(0.7)
        }
        return isFocused ? AppTheme.accent.opacity(0.7) : AppTheme.divider
    }
}
