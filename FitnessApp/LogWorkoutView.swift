import SwiftData
import SwiftUI

private enum LogMetricField: Hashable {
    case pullUps
    case pushUps
    case plankSeconds
}

private enum RunLogMetricField: Hashable {
    case duration
    case distance
    case elevation
    case averageHeartRate
    case maxHeartRate
    case averagePace
    case carbs
    case fluid
    case sodium
}

struct LogWorkoutView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Query private var ranks: [RankState]
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \SetPrescription.orderIndex) private var prescriptions: [SetPrescription]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var previousLogs: [PerformanceLog]
    @Query(sort: \RunningLog.completedAt, order: .reverse) private var runningLogs: [RunningLog]
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
    @State private var fatigueLevel = 5
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
                    fatigueLevel: $fatigueLevel
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
        let log = PerformanceLog(
            sessionId: session.id,
            pullUps: savedPullUps,
            pushUps: savedPushUps,
            plankSeconds: savedPlankSeconds,
            loggedPullUps: loggedPullUps,
            loggedPushUps: loggedPushUps,
            loggedPlankSeconds: loggedPlankSeconds,
            rpe: rpe,
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
            runningLogs: runningLogs,
            runningSessions: coachPlannedSessions(from: sessions, domain: .ultraRunning),
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

struct LogRunView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext

    var session: WorkoutSession
    var workout: RunningWorkout

    @FocusState private var focusedField: RunLogMetricField?
    @State private var durationMinutes: Int
    @State private var distanceKm: Double
    @State private var elevationGainMeters: Int
    @State private var averageHeartRate: Int
    @State private var maxHeartRate: Int
    @State private var averagePaceSecondsPerKm: Int
    @State private var rpe = 5
    @State private var painLevel = 0
    @State private var fatigueLevel = 5
    @State private var carbsPerHour = 0
    @State private var fluidMlPerHour = 0
    @State private var sodiumMgPerHour = 0
    @State private var hadGIIssues = false
    @State private var notes = ""

    init(session: WorkoutSession, workout: RunningWorkout) {
        self.session = session
        self.workout = workout
        _durationMinutes = State(initialValue: max(1, workout.targetDurationMinutes))
        _distanceKm = State(initialValue: max(0.1, workout.targetDistanceKm))
        _elevationGainMeters = State(initialValue: max(0, workout.targetElevationMeters))
        _averageHeartRate = State(initialValue: max(0, workout.targetHeartRateHigh - 5))
        _maxHeartRate = State(initialValue: max(0, workout.targetHeartRateHigh))
        _averagePaceSecondsPerKm = State(initialValue: max(1, workout.targetPaceSecondsPerKm))
    }

    var body: some View {
        NavigationStack {
            ScreenBackground {
                RunLoggedWorkCard(
                    durationMinutes: $durationMinutes,
                    distanceKm: $distanceKm,
                    elevationGainMeters: $elevationGainMeters,
                    averageHeartRate: $averageHeartRate,
                    maxHeartRate: $maxHeartRate,
                    averagePaceSecondsPerKm: $averagePaceSecondsPerKm,
                    focusedField: $focusedField
                )

                RunFuelingCard(
                    carbsPerHour: $carbsPerHour,
                    fluidMlPerHour: $fluidMlPerHour,
                    sodiumMgPerHour: $sodiumMgPerHour,
                    hadGIIssues: $hadGIIssues,
                    focusedField: $focusedField
                )

                ReadinessInputCard(
                    rpe: $rpe,
                    painLevel: $painLevel,
                    fatigueLevel: $fatigueLevel
                )

                NotesCard(notes: $notes)

                Button("Save run", action: save)
                    .buttonStyle(PrimaryActionButtonStyle())
                    .disabled(!logIsValid)
                    .opacity(logIsValid ? 1 : 0.45)
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
                        focusedField = nil
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private var logIsValid: Bool {
        durationMinutes > 0 &&
            distanceKm > 0 &&
            averagePaceSecondsPerKm > 0 &&
            averageHeartRate >= 0 &&
            maxHeartRate >= averageHeartRate
    }

    private func save() {
        focusedField = nil
        guard logIsValid else { return }

        let log = RunningLog(
            sessionId: session.id,
            durationMinutes: durationMinutes,
            distanceKm: distanceKm,
            elevationGainMeters: elevationGainMeters,
            averageHeartRate: averageHeartRate,
            maxHeartRate: maxHeartRate,
            averagePaceSecondsPerKm: averagePaceSecondsPerKm,
            rpe: rpe,
            painLevel: painLevel,
            fatigueLevel: fatigueLevel,
            carbsPerHour: carbsPerHour,
            fluidMlPerHour: fluidMlPerHour,
            sodiumMgPerHour: sodiumMgPerHour,
            hadGIIssues: hadGIIssues,
            notes: notes
        )
        modelContext.insert(log)
        session.status = painLevel >= 4 || fatigueLevel >= 9 ? .deload : .completed

        if painLevel >= 4 || fatigueLevel >= 9 || hadGIIssues {
            let reason = ultraDeloadReason
            let coachPlan = CoachPlan(weekStart: Date(), summary: reason, domain: .ultraRunning, source: .rules, validationStatus: .clamped)
            modelContext.insert(coachPlan)
            modelContext.insert(CoachDecision(planId: coachPlan.id, rationale: reason, safetyFlags: ultraSafetyFlags))
        }

        do {
            try modelContext.save()
        } catch {
            return
        }
        dismiss()
    }

    private var ultraDeloadReason: String {
        if painLevel >= 4 {
            return "Ultra run logged pain above the safety line. Next ultra generation should reduce load."
        }
        if fatigueLevel >= 9 {
            return "Ultra run logged high fatigue. Next ultra generation should reduce load."
        }
        return "Ultra run logged fueling or GI trouble. Keep long-run fueling conservative until it is stable."
    }

    private var ultraSafetyFlags: [String] {
        var flags: [String] = []
        if painLevel >= 4 { flags.append("run-pain") }
        if fatigueLevel >= 9 { flags.append("run-fatigue") }
        if hadGIIssues { flags.append("gi-issues") }
        return flags
    }
}

private struct RunLoggedWorkCard: View {
    @Binding var durationMinutes: Int
    @Binding var distanceKm: Double
    @Binding var elevationGainMeters: Int
    @Binding var averageHeartRate: Int
    @Binding var maxHeartRate: Int
    @Binding var averagePaceSecondsPerKm: Int
    @FocusState.Binding var focusedField: RunLogMetricField?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Run result")
                .font(.headline)
            RunIntegerField(title: "Duration", value: $durationMinutes, range: 1...1_500, suffix: "min", focusedField: $focusedField, focusID: .duration)
            RunDistanceField(distanceKm: $distanceKm, focusedField: $focusedField)
            RunIntegerField(title: "Elevation", value: $elevationGainMeters, range: 0...12_000, suffix: "m", focusedField: $focusedField, focusID: .elevation)
            RunIntegerField(title: "Average HR", value: $averageHeartRate, range: 0...230, suffix: "bpm", focusedField: $focusedField, focusID: .averageHeartRate)
            RunIntegerField(title: "Max HR", value: $maxHeartRate, range: 0...240, suffix: "bpm", focusedField: $focusedField, focusID: .maxHeartRate)
            PaceField(title: "Average pace", secondsPerKm: $averagePaceSecondsPerKm, range: 180...1_500)
        }
        .card(padding: 12)
    }
}

private struct RunFuelingCard: View {
    @Binding var carbsPerHour: Int
    @Binding var fluidMlPerHour: Int
    @Binding var sodiumMgPerHour: Int
    @Binding var hadGIIssues: Bool
    @FocusState.Binding var focusedField: RunLogMetricField?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Fueling")
                .font(.headline)
            RunIntegerField(title: "Carbs/hour", value: $carbsPerHour, range: 0...120, suffix: "g", focusedField: $focusedField, focusID: .carbs)
            RunIntegerField(title: "Fluid/hour", value: $fluidMlPerHour, range: 0...1_500, suffix: "ml", focusedField: $focusedField, focusID: .fluid)
            RunIntegerField(title: "Sodium/hour", value: $sodiumMgPerHour, range: 0...2_000, suffix: "mg", focusedField: $focusedField, focusID: .sodium)
            Toggle("GI issues", isOn: $hadGIIssues)
                .tint(AppTheme.warning)
        }
        .card(padding: 12)
    }
}

private struct RunIntegerField: View {
    var title: String
    @Binding var value: Int
    var range: ClosedRange<Int>
    var suffix: String
    @FocusState.Binding var focusedField: RunLogMetricField?
    var focusID: RunLogMetricField

    private var clampedValue: Binding<Int> {
        Binding(
            get: { value },
            set: { value = min(range.upperBound, max(range.lowerBound, $0)) }
        )
    }

    var body: some View {
        HStack(spacing: 10) {
            Text(title)
                .font(.subheadline.weight(.medium))
            Spacer()
            TextField("", value: clampedValue, format: .number)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .font(.system(.body, design: .rounded, weight: .semibold))
                .frame(width: 76)
                .focused($focusedField, equals: focusID)
            Text(suffix)
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(AppTheme.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                .stroke(focusedField == focusID ? AppTheme.accent.opacity(0.7) : AppTheme.divider, lineWidth: 1)
        )
    }
}

private struct RunDistanceField: View {
    @Binding var distanceKm: Double
    @FocusState.Binding var focusedField: RunLogMetricField?

    var body: some View {
        HStack(spacing: 10) {
            Text("Distance")
                .font(.subheadline.weight(.medium))
            Spacer()
            TextField("", value: $distanceKm, format: .number.precision(.fractionLength(1)))
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.trailing)
                .font(.system(.body, design: .rounded, weight: .semibold))
                .frame(width: 76)
                .focused($focusedField, equals: .distance)
                .onChange(of: distanceKm) { _, newValue in
                    distanceKm = min(300, max(0, newValue))
                }
            Text("km")
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(AppTheme.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                .stroke(focusedField == .distance ? AppTheme.accent.opacity(0.7) : AppTheme.divider, lineWidth: 1)
        )
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
    @Binding var fatigueLevel: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Readiness")
                .font(.headline)
            ReadinessSlider(
                title: "RPE",
                systemImage: "speedometer",
                value: $rpe,
                range: 1...10,
                descriptor: ReadinessScale.rpe
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
                title: "Fatigue",
                systemImage: "battery.50percent",
                value: $fatigueLevel,
                range: 0...10,
                descriptor: ReadinessScale.fatigue
            )
        }
        .card(padding: 10)
    }
}

private struct ReadinessSlider: View {
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

private struct ReadinessDescriptor {
    var label: String
    var detail: String
    var color: Color
}

private enum ReadinessScale {
    static func rpe(_ value: Int) -> ReadinessDescriptor {
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

    static func fatigue(_ value: Int) -> ReadinessDescriptor {
        switch value {
        case 0:
            ReadinessDescriptor(label: "Fresh", detail: "No meaningful fatigue.", color: AppTheme.accent)
        case 1:
            ReadinessDescriptor(label: "Very light", detail: "Very light fatigue. You feel fresh.", color: AppTheme.accent)
        case 2:
            ReadinessDescriptor(label: "Low", detail: "Low tiredness. Easy to get moving.", color: AppTheme.accent)
        case 3:
            ReadinessDescriptor(label: "Moderate", detail: "Moderate fatigue, but continuing feels fine.", color: AppTheme.accent)
        case 4:
            ReadinessDescriptor(label: "Noticeable", detail: "Energy is down, but control is still good.", color: AppTheme.gold)
        case 5:
            ReadinessDescriptor(label: "Tired", detail: "Hard and tiring, but continuing is manageable.", color: AppTheme.gold)
        case 6:
            ReadinessDescriptor(label: "Heavy", detail: "Strong fatigue is building.", color: AppTheme.gold)
        case 7:
            ReadinessDescriptor(label: "Drained", detail: "Very strenuous. You have to push yourself.", color: AppTheme.gold)
        case 8:
            ReadinessDescriptor(label: "Very drained", detail: "Very tired. Quality may start to drop.", color: AppTheme.warning)
        case 9:
            ReadinessDescriptor(label: "Overreached", detail: "High fatigue. Lockin will deload after saving.", color: AppTheme.warning)
        default:
            ReadinessDescriptor(label: "Spent", detail: "Maximum fatigue. Recovery should win.", color: AppTheme.warning)
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
