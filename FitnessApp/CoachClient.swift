import Foundation

struct CoachPlanRequest: Codable, Equatable {
    var model: String
    var baseline: CoachBaseline
    var goals: CoachGoals
    var weekStart: Date
    var weeklySessions: Int
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
    - last 5 logs
    - current partial month
    - last full month
    - previous full month
    - two-month trend
    - readiness and risk flags

    Local safety and policy check after the model call:
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
    var engine = TrainingEngine()

    func validate(response: CoachPlanResponse, baseline: Baseline, preferences: TrainingPreferences, weekStart: Date) -> PlanValidationResult {
        var messages: [String] = []

        if response.sessions.count != preferences.weeklySessions {
            messages.append("AI plan must contain exactly \(preferences.weeklySessions) sessions.")
        }

        let hasPullUpBar = preferences.equipment.contains(.pullUpBar)
        var weeklyPatterns: Set<MovementPattern> = []
        var balancedSessionCount = 0
        var previousDayOffset = -1

        for (index, session) in response.sessions.enumerated() {
            if !(0...6).contains(session.dayOffset) {
                messages.append("AI session \(index + 1) must have a day offset from 0 through 6.")
            }

            if session.dayOffset <= previousDayOffset {
                messages.append("AI sessions must use strictly increasing day offsets.")
            }
            previousDayOffset = session.dayOffset

            guard let focus = SessionFocus(rawValue: session.focus) else {
                messages.append("AI session \(index + 1) has an unknown focus.")
                continue
            }

            var prescribedGoalFields: Set<String> = []
            var sessionPatterns: Set<MovementPattern> = []

            for exercise in session.exercises {
                guard let kind = ExerciseKind(rawValue: exercise.exercise) else {
                    messages.append("AI session \(index + 1) has an unknown exercise.")
                    continue
                }

                if exercise.sets < 1 || exercise.sets > 10 {
                    messages.append("AI session \(index + 1) has an unsafe set count.")
                }

                if exercise.reps < 0 || exercise.seconds < 0 || exercise.restSeconds < 0 {
                    messages.append("AI session \(index + 1) has a negative reps, hold, or rest value.")
                }

                if let field = loggingField(for: kind) {
                    prescribedGoalFields.insert(field)
                }

                for pattern in movementPatterns(for: kind) {
                    sessionPatterns.insert(pattern)
                    weeklyPatterns.insert(pattern)
                }

                if response.contextState == "recovery_needed" && isHardIntensity(exercise.intensity) {
                    messages.append("Recovery-needed AI plan contains hard intensity.")
                }
            }

            if focus == .mixed && !isBalancedEnough(sessionPatterns, hasPullUpBar: hasPullUpBar) {
                messages.append("AI session \(index + 1) is marked mixed without enough movement coverage.")
            }

            if let focusPattern = MovementPattern(focus: focus), !sessionPatterns.contains(focusPattern) {
                messages.append("AI session \(index + 1) is marked \(focus.rawValue) but does not train that pattern.")
            }

            if response.contextState != "recovery_needed", focus != .mixed, focus != .recovery, sessionPatterns.count < 2 {
                messages.append("AI session \(index + 1) is a single-focus day without support work.")
            }

            if isBalancedEnough(sessionPatterns, hasPullUpBar: hasPullUpBar) {
                balancedSessionCount += 1
            }

            for field in prescribedGoalFields where !session.loggingFieldsRequired.contains(field) {
                messages.append("AI session \(index + 1) prescribes \(field) but does not require that log field.")
            }

            for field in session.loggingFieldsRequired where !prescribedGoalFields.contains(field) {
                messages.append("AI session \(index + 1) requires \(field) logging without prescribing that goal exercise.")
            }
        }

        if response.contextState != "recovery_needed" {
            if hasPullUpBar && !weeklyPatterns.contains(.pull) {
                messages.append("AI plan does not include pull exposure.")
            }
            if !weeklyPatterns.contains(.push) {
                messages.append("AI plan does not include push exposure.")
            }
            if !weeklyPatterns.contains(.core) {
                messages.append("AI plan does not include core exposure.")
            }

            let requiredBalancedSessions = preferences.weeklySessions >= 4 ? 2 : preferences.weeklySessions >= 3 ? 1 : 0
            if balancedSessionCount < requiredBalancedSessions {
                messages.append("AI plan does not include enough mixed or full-body sessions.")
            }
        }

        let week = response.weeklyPlan(weekStart: weekStart)
        let engineResult = engine.validate(plan: week, preferences: preferences, baseline: baseline)
        messages.append(contentsOf: engineResult.messages)

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

private enum MovementPattern {
    case pull
    case push
    case core

    init?(focus: SessionFocus) {
        switch focus {
        case .pull:
            self = .pull
        case .push:
            self = .push
        case .core:
            self = .core
        case .mixed, .recovery:
            return nil
        }
    }
}

private func movementPatterns(for exercise: ExerciseKind) -> Set<MovementPattern> {
    switch exercise {
    case .pullUp, .scapularPull, .deadHang:
        return [.pull]
    case .pushUp, .inclinePushUp, .pikePushUp:
        return [.push]
    case .plank, .hollowHold:
        return [.core]
    case .shoulderMobility:
        return []
    }
}

private func loggingField(for exercise: ExerciseKind) -> String? {
    switch exercise {
    case .pullUp:
        return "pullUps"
    case .pushUp:
        return "pushUps"
    case .plank:
        return "plankSeconds"
    default:
        return nil
    }
}

private func isBalancedEnough(_ patterns: Set<MovementPattern>, hasPullUpBar: Bool) -> Bool {
    if hasPullUpBar {
        return patterns.contains(.pull) && patterns.contains(.push) && patterns.contains(.core)
    }
    return patterns.contains(.push) && patterns.contains(.core)
}

private func isHardIntensity(_ intensity: String) -> Bool {
    let lowercased = intensity.lowercased()
    return lowercased.contains("hard") || lowercased.contains("max") || lowercased.contains("failure")
}

struct LocalCoachClient {
    static let defaultEndpointString = "https://lockin.elevenfactor.com/generate-week-plan"

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
        guard let host = components.host?.lowercased(), !host.isLoopbackProxyHost else { return nil }
        if components.path.isEmpty || components.path == "/" {
            components.path = "/generate-week-plan"
        }
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

private extension String {
    var isLoopbackProxyHost: Bool {
        self == "localhost" || self == "127.0.0.1" || self == "::1" || self == "0.0.0.0"
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
