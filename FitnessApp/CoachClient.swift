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
}

struct CoachPlannedSession: Codable, Equatable {
    var id: String
    var scheduledDate: Date
    var title: String
    var focus: String
    var status: String
}

struct CoachPlanResponse: Codable, Equatable {
    var summary: String
    var contextState: String
    var safetyFlags: [String]
    var sessions: [CoachSessionResponse]
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

struct CoachSessionResponse: Codable, Equatable {
    var title: String
    var dayOffset: Int
    var focus: String
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

    func validate(response: CoachPlanResponse, baseline _: Baseline, preferences: TrainingPreferences, weekStart: Date) -> PlanValidationResult {
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
                                    intensity: exercise.intensity
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
                notes: $0.notes
            )
        },
        plannedSessions: coachPlannedSessions(from: sessions).map {
            CoachPlannedSession(
                id: $0.id.uuidString,
                scheduledDate: $0.scheduledDate,
                title: $0.title,
                focus: $0.focus.rawValue,
                status: $0.status.rawValue
            )
        }
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
        let validation = validator.validate(response: plan, baseline: baseline, preferences: preferences, weekStart: request.weekStart)
        guard validation.status != .rejected else { throw CoachClientError.validationFailed(validation.messages) }
        return plan
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
