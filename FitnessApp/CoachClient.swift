import Foundation

struct CoachPlanRequest: Codable, Equatable {
    var model: String
    var baseline: CoachBaseline
    var goals: CoachGoals
    var profileNotes: String
    var weekStart: Date
    var weeklySessions: Int
    var trainingDays: [String]
    var trainingDayOffsets: [Int]
    var equipment: [String]
    var targetDate: Date
    var trainingLogs: [CoachLog]
    var plannedSessions: [CoachPlannedSession]
    var running: CoachRunningRequest? = nil
}

struct CoachRunningGoal: Codable, Equatable {
    var name: String
    var raceDate: Date
    var distanceKm: Double
    var elevationGainM: Int
}

struct CoachRunSummary: Codable, Equatable {
    var completedAt: Date
    var distanceKm: Double
    var movingSeconds: Int
    var elevationGainM: Int
    var averageHr: Int?
    var rpe: Int?
    var feelScore: Int? = nil   // 1 very weak ... 5 very strong; nil when never set
    var kind: String?
}

struct CoachRunningRequest: Codable, Equatable {
    var raceGoal: CoachRunningGoal
    var baselineWeeklyKm: Double
    var longestRecentRunKm: Double
    var runningDays: [String]
    var runningDayOffsets: [Int]
    var longRunDay: String?
    var longRunDayOffset: Int?
    var recentRuns: [CoachRunSummary]
}

enum CoachModelCatalog {
    static let defaultModelID = "gpt-5-mini"
    static let defaultModelIDs = [
        defaultModelID,
        "gpt-5",
        "gpt-4.1"
    ]

    static func normalized(_ modelID: String) -> String {
        let trimmed = modelID.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? defaultModelID : trimmed
    }

    static func mergedOptions(selectedModelID: String, fetchedModelIDs: [String]) -> [String] {
        var seen: Set<String> = []
        return ([normalized(selectedModelID)] + fetchedModelIDs + defaultModelIDs)
            .map(normalized)
            .filter { seen.insert($0).inserted }
    }
}

struct CoachModelsResponse: Codable, Equatable {
    var defaultModel: String
    var models: [String]
}

enum CoachSkillDisplay {
    static let relationship = """
    The AI week shown in Today and Log comes from the hosted proxy's validated fitness-coach-planner skill output.
    """

    static let bundleContents = """
    Source of truth:
    Proxy/src/coach/skills/fitness-coach-planner/SKILL.md

    Sent with the model call:
    - SKILL.md planning workflow and non-negotiable rules
    - references/progression-policy.md
    - references/real-world-standards.md
    - references/exercise-library.json
    - references/weekly-plan.schema.json

    Built before the model call:
    - last 5 logs with perceived effort, pain, and how-you-felt self-evaluation
    - current partial month
    - last full month
    - previous full month
    - two-month trend
    - readiness and risk flags

    Technical output check after the model call:
    scripts/validate-week-plan.ts
    """
}

struct CoachBaseline: Codable, Equatable {
    var pullUps: Int
    var pushUps: Int
    var plankSeconds: Int
}

struct CoachGoals: Codable, Equatable {
    var pullUps: Int
    var pushUps: Int
    var plankSeconds: Int
}

struct CoachLog: Codable, Equatable {
    var id: String
    var sessionId: String
    var completedAt: Date
    var pullUps: Int
    var pushUps: Int
    var plankSeconds: Int
    var loggedPullUps: Bool
    var loggedPushUps: Bool
    var loggedPlankSeconds: Bool
    var rpe: Int
    var painLevel: Int
    var fatigueLevel: Int
    var notes: String
    var plannedRPE: Int? = nil
    var actualRPE: Int? = nil
    var rpeDelta: Int? = nil
    var rpeSummary: String? = nil
    var plannedEffortLabel: String? = nil
    var plannedEffortReason: String? = nil
}

struct CoachPlannedSession: Codable, Equatable {
    var id: String
    var scheduledDate: Date
    var title: String
    var focus: String
    var status: String
    var exercises: [CoachPlannedExercisePrescription] = []
}

struct CoachPlannedExercisePrescription: Codable, Equatable {
    var exercise: String
    var sets: Int
    var targetReps: Int
    var targetSeconds: Int
    var plannedEffortLabel: String?
    var plannedEffortStimulus: String?
}

struct CoachPlanResponse: Codable, Equatable {
    var summary: String
    var contextState: String
    var safetyFlags: [String]
    var sessions: [CoachSessionResponse]
}

struct RunTargetResponse: Codable, Equatable {
    var type: String   // "pace" | "hr"
    var low: Int
    var high: Int
}

struct RunSessionResponse: Codable, Equatable {
    var title: String
    var dayOffset: Int
    var kind: String
    var purpose: String
    var distanceKm: Double
    var durationMinutes: Int
    var elevationMeters: Int
    var target: RunTargetResponse
    var zone: String
    var notes: [String]
}

struct RunningWeekResponse: Codable, Equatable {
    var summary: String
    var safetyFlags: [String]
    var sessions: [RunSessionResponse]
}

struct CombinedWeekResponse: Codable, Equatable {
    var summary: String
    var safetyFlags: [String]
    var runningWeek: RunningWeekResponse
    var strengthWeek: CoachPlanResponse
}

struct CoachVerdictResponse: Codable, Equatable {
    var headline: String
    var summary: String
    var latestChange: String
    var recommendation: String
    var shouldUpdatePlan: Bool
    var contextState: String
    var safetyFlags: [String]
}

struct CoachProxyHealthResponse: Codable, Equatable {
    var ok: Bool
    var hasApiKey: Bool
    var defaultModel: String
}

struct GarminStatusResponse: Codable, Equatable {
    var ok: Bool
    var loggedIn: Bool
    var lastError: String?
}

extension GarminStatusResponse {
    /// Shared status vocabulary for every Garmin row (Settings card, Coach
    /// sync row). Fetch failure (no response at all) is a view-level
    /// "Unreachable" — this only maps a response we actually received.
    var displayState: (text: String, isHealthy: Bool) {
        if loggedIn {
            return ok ? ("Connected", true) : ("Degraded", false)
        }
        return ("Not logged in", false)
    }
}

struct GarminWellnessDayResponse: Codable, Equatable {
    var date: String   // "2026-06-08" or full ISO; parsed during ingest
    var sleepScore: Int
    var sleepSeconds: Int
    var hrvStatus: String
    var hrvMs: Int
    var bodyBattery: Int
    var trainingReadiness: Int
    var restingHr: Int
}

struct GarminActivityResponse: Codable, Equatable {
    var garminActivityId: String
    var startTime: String   // Garmin local time "2026-06-08 07:01:33" or ISO
    var activityType: String
    var distanceKm: Double
    var movingSeconds: Int
    var elevationGainM: Int
    var averageHr: Int
    var averagePaceSecPerKm: Int
    var name: String
}

struct GarminSnapshotResponse: Codable, Equatable {
    var status: GarminStatusResponse
    var wellness: [GarminWellnessDayResponse]
    var activities: [GarminActivityResponse]
}

struct GarminPushTarget: Codable, Equatable {
    var type: String   // "pace" | "hr" | "" (sidecar maps unknown/empty to no target)
    var low: Int
    var high: Int
}

struct GarminPushWorkout: Codable, Equatable {
    var sessionId: String
    var title: String
    var date: String   // "yyyy-MM-dd"; the sidecar schedules by calendar date
    var kind: String
    var distanceKm: Double
    var durationMinutes: Int
    var target: GarminPushTarget
    var notes: String
}

struct GarminPushRequest: Codable, Equatable {
    var workouts: [GarminPushWorkout]
}

struct GarminPushResultItem: Codable, Equatable {
    var sessionId: String
    var garminWorkoutId: String?
    var scheduled: Bool
    var error: String?
}

struct GarminPushResponse: Codable, Equatable {
    var results: [GarminPushResultItem]
    var error: String? = nil
}

struct GarminDeleteRequest: Codable, Equatable {
    var workoutIds: [String]
}

struct GarminDeleteResultItem: Codable, Equatable {
    var workoutId: String
    var deleted: Bool
    var error: String?
}

struct GarminDeleteResponse: Codable, Equatable {
    var results: [GarminDeleteResultItem]
    var error: String? = nil
}

/// Maps planned running sessions onto the sidecar's push contract. Strength
/// and non-planned sessions never reach the watch. An unset target stays
/// empty: build_workout maps a non pace/hr type to "no target" on the step.
func garminPushWorkouts(from sessions: [WorkoutSession], calendar: Calendar = .current) -> [GarminPushWorkout] {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = calendar
    formatter.timeZone = calendar.timeZone
    formatter.dateFormat = "yyyy-MM-dd"

    return sessions
        .filter { $0.discipline == .running && $0.status == .planned }
        .map { session in
            GarminPushWorkout(
                sessionId: session.id.uuidString,
                title: session.title,
                date: formatter.string(from: session.scheduledDate),
                kind: session.runKindRaw,
                distanceKm: session.plannedDistanceKm,
                durationMinutes: session.estimatedDurationMinutes,
                target: GarminPushTarget(
                    type: session.runTargetTypeRaw,
                    low: session.runTargetLow,
                    high: session.runTargetHigh
                ),
                notes: session.runZone
            )
        }
}

/// Stamps `garminWorkoutId` and `pushedToGarminAt` onto the sessions named by
/// the scheduled push results. Failed items and session ids that match no
/// session are ignored. Returns how many sessions were stamped.
@discardableResult
func applyGarminPushResults(_ results: [GarminPushResultItem], to sessions: [WorkoutSession], at date: Date = Date()) -> Int {
    var applied = 0
    for result in results where result.scheduled {
        guard let session = sessions.first(where: { $0.id.uuidString == result.sessionId }) else { continue }
        session.garminWorkoutId = result.garminWorkoutId ?? ""
        session.pushedToGarminAt = date
        applied += 1
    }
    return applied
}

struct CoachSessionResponse: Codable, Equatable {
    var title: String
    var dayOffset: Int
    var focus: String
    var plannedEffort: CoachPlannedEffortResponse? = nil
    var purpose: String
    var estimatedDurationMinutes: Int
    var progressionRationale: String
    var safetyNotes: [String]
    var loggingFieldsRequired: [String]
    var exercises: [CoachExerciseResponse]
}

struct CoachExerciseResponse: Codable, Equatable {
    var exercise: String
    var sets: Int
    var reps: Int
    var seconds: Int
    var restSeconds: Int
    var intensity: String
    var plannedEffort: CoachPlannedEffortResponse? = nil
}

struct CoachPlannedEffortResponse: Codable, Equatable {
    var label: String
    var targetRPE: Int
    var targetRIR: Int
    var stimulus: String
    var reason: String

    var plannedEffort: PlannedEffort? {
        guard
            let label = PlannedEffortLabel(rawValue: label),
            let stimulus = EffortStimulus(rawValue: stimulus)
        else { return nil }

        return PlannedEffort(
            label: label,
            targetRPE: targetRPE,
            targetRIR: targetRIR,
            stimulus: stimulus,
            reason: reason
        )
    }
}

func legacyPlannedEffort(from intensity: String, reason: String) -> PlannedEffort {
    let label = PlannedEffortLabel.fromLegacyIntensity(intensity) ?? .medium
    switch label {
    case .light:
        return PlannedEffort(label: .light, targetRPE: 3, targetRIR: 6, stimulus: .technique, reason: reason)
    case .medium:
        return PlannedEffort(label: .medium, targetRPE: 6, targetRIR: 4, stimulus: .volume, reason: reason)
    case .hard:
        return PlannedEffort(label: .hard, targetRPE: 7, targetRIR: 3, stimulus: .strength, reason: reason)
    case .veryHard:
        return PlannedEffort(label: .veryHard, targetRPE: 9, targetRIR: 1, stimulus: .strength, reason: reason)
    case .maxOutput:
        return PlannedEffort(label: .maxOutput, targetRPE: 10, targetRIR: 0, stimulus: .test, reason: reason)
    }
}

func inferredSessionEffort(from session: CoachSessionResponse) -> PlannedEffort {
    if let effort = session.plannedEffort?.plannedEffort {
        return effort
    }

    let labels = session.exercises.map {
        ($0.plannedEffort?.plannedEffort ?? legacyPlannedEffort(
            from: $0.intensity,
            reason: "Derived from legacy exercise intensity while the coach server is updated."
        )).label
    }
    let label = labels.max(by: { effortRank($0) < effortRank($1) }) ?? .medium
    return legacyPlannedEffort(
        from: label.title,
        reason: "Derived from exercise intensities because the coach server did not send planned effort yet."
    )
}

private func effortRank(_ label: PlannedEffortLabel) -> Int {
    switch label {
    case .light: 0
    case .medium: 1
    case .hard: 2
    case .veryHard: 3
    case .maxOutput: 4
    }
}

enum CoachClientError: Error, LocalizedError {
    case invalidURL
    case proxyUnavailable(URL, URLError)
    case transportFailed(URL, URLError)
    case invalidResponse
    case invalidStatus(Int, String?)
    case validationFailed([String])

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            "The hosted coach proxy URL is invalid. Use https://lockin.elevenfactor.com/generate-week-plan."
        case .proxyUnavailable(let endpoint, _):
            """
            The hosted coach proxy is not reachable at \(endpoint.absoluteString).

            Check that the Coolify deployment is healthy, DNS has propagated, and the app domain is set to https://lockin.elevenfactor.com.
            """
        case .transportFailed(let endpoint, let error):
            "The app could not reach the hosted coach proxy at \(endpoint.absoluteString): \(error.localizedDescription)"
        case .invalidResponse:
            "The hosted coach proxy returned a response the app could not read."
        case .invalidStatus(let status, let message):
            if let message, message.contains("OPENAI_API_KEY") {
                """
                The hosted coach proxy is running, but OPENAI_API_KEY is not set.

                Set OPENAI_API_KEY in the Coolify environment variables, then redeploy.
                """
            } else if let message, !message.isEmpty {
                "The hosted coach proxy returned HTTP \(status): \(message)"
            } else {
                "The hosted coach proxy returned HTTP \(status)."
            }
        case .validationFailed(let messages): messages.joined(separator: "\n")
        }
    }
}

private extension URLError {
    var isLocalProxyConnectionFailure: Bool {
        switch code {
        case .cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .notConnectedToInternet, .timedOut:
            true
        default:
            false
        }
    }
}

struct CoachPlanValidator {
    private let validContextStates: Set<String> = ["building", "plateau", "overreaching", "recovery_needed", "insufficient_history"]
    private let validLoggingFields: Set<String> = ["pullUps", "pushUps", "plankSeconds"]
    private let normalProgressionStates: Set<String> = ["building", "plateau", "insufficient_history"]

    private struct GoalWorkSummary {
        var target: Int = 0
        var volume: Int = 0
    }

    private struct GoalTrend {
        var latestTarget: Int?
        var latestVolume: Int?
        var flatCount: Int
    }

    func validate(
        response: CoachPlanResponse,
        baseline: Baseline,
        preferences: TrainingPreferences,
        weekStart: Date,
        plannedSessions: [CoachPlannedSession] = [],
        trainingLogs: [CoachLog] = []
    ) -> PlanValidationResult {
        var messages: [String] = []
        let hasExplicitTrainingDays = !preferences.trainingDays.isEmpty
        let selectedDays = TrainingWeekday.normalized(preferences.trainingDays, weeklySessions: preferences.weeklySessions)
        let explicitDayOffsets = TrainingWeekday.dayOffsets(
            for: Set(selectedDays),
            weeklySessions: selectedDays.count,
            weekStart: weekStart
        ).filter { (1...6).contains($0) }
        let expectedSessionCount = hasExplicitTrainingDays ? explicitDayOffsets.count : preferences.weeklySessions
        let allowedDayOffsets = hasExplicitTrainingDays ? Set(explicitDayOffsets) : []

        if !validContextStates.contains(response.contextState) {
            messages.append("AI plan has an unknown context state.")
        }

        if response.sessions.count != expectedSessionCount {
            messages.append("AI plan must contain exactly \(expectedSessionCount) sessions.")
        }

        var previousDayOffset = -1
        var sessionEffortLabels: [PlannedEffortLabel] = []
        var usefulGoalWork: [String: GoalWorkSummary] = [:]

        for (index, session) in response.sessions.enumerated() {
            if !(1...6).contains(session.dayOffset) {
                messages.append("AI session \(index + 1) must have a day offset from 1 through 6; day offset 0 is today and cannot be planned during a refresh.")
            }

            if hasExplicitTrainingDays, (1...6).contains(session.dayOffset), !allowedDayOffsets.contains(session.dayOffset) {
                messages.append("AI session \(index + 1) is scheduled on a rest day.")
            }

            if session.dayOffset <= previousDayOffset {
                messages.append("AI sessions must use strictly increasing day offsets.")
            }
            previousDayOffset = session.dayOffset

            guard SessionFocus(rawValue: session.focus) != nil else {
                messages.append("AI session \(index + 1) has an unknown focus.")
                continue
            }

            if let effort = validateEffort(
                session.plannedEffort,
                fallback: inferredSessionEffort(from: session),
                owner: "AI session \(index + 1)",
                contextState: response.contextState,
                messages: &messages
            ) {
                sessionEffortLabels.append(effort.label)
            }

            if session.estimatedDurationMinutes < 0 {
                messages.append("AI session \(index + 1) has a negative duration.")
            }

            for field in session.loggingFieldsRequired where !validLoggingFields.contains(field) {
                messages.append("AI session \(index + 1) has an unknown logging field.")
            }

            for exercise in session.exercises {
                guard ExerciseKind(rawValue: exercise.exercise) != nil else {
                    messages.append("AI session \(index + 1) has an unknown exercise.")
                    continue
                }

                if exercise.sets < 1 {
                    messages.append("AI session \(index + 1) has a non-positive set count.")
                }

                if exercise.reps < 0 || exercise.seconds < 0 || exercise.restSeconds < 0 {
                    messages.append("AI session \(index + 1) has a negative reps, hold, or rest value.")
                }

                if let effort = validateEffort(
                    exercise.plannedEffort,
                    fallback: legacyPlannedEffort(
                        from: exercise.intensity,
                        reason: "Derived from legacy exercise intensity while the coach server is updated."
                    ),
                    owner: "AI session \(index + 1) \(exercise.exercise)",
                    contextState: response.contextState,
                    messages: &messages
                ) {
                    collectUsefulGoalWork(exercise: exercise, effort: effort, usefulGoalWork: &usefulGoalWork)
                }
            }
        }

        if normalProgressionStates.contains(response.contextState), response.safetyFlags.isEmpty {
            if !sessionEffortLabels.isEmpty, sessionEffortLabels.allSatisfy({ $0 == .light }) {
                messages.append("AI plan cannot be all light unless safety flags explain why.")
            }
            validateUsefulGoalFloor(baseline: baseline, usefulGoalWork: usefulGoalWork, messages: &messages)
            validateFlatPrescriptionProgression(
                plannedSessions: plannedSessions,
                trainingLogs: trainingLogs,
                usefulGoalWork: usefulGoalWork,
                weekStart: weekStart,
                messages: &messages
            )
        }

        return PlanValidationResult(status: messages.isEmpty ? .accepted : .rejected, messages: messages)
    }

    private func validateEffort(
        _ response: CoachPlannedEffortResponse?,
        fallback: PlannedEffort,
        owner: String,
        contextState: String,
        messages: inout [String]
    ) -> PlannedEffort? {
        guard let response else { return fallback }
        guard let effort = response.plannedEffort else {
            messages.append("\(owner) has an unknown planned effort label or stimulus.")
            return nil
        }

        guard (1...10).contains(effort.targetRPE) else {
            messages.append("\(owner) planned effort target RPE must be 1 through 10.")
            return effort
        }

        guard (0...10).contains(effort.targetRIR) else {
            messages.append("\(owner) planned effort target reserve must be 0 through 10.")
            return effort
        }

        let allowedRPERange: ClosedRange<Int> = switch effort.label {
        case .light: 1...4
        case .medium: 5...6
        case .hard: 7...8
        case .veryHard: 9...9
        case .maxOutput: 10...10
        }
        if !allowedRPERange.contains(effort.targetRPE) {
            messages.append("\(owner) target RPE does not match \(effort.label.title.lowercased()) effort.")
        }

        if effort.label == .maxOutput, effort.stimulus != .test {
            messages.append("\(owner) max output effort is only allowed for tests.")
        }

        if contextState == "recovery_needed", [.hard, .veryHard, .maxOutput].contains(effort.label) {
            messages.append("\(owner) cannot be \(effort.label.title.lowercased()) during recovery.")
        }

        return effort
    }

    private func collectUsefulGoalWork(exercise: CoachExerciseResponse, effort: PlannedEffort, usefulGoalWork: inout [String: GoalWorkSummary]) {
        guard effort.label != .light, effort.stimulus != .recovery, effort.stimulus != .technique else { return }
        switch exercise.exercise {
        case ExerciseKind.pullUp.rawValue:
            recordGoalWork(metric: "pullUps", target: exercise.reps, sets: exercise.sets, usefulGoalWork: &usefulGoalWork)
        case ExerciseKind.pushUp.rawValue:
            recordGoalWork(metric: "pushUps", target: exercise.reps, sets: exercise.sets, usefulGoalWork: &usefulGoalWork)
        case ExerciseKind.plank.rawValue:
            recordGoalWork(metric: "plankSeconds", target: exercise.seconds, sets: exercise.sets, usefulGoalWork: &usefulGoalWork)
        default:
            break
        }
    }

    private func recordGoalWork(metric: String, target: Int, sets: Int, usefulGoalWork: inout [String: GoalWorkSummary]) {
        var summary = usefulGoalWork[metric] ?? GoalWorkSummary()
        summary.target = max(summary.target, target)
        summary.volume = max(summary.volume, target * max(sets, 0))
        usefulGoalWork[metric] = summary
    }

    private func validateUsefulGoalFloor(baseline: Baseline, usefulGoalWork: [String: GoalWorkSummary], messages: inout [String]) {
        let checks: [(metric: String, best: Int, label: String)] = [
            ("pullUps", baseline.pullUps, "pull-up"),
            ("pushUps", baseline.pushUps, "push-up"),
            ("plankSeconds", baseline.plankSeconds, "plank")
        ]

        for check in checks {
            guard check.best >= 10, let prescribed = usefulGoalWork[check.metric]?.target else { continue }
            let minimum = Int(ceil(Double(check.best) * 0.45))
            if prescribed < minimum {
                messages.append("AI \(check.label) goal work is below the useful stimulus floor.")
            }
        }
    }

    private func validateFlatPrescriptionProgression(
        plannedSessions: [CoachPlannedSession],
        trainingLogs: [CoachLog],
        usefulGoalWork: [String: GoalWorkSummary],
        weekStart: Date,
        messages: inout [String]
    ) {
        guard hasCleanProgressionSignal(trainingLogs: trainingLogs) else { return }

        let trends = recentGoalTrends(plannedSessions: plannedSessions, before: weekStart)
        let checks = [
            (metric: "pullUps", label: "pull-up"),
            (metric: "pushUps", label: "push-up"),
            (metric: "plankSeconds", label: "plank")
        ]

        for check in checks {
            guard
                let trend = trends[check.metric],
                trend.flatCount >= 2,
                let latestTarget = trend.latestTarget,
                let latestVolume = trend.latestVolume
            else { continue }

            let prescribed = usefulGoalWork[check.metric]
            if prescribed == nil || (prescribed?.target ?? 0) <= latestTarget && (prescribed?.volume ?? 0) <= latestVolume {
                messages.append("AI \(check.label) work repeats the recent flat prescription. Increase reps, hold time, sets, or add safety flags with a clear reason.")
            }
        }
    }

    private func hasCleanProgressionSignal(trainingLogs: [CoachLog]) -> Bool {
        let recentLogs = trainingLogs
            .sorted { $0.completedAt > $1.completedAt }
            .prefix(5)
            .filter { $0.loggedPullUps || $0.loggedPushUps || $0.loggedPlankSeconds }

        guard recentLogs.count >= 2 else { return false }
        if recentLogs.contains(where: { $0.painLevel >= 4 || $0.fatigueLevel >= 9 }) { return false }
        if recentLogs.filter({ $0.rpe >= 9 }).count >= 2 { return false }
        if recentLogs.compactMap(\.rpeDelta).filter({ $0 >= 2 }).count >= 2 { return false }
        return true
    }

    private func recentGoalTrends(plannedSessions: [CoachPlannedSession], before weekStart: Date) -> [String: GoalTrend] {
        let entries = plannedSessions
            .filter { $0.scheduledDate < weekStart }
            .flatMap { session in
                session.exercises.compactMap { prescription -> (metric: String, target: Int, volume: Int, date: Date)? in
                    guard isUsefulGoalPrescription(prescription) else { return nil }
                    let target = prescription.exercise == ExerciseKind.plank.rawValue ? prescription.targetSeconds : prescription.targetReps
                    guard target > 0 else { return nil }
                    return (
                        metric: metricName(for: prescription.exercise),
                        target: target,
                        volume: target * prescription.sets,
                        date: session.scheduledDate
                    )
                }
            }
            .sorted { $0.date > $1.date }

        return [
            "pullUps": goalTrend(from: entries.filter { $0.metric == "pullUps" }),
            "pushUps": goalTrend(from: entries.filter { $0.metric == "pushUps" }),
            "plankSeconds": goalTrend(from: entries.filter { $0.metric == "plankSeconds" })
        ]
    }

    private func isUsefulGoalPrescription(_ prescription: CoachPlannedExercisePrescription) -> Bool {
        guard [
            ExerciseKind.pullUp.rawValue,
            ExerciseKind.pushUp.rawValue,
            ExerciseKind.plank.rawValue
        ].contains(prescription.exercise) else { return false }
        if prescription.plannedEffortLabel == PlannedEffortLabel.light.rawValue { return false }
        if prescription.plannedEffortStimulus == EffortStimulus.recovery.rawValue || prescription.plannedEffortStimulus == EffortStimulus.technique.rawValue {
            return false
        }
        return prescription.sets > 0
    }

    private func metricName(for exercise: String) -> String {
        switch exercise {
        case ExerciseKind.pullUp.rawValue:
            "pullUps"
        case ExerciseKind.pushUp.rawValue:
            "pushUps"
        default:
            "plankSeconds"
        }
    }

    private func goalTrend(from entries: [(metric: String, target: Int, volume: Int, date: Date)]) -> GoalTrend {
        guard let latest = entries.first else {
            return GoalTrend(latestTarget: nil, latestVolume: nil, flatCount: 0)
        }

        var flatCount = 0
        for entry in entries {
            if entry.target != latest.target || entry.volume != latest.volume { break }
            flatCount += 1
        }

        return GoalTrend(latestTarget: latest.target, latestVolume: latest.volume, flatCount: flatCount)
    }
}

struct RunningWeekValidator {
    func validate(response: RunningWeekResponse, allowedDayOffsets: [Int]) -> PlanValidationResult {
        var messages: [String] = []
        let allowed = Set(allowedDayOffsets)
        var previousDayOffset = -1

        for (index, session) in response.sessions.enumerated() {
            if !(1...6).contains(session.dayOffset) {
                messages.append("AI run \(index + 1) must have a day offset from 1 through 6; day offset 0 is today and cannot be planned during a refresh.")
            }

            if !allowed.isEmpty, (1...6).contains(session.dayOffset), !allowed.contains(session.dayOffset) {
                messages.append("AI run \(index + 1) is scheduled on a non-running day.")
            }

            if session.dayOffset <= previousDayOffset {
                messages.append("AI runs must use strictly increasing day offsets.")
            }
            previousDayOffset = session.dayOffset

            if RunKind(rawValue: session.kind) == nil {
                messages.append("AI run \(index + 1) has an unknown kind.")
            }

            if session.target.low > session.target.high {
                messages.append("AI run \(index + 1) has an inverted target range.")
            }

            if session.distanceKm < 0 || session.durationMinutes < 0 || session.elevationMeters < 0 {
                messages.append("AI run \(index + 1) has a negative distance, duration, or elevation.")
            }
        }

        return PlanValidationResult(status: messages.isEmpty ? .accepted : .rejected, messages: messages)
    }
}

extension CoachPlanResponse {
    func weeklyPlan(weekStart: Date, weekIndex: Int = 0) -> WeeklyPlan {
        let calendar = Calendar.current
        let start = calendar.startOfDay(for: weekStart)
        return WeeklyPlan(
            weekStart: start,
            weekIndex: weekIndex,
            sessions: sessions.map { session in
                let date = calendar.date(byAdding: .day, value: session.dayOffset, to: start) ?? start
                let safety = session.safetyNotes.isEmpty ? "No extra safety notes." : session.safetyNotes.joined(separator: " ")
                return TrainingSessionPlan(
                    date: date,
                    title: session.title,
                    focus: SessionFocus(rawValue: session.focus) ?? .mixed,
                    weekIndex: weekIndex,
                    summary: "AI: \(session.purpose)",
                    plannedEffort: inferredSessionEffort(from: session),
                    estimatedDurationMinutes: max(0, session.estimatedDurationMinutes),
                    blocks: [
                        WorkoutBlockPlan(
                            name: "AI Coach Plan",
                            detail: "\(session.progressionRationale) \(safety)",
                            sets: session.exercises.compactMap { exercise in
                                guard let kind = ExerciseKind(rawValue: exercise.exercise) else { return nil }
                                return ExerciseSetPlan(
                                    exercise: kind,
                                    sets: exercise.sets,
                                    reps: exercise.reps,
                                    seconds: exercise.seconds,
                                    restSeconds: exercise.restSeconds,
                                    intensity: exercise.intensity,
                                    plannedEffort: exercise.plannedEffort?.plannedEffort ?? legacyPlannedEffort(
                                        from: exercise.intensity,
                                        reason: "Derived from legacy exercise intensity while the coach server is updated."
                                    )
                                )
                            }
                        )
                    ]
                )
            },
            summary: summary,
            shouldTest: false
        )
    }
}

enum CoachVerdictRefreshFlag {
    static let needsRefreshKey = "coachVerdictNeedsRefresh"
}

func makeCoachRequest(
    profile: UserProfile,
    modelID: String,
    logs: [PerformanceLog],
    sessions: [WorkoutSession],
    prescriptions: [SetPrescription] = [],
    raceGoal: RaceGoal? = nil,
    runLogs: [RunLog] = [],
    weekStart: Date = rollingPlanStart()
) -> CoachPlanRequest {
    let baseline = Baseline(
        pullUps: profile.baselinePullUps,
        pushUps: profile.baselinePushUps,
        plankSeconds: profile.baselinePlankSeconds
    )
    let selectedDays = TrainingWeekday.normalized(profile.trainingDays, weeklySessions: profile.weeklySessions)
    let dayOffsets = TrainingWeekday.dayOffsets(
        for: Set(selectedDays),
        weeklySessions: selectedDays.count,
        weekStart: weekStart
    ).filter { (1...6).contains($0) }
    let prescriptionsBySession = Dictionary(grouping: prescriptions, by: \.sessionId)
    let running = raceGoal.map { goal in
        CoachRunningRequest(
            raceGoal: CoachRunningGoal(
                name: goal.name,
                raceDate: Calendar.current.startOfDay(for: goal.raceDate),
                distanceKm: goal.distanceKm,
                elevationGainM: goal.elevationGainM
            ),
            baselineWeeklyKm: goal.baselineWeeklyKm,
            longestRecentRunKm: goal.longestRecentRunKm,
            runningDays: TrainingWeekday.allCases.filter { profile.runningDays.contains($0) }.map(\.rawValue),
            // An empty selection must stay unconstrained; dayOffsets would otherwise
            // fall back to the default Monday plan and contradict runningDays: [].
            runningDayOffsets: profile.runningDays.isEmpty ? [] : TrainingWeekday.dayOffsets(
                for: profile.runningDays,
                weeklySessions: profile.runningDays.count,
                weekStart: weekStart
            ).filter { (1...6).contains($0) },
            // A long-run day outside the selected running days would make the proxy's
            // placement constraint unsatisfiable, so omit it entirely in that case.
            longRunDay: profile.longRunDay
                .flatMap { profile.runningDays.contains($0) ? $0.rawValue : nil },
            longRunDayOffset: profile.longRunDay
                .flatMap { profile.runningDays.contains($0) ? $0 : nil }
                .flatMap { TrainingWeekday.dayOffsets(for: [$0], weeklySessions: 1, weekStart: weekStart).first }
                .flatMap { (1...6).contains($0) ? $0 : nil },
            recentRuns: runLogs
                .filter { !$0.needsConfirmation }
                .sorted { $0.completedAt < $1.completedAt }
                .suffix(20)
                .map {
                    CoachRunSummary(
                        completedAt: $0.completedAt,
                        distanceKm: $0.distanceKm,
                        movingSeconds: $0.movingSeconds,
                        elevationGainM: $0.elevationGainM,
                        averageHr: $0.averageHr > 0 ? $0.averageHr : nil,
                        rpe: $0.rpe > 0 ? $0.rpe : nil,
                        feelScore: $0.feelScore > 0 ? $0.feelScore : nil,
                        kind: nil
                    )
                }
        )
    }

    return CoachPlanRequest(
        model: CoachModelCatalog.normalized(modelID),
        baseline: CoachBaseline(
            pullUps: baseline.pullUps,
            pushUps: baseline.pushUps,
            plankSeconds: baseline.plankSeconds
        ),
        goals: CoachGoals(
            pullUps: profile.goalPullUps,
            pushUps: profile.goalPushUps,
            plankSeconds: profile.goalPlankSeconds
        ),
        profileNotes: profile.painNotes,
        weekStart: weekStart,
        weeklySessions: selectedDays.count,
        trainingDays: selectedDays.map(\.rawValue),
        trainingDayOffsets: dayOffsets,
        equipment: profile.equipment.map(\.rawValue).sorted(),
        targetDate: profile.targetDate,
        trainingLogs: coachHistoryLogs(from: logs).map {
            CoachLog(
                id: $0.id.uuidString,
                sessionId: $0.sessionId.uuidString,
                completedAt: $0.completedAt,
                pullUps: $0.pullUps,
                pushUps: $0.pushUps,
                plankSeconds: $0.plankSeconds,
                loggedPullUps: $0.loggedPullUps,
                loggedPushUps: $0.loggedPushUps,
                loggedPlankSeconds: $0.loggedPlankSeconds,
                rpe: $0.rpe,
                painLevel: $0.painLevel,
                fatigueLevel: $0.fatigueLevel,
                notes: $0.notes,
                plannedRPE: $0.hasPlannedRPESnapshot ? $0.plannedRPE : nil,
                actualRPE: $0.rpe,
                rpeDelta: $0.rpeDelta,
                rpeSummary: $0.rpeSummaryText,
                plannedEffortLabel: $0.plannedEffortLabelAtLog?.rawValue,
                plannedEffortReason: $0.plannedEffortReasonAtLog.isEmpty ? nil : $0.plannedEffortReasonAtLog
            )
        },
        plannedSessions: coachPlannedSessions(from: sessions).map {
            CoachPlannedSession(
                id: $0.id.uuidString,
                scheduledDate: $0.scheduledDate,
                title: $0.title,
                focus: $0.focus.rawValue,
                status: $0.status.rawValue,
                exercises: (prescriptionsBySession[$0.id] ?? [])
                    .sorted { $0.orderIndex < $1.orderIndex }
                    .map {
                        CoachPlannedExercisePrescription(
                            exercise: $0.exercise.rawValue,
                            sets: $0.sets,
                            targetReps: $0.targetReps,
                            targetSeconds: $0.targetSeconds,
                            plannedEffortLabel: $0.plannedEffortLabel?.rawValue,
                            plannedEffortStimulus: $0.plannedEffortStimulus?.rawValue
                        )
                    }
            )
        },
        running: running
    )
}

func coachHistoryLogs(from logs: [PerformanceLog], now: Date = Date()) -> [PerformanceLog] {
    let cutoff = Calendar.current.date(byAdding: .month, value: -3, to: now) ?? Date.distantPast
    return logs
        .filter { $0.completedAt >= cutoff }
        .sorted { $0.completedAt < $1.completedAt }
}

func coachPlannedSessions(from sessions: [WorkoutSession], now: Date = Date()) -> [WorkoutSession] {
    let start = Calendar.current.date(byAdding: .month, value: -2, to: now) ?? Date.distantPast
    let end = Calendar.current.date(byAdding: .month, value: 1, to: now) ?? Date.distantFuture
    return sessions
        .filter { $0.scheduledDate >= start && $0.scheduledDate <= end }
        .sorted { $0.scheduledDate < $1.scheduledDate }
}

struct LocalCoachClient {
    static let defaultEndpointString = "https://lockin.elevenfactor.com/generate-week-plan"
    private static let hostedProxyHost = "lockin.elevenfactor.com"

    var endpoint: URL
    var session: URLSession = .shared
    var validator = CoachPlanValidator()
    var runningValidator = RunningWeekValidator()

    init(endpointString: String = defaultEndpointString) throws {
        guard let endpoint = Self.normalizedEndpoint(from: endpointString) else { throw CoachClientError.invalidURL }
        self.endpoint = endpoint
    }

    func generatePlan(request: CoachPlanRequest, baseline: Baseline, preferences: TrainingPreferences) async throws -> CoachPlanResponse {
        var urlRequest = URLRequest(url: endpoint)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 120
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONEncoder.coachEncoder.encode(request)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: urlRequest)
        } catch let error as URLError {
            if error.isLocalProxyConnectionFailure {
                throw CoachClientError.proxyUnavailable(endpoint, error)
            }
            throw CoachClientError.transportFailed(endpoint, error)
        }

        guard let http = response as? HTTPURLResponse else { throw CoachClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CoachClientError.invalidStatus(http.statusCode, proxyErrorMessage(from: data))
        }

        let plan = try JSONDecoder.coachDecoder.decode(CoachPlanResponse.self, from: data)
        let validation = validator.validate(
            response: plan,
            baseline: baseline,
            preferences: preferences,
            weekStart: request.weekStart,
            plannedSessions: request.plannedSessions,
            trainingLogs: request.trainingLogs
        )
        guard validation.status != .rejected else { throw CoachClientError.validationFailed(validation.messages) }
        return plan
    }

    func generateCombinedWeek(request: CoachPlanRequest, baseline: Baseline, preferences: TrainingPreferences) async throws -> CombinedWeekResponse {
        guard let weekEndpoint = Self.generateWeekEndpoint(from: endpoint) else { throw CoachClientError.invalidURL }
        var urlRequest = URLRequest(url: weekEndpoint)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 240
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONEncoder.coachEncoder.encode(request)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: urlRequest)
        } catch let error as URLError {
            if error.isLocalProxyConnectionFailure {
                throw CoachClientError.proxyUnavailable(weekEndpoint, error)
            }
            throw CoachClientError.transportFailed(weekEndpoint, error)
        }

        guard let http = response as? HTTPURLResponse else { throw CoachClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CoachClientError.invalidStatus(http.statusCode, proxyErrorMessage(from: data))
        }

        let combined = try JSONDecoder.coachDecoder.decode(CombinedWeekResponse.self, from: data)
        let strengthValidation = validator.validate(
            response: combined.strengthWeek,
            baseline: baseline,
            preferences: preferences,
            weekStart: request.weekStart,
            plannedSessions: request.plannedSessions,
            trainingLogs: request.trainingLogs
        )
        guard strengthValidation.status != .rejected else { throw CoachClientError.validationFailed(strengthValidation.messages) }
        let runningValidation = runningValidator.validate(
            response: combined.runningWeek,
            allowedDayOffsets: request.running?.runningDayOffsets ?? []
        )
        guard runningValidation.status != .rejected else { throw CoachClientError.validationFailed(runningValidation.messages) }
        return combined
    }

    func generateVerdict(request: CoachPlanRequest) async throws -> CoachVerdictResponse {
        guard let verdictEndpoint = Self.verdictEndpoint(from: endpoint) else { throw CoachClientError.invalidURL }
        var urlRequest = URLRequest(url: verdictEndpoint)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 90
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONEncoder.coachEncoder.encode(request)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: urlRequest)
        } catch let error as URLError {
            if error.isLocalProxyConnectionFailure {
                throw CoachClientError.proxyUnavailable(verdictEndpoint, error)
            }
            throw CoachClientError.transportFailed(verdictEndpoint, error)
        }

        guard let http = response as? HTTPURLResponse else { throw CoachClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CoachClientError.invalidStatus(http.statusCode, proxyErrorMessage(from: data))
        }

        return try JSONDecoder.coachDecoder.decode(CoachVerdictResponse.self, from: data)
    }

    func fetchProxyHealth() async throws -> CoachProxyHealthResponse {
        guard let healthEndpoint = Self.healthEndpoint(from: endpoint) else { throw CoachClientError.invalidURL }
        let urlRequest = URLRequest(url: healthEndpoint)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: urlRequest)
        } catch let error as URLError {
            if error.isLocalProxyConnectionFailure {
                throw CoachClientError.proxyUnavailable(healthEndpoint, error)
            }
            throw CoachClientError.transportFailed(healthEndpoint, error)
        }

        guard let http = response as? HTTPURLResponse else { throw CoachClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CoachClientError.invalidStatus(http.statusCode, proxyErrorMessage(from: data))
        }

        return try JSONDecoder.coachDecoder.decode(CoachProxyHealthResponse.self, from: data)
    }

    func fetchAvailableModels() async throws -> CoachModelsResponse {
        guard let modelEndpoint = Self.modelEndpoint(from: endpoint) else { throw CoachClientError.invalidURL }
        let urlRequest = URLRequest(url: modelEndpoint)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: urlRequest)
        } catch let error as URLError {
            if error.isLocalProxyConnectionFailure {
                throw CoachClientError.proxyUnavailable(modelEndpoint, error)
            }
            throw CoachClientError.transportFailed(modelEndpoint, error)
        }

        guard let http = response as? HTTPURLResponse else { throw CoachClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CoachClientError.invalidStatus(http.statusCode, proxyErrorMessage(from: data))
        }

        return try JSONDecoder.coachDecoder.decode(CoachModelsResponse.self, from: data)
    }

    func fetchGarminStatus() async throws -> GarminStatusResponse {
        guard let statusEndpoint = Self.garminStatusEndpoint(from: endpoint) else { throw CoachClientError.invalidURL }
        var urlRequest = URLRequest(url: statusEndpoint)
        urlRequest.timeoutInterval = 15

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: urlRequest)
        } catch let error as URLError {
            if error.isLocalProxyConnectionFailure {
                throw CoachClientError.proxyUnavailable(statusEndpoint, error)
            }
            throw CoachClientError.transportFailed(statusEndpoint, error)
        }

        guard let http = response as? HTTPURLResponse else { throw CoachClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CoachClientError.invalidStatus(http.statusCode, proxyErrorMessage(from: data))
        }

        return try JSONDecoder.coachDecoder.decode(GarminStatusResponse.self, from: data)
    }

    func fetchGarminSnapshot(sinceDays: Int = 7) async throws -> GarminSnapshotResponse {
        guard let snapshotEndpoint = Self.garminSnapshotEndpoint(from: endpoint, sinceDays: sinceDays) else {
            throw CoachClientError.invalidURL
        }
        var urlRequest = URLRequest(url: snapshotEndpoint)
        // The proxy route budget is 120s (a cold sidecar cache serializes ~29
        // upstream Garmin calls), so leave headroom on top of that.
        urlRequest.timeoutInterval = 150

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: urlRequest)
        } catch let error as URLError {
            if error.isLocalProxyConnectionFailure {
                throw CoachClientError.proxyUnavailable(snapshotEndpoint, error)
            }
            throw CoachClientError.transportFailed(snapshotEndpoint, error)
        }

        guard let http = response as? HTTPURLResponse else { throw CoachClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CoachClientError.invalidStatus(http.statusCode, proxyErrorMessage(from: data))
        }

        return try JSONDecoder.coachDecoder.decode(GarminSnapshotResponse.self, from: data)
    }

    func pushWorkoutsToGarmin(_ workouts: [GarminPushWorkout]) async throws -> GarminPushResponse {
        guard let pushEndpoint = Self.garminPushEndpoint(from: endpoint) else { throw CoachClientError.invalidURL }
        var urlRequest = URLRequest(url: pushEndpoint)
        urlRequest.httpMethod = "POST"
        // The proxy gives the sidecar a 60s budget per batch; leave headroom.
        urlRequest.timeoutInterval = 90
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONEncoder.coachEncoder.encode(GarminPushRequest(workouts: workouts))

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: urlRequest)
        } catch let error as URLError {
            if error.isLocalProxyConnectionFailure {
                throw CoachClientError.proxyUnavailable(pushEndpoint, error)
            }
            throw CoachClientError.transportFailed(pushEndpoint, error)
        }

        guard let http = response as? HTTPURLResponse else { throw CoachClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CoachClientError.invalidStatus(http.statusCode, proxyErrorMessage(from: data))
        }

        return try JSONDecoder.coachDecoder.decode(GarminPushResponse.self, from: data)
    }

    func deleteGarminWorkouts(_ ids: [String]) async throws -> GarminDeleteResponse {
        guard !ids.isEmpty else { return GarminDeleteResponse(results: []) }
        guard let deleteEndpoint = Self.garminDeleteEndpoint(from: endpoint) else { throw CoachClientError.invalidURL }
        var urlRequest = URLRequest(url: deleteEndpoint)
        urlRequest.httpMethod = "POST"
        // Same sidecar budget as the push path.
        urlRequest.timeoutInterval = 90
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONEncoder.coachEncoder.encode(GarminDeleteRequest(workoutIds: ids))

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: urlRequest)
        } catch let error as URLError {
            if error.isLocalProxyConnectionFailure {
                throw CoachClientError.proxyUnavailable(deleteEndpoint, error)
            }
            throw CoachClientError.transportFailed(deleteEndpoint, error)
        }

        guard let http = response as? HTTPURLResponse else { throw CoachClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CoachClientError.invalidStatus(http.statusCode, proxyErrorMessage(from: data))
        }

        return try JSONDecoder.coachDecoder.decode(GarminDeleteResponse.self, from: data)
    }

    private static func normalizedEndpoint(from value: String) -> URL? {
        var rawValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawValue.isEmpty else { return nil }
        if !rawValue.contains("://") {
            rawValue = "https://\(rawValue)"
        }
        guard var components = URLComponents(string: rawValue) else { return nil }
        guard components.scheme?.lowercased() == "https" else { return nil }
        guard components.host?.lowercased() == hostedProxyHost else { return nil }
        components.scheme = "https"
        components.host = hostedProxyHost
        if components.path.isEmpty || components.path == "/" {
            components.path = "/generate-week-plan"
        }
        return components.url
    }

    private static func generateWeekEndpoint(from endpoint: URL) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/generate-week"
        components.query = nil
        return components.url
    }

    private static func verdictEndpoint(from endpoint: URL) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/coach-verdict"
        components.query = nil
        return components.url
    }

    private static func healthEndpoint(from endpoint: URL) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/health"
        components.query = nil
        return components.url
    }

    private static func modelEndpoint(from endpoint: URL) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/models"
        components.query = nil
        return components.url
    }

    private static func garminStatusEndpoint(from endpoint: URL) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/garmin/status"
        components.query = nil
        return components.url
    }

    private static func garminSnapshotEndpoint(from endpoint: URL, sinceDays: Int) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/garmin/snapshot"
        components.queryItems = [URLQueryItem(name: "sinceDays", value: "\(sinceDays)")]
        return components.url
    }

    private static func garminPushEndpoint(from endpoint: URL) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/garmin/push-workouts"
        components.query = nil
        return components.url
    }

    private static func garminDeleteEndpoint(from endpoint: URL) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/garmin/delete-workouts"
        components.query = nil
        return components.url
    }

    private func proxyErrorMessage(from data: Data) -> String? {
        guard !data.isEmpty else { return nil }
        if
            let object = try? JSONSerialization.jsonObject(with: data),
            let dictionary = object as? [String: Any]
        {
            var parts: [String] = []
            if let error = dictionary["error"] as? String {
                parts.append(error)
            } else if
                let error = dictionary["error"] as? [String: Any],
                let message = error["message"] as? String
            {
                parts.append(message)
            }
            if let messages = dictionary["messages"] as? [String], !messages.isEmpty {
                parts.append(messages.joined(separator: "\n"))
            }
            if let contextState = dictionary["contextState"] as? String {
                parts.append("Context state: \(contextState)")
            }
            return parts.isEmpty ? nil : parts.joined(separator: "\n")
        }

        let rawMessage = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return rawMessage?.isEmpty == false ? rawMessage : nil
    }
}

extension JSONEncoder {
    static var coachEncoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}

extension JSONDecoder {
    static var coachDecoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
