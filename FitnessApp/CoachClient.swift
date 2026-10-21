import Foundation
import SwiftData

/// Owns the planned-run Garmin sync flow. The proxy is the durable source of
/// truth for deletes, retries, and created Garmin IDs; the app submits its
/// desired future runs and caches the returned status on matching sessions.
@MainActor
enum GarminSyncCoordinator {
    static let watchRetryNote = "Runs are planned but not all on your watch yet. Retry from the Garmin row."

    private(set) static var isSyncing = false
    private static var needsResync = false
    private static let lastPlanRevisionKey = "garminLastSyncedPlanRevisionId"

    /// Sends the desired future running plan to the proxy. The proxy deletes
    /// stale workout ids first, creates only missing/replaced future runs, and
    /// keeps failed work durable for retry. Stale ids are queued on the device
    /// first, so a sync requested while another one runs is not lost: the
    /// running sync loops once more and sends them.
    static func syncPlannedRuns(
        endpoint: String,
        userId: String,
        planRevisionId: String,
        stalePushedIds: [String],
        in modelContext: ModelContext
    ) async -> String? {
        let staleQueue = GarminStaleWorkoutQueue()
        staleQueue.enqueue(stalePushedIds)
        UserDefaults.standard.set(planRevisionId, forKey: lastPlanRevisionKey)
        guard let client = try? LocalCoachClient(endpointString: endpoint) else { return watchRetryNote }
        guard !isSyncing else {
            needsResync = true
            return nil
        }

        isSyncing = true
        defer { isSyncing = false }

        var message: String?
        repeat {
            needsResync = false
            do {
                let staleIds = staleQueue.pending
                let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>(sortBy: [SortDescriptor(\.scheduledDate)]))
                let request = makeGarminSyncPlanRequest(
                    userId: userId,
                    planRevisionId: planRevisionId,
                    staleWorkoutIds: staleIds,
                    sessions: sessions
                )
                guard !request.workouts.isEmpty || !request.staleWorkoutIds.isEmpty else {
                    continue
                }

                let response = try await client.syncGarminPlan(request)
                staleQueue.remove(staleIds)
                let refreshedSessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())
                _ = applyGarminSyncResults(response.workouts, to: refreshedSessions)
                try modelContext.save()
                message = response.message
            } catch {
                markFutureRunsForSyncRetry(in: modelContext, error: error.localizedDescription)
                return watchRetryNote
            }
        } while needsResync
        return message
    }

    static func retryFailedSync(
        endpoint: String,
        userId: String,
        in modelContext: ModelContext
    ) async -> String {
        guard let client = try? LocalCoachClient(endpointString: endpoint) else { return watchRetryNote }
        guard !isSyncing else { return "Garmin sync is already running." }

        isSyncing = true
        let message: String
        do {
            let response = try await client.retryGarminSync(userId: userId)
            let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())
            _ = applyGarminSyncResults(response.workouts, to: sessions)
            try modelContext.save()
            message = response.message
        } catch {
            message = error.localizedDescription
        }
        isSyncing = false

        // A plan applied while the retry ran, or stale ids still queued: push
        // the current plan now instead of waiting for the next replan.
        if needsResync || !GarminStaleWorkoutQueue().pending.isEmpty {
            let revision = UserDefaults.standard.string(forKey: lastPlanRevisionKey) ?? "retry"
            _ = await syncPlannedRuns(endpoint: endpoint, userId: userId, planRevisionId: revision, stalePushedIds: [], in: modelContext)
        }
        return message
    }

    private static func markFutureRunsForSyncRetry(in modelContext: ModelContext, error: String) {
        guard let sessions = try? futurePlannedRunsForGarmin(from: modelContext.fetch(FetchDescriptor<WorkoutSession>())) else { return }
        let now = Date()
        for session in sessions where session.garminSyncStatus != .synced {
            session.garminSyncStatus = .retrying
            session.garminSyncError = error
            session.garminSyncUpdatedAt = now
        }
        try? modelContext.save()
    }
}

/// Future planned runs are the proxy's desired state. Today's run is
/// excluded: it is locked during replans, so an existing watch workout stays
/// valid, and pushing a new one mid-day would land too late anyway. The
/// request's `lockedThroughDate` tells the proxy not to read today's missing
/// run as "deleted".
func futurePlannedRunsForGarmin(from sessions: [WorkoutSession], now: Date = Date(), calendar: Calendar = .current) -> [WorkoutSession] {
    let endOfToday = calendar.dateInterval(of: .day, for: now)?.end ?? now
    return sessions
        .filter { $0.discipline == .running && $0.status == .planned && $0.scheduledDate >= endOfToday }
        .sorted { $0.scheduledDate < $1.scheduledDate }
}

func makeGarminSyncPlanRequest(
    userId: String,
    planRevisionId: String,
    staleWorkoutIds: [String],
    sessions: [WorkoutSession],
    now: Date = Date(),
    calendar: Calendar = .current
) -> GarminSyncPlanRequest {
    GarminSyncPlanRequest(
        userId: userId,
        planRevisionId: planRevisionId,
        staleWorkoutIds: staleWorkoutIds,
        workouts: garminSyncWorkouts(from: futurePlannedRunsForGarmin(from: sessions, now: now, calendar: calendar), calendar: calendar),
        lockedThroughDate: garminCalendarDateString(now, calendar: calendar)
    )
}

private func garminCalendarDateString(_ date: Date, calendar: Calendar) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = calendar
    formatter.timeZone = calendar.timeZone
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: date)
}

/// Garmin workout ids that must be deleted from the watch, kept on the
/// device until a sync has sent them. Survives app restarts.
struct GarminStaleWorkoutQueue {
    static let key = "garminPendingStaleWorkoutIds"
    var defaults: UserDefaults = .standard

    var pending: [String] {
        defaults.stringArray(forKey: Self.key) ?? []
    }

    func enqueue(_ ids: [String]) {
        var updated = pending
        for id in ids where !id.isEmpty && !updated.contains(id) {
            updated.append(id)
        }
        defaults.set(updated, forKey: Self.key)
    }

    func remove(_ ids: [String]) {
        let sent = Set(ids)
        defaults.set(pending.filter { !sent.contains($0) }, forKey: Self.key)
    }
}

/// What a plan trigger did, for the screen that asked: the message to show
/// and whether a new plan actually landed on the device.
struct AutoPlanTriggerOutcome: Equatable {
    var message: String
    var appliedNewPlan: Bool
    /// False when the request never got an answer (offline, busy, bad URL).
    var reachedProxy: Bool = false

    /// True when the error is the coach proxy's own answer (an HTTP error
    /// status or a body that failed checks), so the screen shows the proxy's
    /// message instead of "offline" and the app doesn't re-ask on every open.
    /// Gateway errors (502-504) mean the proxy itself is down: not answered.
    static func proxyAnswered(despite error: Error) -> Bool {
        switch error as? CoachClientError {
        case .invalidStatus(let status, _)?:
            return ![502, 503, 504].contains(status)
        case .invalidResponse?, .validationFailed?:
            return true
        default:
            return false
        }
    }
}

/// A brand-new profile (no sessions at all) gets one forced first plan
/// instead of waiting for the nightly run. Only once per profile: if that
/// plan fails or is legitimately empty, later opens use the normal throttle
/// instead of forcing a new OpenAI generation every time.
enum FirstPlanRequest {
    private static func key(_ profileId: String) -> String { "firstPlanRequested.\(profileId)" }

    static func shouldForce(profileId: String, sessionCount: Int, defaults: UserDefaults = .standard) -> Bool {
        sessionCount == 0 && !defaults.bool(forKey: key(profileId))
    }

    static func markRequested(profileId: String, defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: key(profileId))
    }
}

@MainActor
enum AutoPlanCoordinator {
    private(set) static var isTriggering = false
    static let busyMessage = "Planning is already running. Try again in a moment."

    static func trigger(
        endpoint: String,
        source: AutoPlanTriggerSource,
        reason: String,
        force: Bool = false,
        request: CoachPlanRequest,
        profile: UserProfile,
        in modelContext: ModelContext
    ) async -> AutoPlanTriggerOutcome {
        guard !isTriggering, !GarminSyncCoordinator.isSyncing else {
            return AutoPlanTriggerOutcome(message: busyMessage, appliedNewPlan: false)
        }
        let client: LocalCoachClient
        do {
            client = try LocalCoachClient(endpointString: endpoint)
        } catch {
            return AutoPlanTriggerOutcome(message: error.localizedDescription, appliedNewPlan: false)
        }

        isTriggering = true
        defer { isTriggering = false }

        var proxyAnswered = false
        do {
            let response = try await client.triggerAutoPlan(AutoPlanTriggerRequest(
                source: source,
                reason: reason,
                force: force,
                timeZone: TimeZone.current.identifier,
                request: request
            ))
            proxyAnswered = true
            if let generatedPlan = response.generatedPlan, response.generated {
                let result = try await apply(generatedPlan: generatedPlan, endpoint: endpoint, profile: profile, in: modelContext)
                return AutoPlanTriggerOutcome(message: result.message ?? response.message, appliedNewPlan: result.applied, reachedProxy: true)
            }
            return AutoPlanTriggerOutcome(message: response.message, appliedNewPlan: false, reachedProxy: true)
        } catch {
            return AutoPlanTriggerOutcome(
                message: error.localizedDescription,
                appliedNewPlan: false,
                reachedProxy: proxyAnswered || AutoPlanTriggerOutcome.proxyAnswered(despite: error)
            )
        }
    }

    static func applyLatestServerPlan(
        endpoint: String,
        profile: UserProfile,
        in modelContext: ModelContext
    ) async -> String? {
        guard !isTriggering, !GarminSyncCoordinator.isSyncing else { return nil }
        guard let client = try? LocalCoachClient(endpointString: endpoint) else { return nil }

        isTriggering = true
        defer { isTriggering = false }

        do {
            let status = try await client.fetchAutoPlanStatus(userId: profile.id.uuidString)
            guard let generatedPlan = status.generatedPlan else { return status.message }
            let result = try await apply(generatedPlan: generatedPlan, endpoint: endpoint, profile: profile, in: modelContext)
            return result.message ?? status.message
        } catch {
            return nil
        }
    }

    private static func apply(
        generatedPlan: AutoPlanGeneratedPlan,
        endpoint: String,
        profile: UserProfile,
        in modelContext: ModelContext
    ) async throws -> (applied: Bool, message: String?) {
        guard shouldApply(planRevisionId: generatedPlan.planRevisionId, userId: profile.id.uuidString) else { return (false, nil) }

        // The proxy validates too, but the device is the last gate before the
        // athlete's schedule changes: a plan on rest days or today is dropped.
        let structure = validateGeneratedPlanStructure(generatedPlan, profile: profile)
        guard structure.status != .rejected else {
            markApplied(planRevisionId: generatedPlan.planRevisionId, userId: profile.id.uuidString)
            return (false, "Skipped a coach plan that did not fit your training days: " + structure.messages.joined(separator: " "))
        }

        var stalePushedIds: [String] = []

        if let combinedWeek = generatedPlan.combinedWeek {
            var strengthPlan = combinedWeek.strengthWeek.weeklyPlan(weekStart: generatedPlan.weekStart)
            strengthPlan.summary = combinedWeek.safetyFlags.isEmpty
                ? combinedWeek.summary
                : combinedWeek.summary + " Watch: " + combinedWeek.safetyFlags.joined(separator: " ")
            try saveAtomically(in: modelContext) {
                try persist(plan: strengthPlan, in: modelContext, source: .ai, replacingFuturePlannedSessions: true)
                stalePushedIds = try persist(runningWeek: combinedWeek.runningWeek, weekStart: generatedPlan.weekStart, in: modelContext, replacingFuturePlannedSessions: true)
            }
        } else if let strengthWeek = generatedPlan.strengthWeek {
            let plan = strengthWeek.weeklyPlan(weekStart: generatedPlan.weekStart)
            try saveAtomically(in: modelContext) {
                try persist(plan: plan, in: modelContext, source: .ai, replacingFuturePlannedSessions: true)
            }
        } else {
            return (false, nil)
        }

        markApplied(planRevisionId: generatedPlan.planRevisionId, userId: profile.id.uuidString)
        await refreshWorkoutReminders(in: modelContext)
        _ = await GarminSyncCoordinator.syncPlannedRuns(
            endpoint: endpoint,
            userId: profile.id.uuidString,
            planRevisionId: generatedPlan.planRevisionId,
            stalePushedIds: stalePushedIds,
            in: modelContext
        )
        return (true, nil)
    }

    private static func saveAtomically(in modelContext: ModelContext, _ mutate: () throws -> Void) throws {
        do {
            try mutate()
            try modelContext.save()
        } catch {
            modelContext.rollback()
            throw error
        }
    }

    private static func shouldApply(planRevisionId: String, userId: String) -> Bool {
        UserDefaults.standard.string(forKey: appliedRevisionKey(userId: userId)) != planRevisionId
    }

    private static func markApplied(planRevisionId: String, userId: String) {
        UserDefaults.standard.set(planRevisionId, forKey: appliedRevisionKey(userId: userId))
    }

    private static func appliedRevisionKey(userId: String) -> String {
        "autoPlanLastAppliedRevision.\(userId)"
    }
}

/// Structural checks on a server plan before it replaces the athlete's
/// schedule: days 1–6 only (today stays locked), strictly increasing,
/// strength only on selected training days, runs only on selected running
/// days (an empty running selection means any day), and known exercises
/// and run kinds. Coaching quality is the proxy's job.
func validateGeneratedPlanStructure(
    _ plan: AutoPlanGeneratedPlan,
    profile: UserProfile,
    calendar: Calendar = .current
) -> PlanValidationResult {
    var messages: [String] = []
    let strengthWeek = plan.combinedWeek?.strengthWeek ?? plan.strengthWeek
    let runningWeek = plan.combinedWeek?.runningWeek ?? plan.runningWeek

    if let strengthWeek {
        let selectedDays = TrainingWeekday.normalized(profile.trainingDays, weeklySessions: profile.weeklySessions)
        let allowed = TrainingWeekday.dayOffsets(
            for: Set(selectedDays),
            weeklySessions: selectedDays.count,
            weekStart: plan.weekStart,
            calendar: calendar
        ).filter { (1...6).contains($0) }
        messages += CoachPlanValidator().validateStructure(response: strengthWeek, allowedDayOffsets: allowed).messages
    }

    if let runningWeek {
        let allowed = profile.runningDays.isEmpty ? [] : TrainingWeekday.dayOffsets(
            for: profile.runningDays,
            weeklySessions: profile.runningDays.count,
            weekStart: plan.weekStart,
            calendar: calendar
        ).filter { (1...6).contains($0) }
        messages += RunningWeekValidator().validate(
            response: runningWeek,
            allowedDayOffsets: allowed,
            hasSelectedDays: !profile.runningDays.isEmpty
        ).messages
    }

    return PlanValidationResult(status: messages.isEmpty ? .accepted : .rejected, messages: messages)
}

struct CoachPlanRequest: Codable, Equatable {
    var userId: String
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
    /// Local midnight of the day the current plan block began, so the proxy
    /// can tell which week of the block it plans.
    var planBlockStartedAt: Date? = nil
    var running: CoachRunningRequest? = nil
    /// IANA zone of the athlete, so the proxy can find "today" and "due"
    /// with local midnights (DST-safe).
    var timeZone: String? = nil
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
    var elevationLossM: Int? = nil
    var averageHr: Int?
    var rpe: Int?
    var feelScore: Int? = nil   // 1 very weak ... 5 very strong; nil when never set
    /// The planned session's run kind when the run completed one, else a
    /// conservative inference (easy / tempo / long), else nil.
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
    static let defaultModelID = "gpt-6.1-sol"
    static let defaultModelIDs = [
        defaultModelID,
        "gpt-5.5",
        "gpt-5-mini"
    ]
    /// The @AppStorage key holding the athlete's model choice.
    static let selectedModelKey = "coachModelID"
    private static let migrationKey = "coachModelMigratedToDefault"

    /// Moves a stored model choice to the current default once per default
    /// change, so an app update switches the coach to the new model. A pick
    /// made after the migration is kept.
    static func migrateStoredSelection(defaults: UserDefaults = .standard) {
        guard defaults.string(forKey: migrationKey) != defaultModelID else { return }
        defaults.set(defaultModelID, forKey: selectedModelKey)
        defaults.set(defaultModelID, forKey: migrationKey)
    }

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
    var type: String   // "pace" | "hr" | "none" (the proxy dropped an implausible target: effort-based run)
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
    var runningRead: String?
    var strengthRead: String?
    var nextStep: String?
    var watchItems: [String]?
    var shouldUpdatePlan: Bool
    var contextState: String
    var safetyFlags: [String]
    var evaluation: CoachEvaluationResponse? = nil
    var snapshot: CoachSnapshotResponse? = nil
}

struct CoachEvaluationResponse: Codable, Equatable {
    var status: String
    var statusLabel: String
    var adherence: CoachAdherenceEvaluationResponse
    var readiness: CoachReadinessEvaluationResponse
    var progress: CoachProgressEvaluationResponse
    var planDecision: CoachPlanDecisionResponse
    var nextAction: String
}

struct CoachAdherenceEvaluationResponse: Codable, Equatable {
    var standardPct: Int
    var band: String
    var completedPct: Int?
    var dueSessions: Int
    var completedSessions: Int
    var partialSessions: Int
    var deloadSessions: Int
    var missedSessions: Int
    var futureSessionsExcluded: Int
    var rationale: String
}

struct CoachReadinessEvaluationResponse: Codable, Equatable {
    var state: String
    var painOrFatigueFlag: Bool
    var hrvGate: String?
    var trainingReadiness: Int?
    var riskFlags: [String]
    var rationale: String
}

struct CoachProgressEvaluationResponse: Codable, Equatable {
    var state: String
    var trendLabel: String
    var flatGoalMetrics: [String]
    var rationale: String
}

struct CoachPlanDecisionResponse: Codable, Equatable {
    var action: String
    var shouldUpdatePlan: Bool
    var rationale: String
}

struct CoachSnapshotResponse: Codable, Equatable {
    var version: Int
    var generatedAt: String
    var status: String
    var statusLabel: String
    var adherencePct: Int?
    var readinessState: String
    var planDecision: String
    var shouldUpdatePlan: Bool
    var nextAction: String
    var facts: [String]
}

struct CoachProxyHealthResponse: Codable, Equatable {
    var ok: Bool
    var hasApiKey: Bool
    var defaultModel: String
}

struct CoachChatTurnRequest: Codable, Equatable {
    var role: String
    var text: String
    var createdAt: Date?
}

struct CoachChatRequest: Codable, Equatable {
    var request: CoachPlanRequest
    var messages: [CoachChatTurnRequest]
}

/// Keep in sync with `CoachChatResponse` in Proxy/src/coach/chat.ts.
struct CoachChatResponse: Codable, Equatable {
    var answer: String
    var evidence: [String]
    var followUpPrompts: [String]
    var memorySummary: String
    var contextState: String
    var answerKind: String
    /// False when the proxy fell back to its built-in quick answer.
    var usedModel: Bool
    var generatedAt: Date
}

struct GarminStatusResponse: Codable, Equatable {
    var ok: Bool
    var userId: String?
    var loggedIn: Bool
    var state: GarminConnectionState?
    var connectedEmail: String?
    var lastError: String?
}

enum GarminConnectionState: String, Codable, Equatable {
    case notConnected = "not_connected"
    case credentialsRequired = "credentials_required"
    case mfaRequired = "mfa_required"
    case connected
}

extension GarminStatusResponse {
    /// Shared status vocabulary for every Garmin row (Settings card, Coach
    /// sync row). Fetch failure (no response at all) is a view-level
    /// "Unreachable" — this only maps a response we actually received.
    var displayState: (text: String, isHealthy: Bool) {
        if loggedIn {
            return ok ? ("Connected", true) : ("Degraded", false)
        }
        if state == .mfaRequired {
            return ("MFA needed", false)
        }
        return ("Not connected", false)
    }
}

struct GarminConnectRequest: Codable, Equatable {
    var userId: String
    var email: String
    var password: String
    var mfaCode: String?
}

struct GarminDisconnectRequest: Codable, Equatable {
    var userId: String
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
    /// Metrics the sidecar failed to fetch for this day (their values are
    /// 0 placeholders). Missing on older proxies.
    var unavailableMetrics: [String]? = nil
}

struct GarminActivityResponse: Codable, Equatable {
    var garminActivityId: String
    var startTime: String   // Garmin local time "2026-06-08 07:01:33" or ISO
    var activityType: String
    var distanceKm: Double
    var movingSeconds: Int
    var elevationGainM: Int
    // Optional: older proxies omit it; descent drives downhill conditioning.
    var elevationLossM: Int? = nil
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

enum GarminPlanSyncStatus: String, Codable, Equatable {
    case idle
    case syncing
    case synced
    case retrying
    case failed
    case blockedOnDelete = "blocked_on_delete"
}

struct GarminSyncWorkout: Codable, Equatable {
    var sessionId: String
    var title: String
    var date: String
    var kind: String
    var distanceKm: Double
    var durationMinutes: Int
    var target: GarminPushTarget
    var notes: String
    var existingGarminWorkoutId: String?
}

struct GarminSyncPlanRequest: Codable, Equatable {
    var userId: String
    var planRevisionId: String
    var staleWorkoutIds: [String]
    var workouts: [GarminSyncWorkout]
    /// The athlete's local today ("yyyy-MM-dd"). The proxy never deletes a
    /// synced workout dated on or before it just because it was not resent.
    var lockedThroughDate: String? = nil
}

struct GarminRetrySyncRequest: Codable, Equatable {
    var userId: String
}

struct GarminSyncWorkoutStatus: Codable, Equatable {
    var sessionId: String
    var status: GarminWorkoutSyncStatus
    var garminWorkoutId: String?
    var error: String?
    var pushedAt: String?
}

struct GarminSyncPlanResponse: Codable, Equatable {
    var userId: String
    var planRevisionId: String?
    var status: GarminPlanSyncStatus
    var message: String
    var workouts: [GarminSyncWorkoutStatus]
    var pendingDeleteCount: Int
    var failedDeleteCount: Int
    var nextRetryAt: String?
    var lastError: String?
}

enum AutoPlanTriggerSource: String, Codable, Equatable {
    case manual
    case postTraining = "post_training"
    case appActive = "app_active"
    case nightly
}

enum AutoPlanJobStatus: String, Codable, Equatable {
    case idle
    case queued
    case generating
    case generated
    case skipped
    case retrying
    case failed
}

struct AutoPlanTriggerRequest: Codable, Equatable {
    var source: AutoPlanTriggerSource
    var reason: String
    var force: Bool
    var timeZone: String
    var request: CoachPlanRequest
}

struct AutoPlanGeneratedPlan: Codable, Equatable {
    var planRevisionId: String
    var generatedAt: String
    var localDate: String
    var weekStart: Date
    var source: AutoPlanTriggerSource
    var summary: String
    var strengthWeek: CoachPlanResponse?
    var runningWeek: RunningWeekResponse?
    var combinedWeek: CombinedWeekResponse?
}

struct AutoPlanStatusResponse: Codable, Equatable {
    var userId: String
    var status: AutoPlanJobStatus
    var message: String
    var source: AutoPlanTriggerSource?
    var reason: String?
    var timeZone: String
    var lastTriggeredAt: String?
    var lastGeneratedAt: String?
    var nextNightlyRunAt: String?
    var nextRetryAt: String?
    var lastError: String?
    var planRevisionId: String?
    var generatedPlan: AutoPlanGeneratedPlan?
}

struct AutoPlanTriggerResponse: Codable, Equatable {
    var userId: String
    var status: AutoPlanJobStatus
    var action: String
    var message: String
    var source: AutoPlanTriggerSource?
    var lastGeneratedAt: String?
    var nextNightlyRunAt: String?
    var nextRetryAt: String?
    var planRevisionId: String?
    var generatedPlan: AutoPlanGeneratedPlan?
    var generated: Bool
    var strengthWeek: CoachPlanResponse?
    var runningWeek: RunningWeekResponse?
    var combinedWeek: CombinedWeekResponse?
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

/// Maps future planned running sessions onto the proxy's durable Garmin sync
/// contract. Existing Garmin IDs are sent so the server can adopt already
/// synced sessions instead of creating duplicates.
func garminSyncWorkouts(from sessions: [WorkoutSession], calendar: Calendar = .current) -> [GarminSyncWorkout] {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = calendar
    formatter.timeZone = calendar.timeZone
    formatter.dateFormat = "yyyy-MM-dd"

    return sessions
        .filter { $0.discipline == .running && $0.status == .planned }
        .map { session in
            GarminSyncWorkout(
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
                notes: session.runZone,
                existingGarminWorkoutId: session.garminWorkoutId.isEmpty ? nil : session.garminWorkoutId
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

/// Applies the durable proxy sync status to matching sessions. Synced items
/// receive their Garmin ID and push timestamp; failed/retrying items keep their
/// error for the UI.
@discardableResult
func applyGarminSyncResults(_ results: [GarminSyncWorkoutStatus], to sessions: [WorkoutSession], at date: Date = Date()) -> Int {
    var applied = 0
    for result in results {
        guard let session = sessions.first(where: { $0.id.uuidString == result.sessionId }) else { continue }
        session.garminSyncStatus = result.status
        session.garminSyncError = result.error ?? ""
        session.garminSyncUpdatedAt = date
        if result.status == .synced {
            session.garminWorkoutId = result.garminWorkoutId ?? session.garminWorkoutId
            session.pushedToGarminAt = parseGarminSyncDate(result.pushedAt) ?? date
        }
        applied += 1
    }
    return applied
}

private func parseGarminSyncDate(_ value: String?) -> Date? {
    guard let value, !value.isEmpty else { return nil }
    return ISO8601DateFormatter().date(from: value)
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
    case missingGarminRoute(URL)
    case missingCoachChatRoute(URL)
    case validationFailed([String])

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            "The hosted coach proxy URL is invalid. Use https://lockin.elevenfactor.com/generate-week-plan."
        case .proxyUnavailable(let endpoint, _):
            if LocalCoachClient.isPrivateDevelopmentHost(endpoint.host()?.lowercased() ?? "") {
                """
                The local coach proxy is not reachable at \(endpoint.absoluteString).

                Start it on your Mac with: cd Proxy && npm run dev. On a physical iPhone, use your Mac's LAN IP instead of 127.0.0.1.
                """
            } else {
                """
                The hosted coach proxy is not reachable at \(endpoint.absoluteString).

                Check that the Coolify deployment is healthy, DNS has propagated, and the app domain is set to https://lockin.elevenfactor.com.
                """
            }
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
        case .missingGarminRoute(let endpoint):
            """
            The hosted coach proxy is running, but it does not expose \(endpoint.path) yet.

            Redeploy the coach proxy with the Garmin routes, then make sure GARMIN_SERVICE_URL points to the Garmin service.
            """
        case .missingCoachChatRoute(let endpoint):
            if LocalCoachClient.isPrivateDevelopmentHost(endpoint.host()?.lowercased() ?? "") {
                """
                The local coach proxy is reachable at \(endpoint.absoluteString), but it does not expose coach chat yet.

                Restart it from this workspace with: cd Proxy && npm run dev.
                """
            } else {
                """
                The hosted coach proxy is running, but it does not expose \(endpoint.path) yet.

                For a Debug build on your iPhone, rebuild with COACH_PROXY_ENDPOINT set to your Mac's LAN proxy URL. For production, redeploy the hosted proxy with the coach chat route.
                """
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
        let maximumSessionCount = hasExplicitTrainingDays ? explicitDayOffsets.count : preferences.weeklySessions
        let allowedDayOffsets = hasExplicitTrainingDays ? Set(explicitDayOffsets) : []
        let hasSafetyFlags = !response.safetyFlags.isEmpty

        if !validContextStates.contains(response.contextState) {
            messages.append("AI plan has an unknown context state.")
        }

        if response.sessions.count > maximumSessionCount {
            messages.append("AI plan must contain no more than \(maximumSessionCount) future sessions.")
        }

        if maximumSessionCount > 0, response.sessions.isEmpty, !hasSafetyFlags {
            messages.append("AI plan has no future strength sessions, so safety flags must explain why.")
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

    /// The schedule-safety part of `validate`, without the coaching-quality
    /// rules: offsets 1–6 on allowed days, strictly increasing, no more
    /// sessions than allowed days, and known focus, exercises and counts.
    func validateStructure(response: CoachPlanResponse, allowedDayOffsets: [Int]) -> PlanValidationResult {
        var messages: [String] = []
        let allowed = Set(allowedDayOffsets)
        if response.sessions.count > allowed.count {
            messages.append("AI plan must contain no more than \(allowed.count) future sessions.")
        }
        var previousDayOffset = -1
        for (index, session) in response.sessions.enumerated() {
            if !(1...6).contains(session.dayOffset) {
                messages.append("AI session \(index + 1) must have a day offset from 1 through 6; day offset 0 is today and cannot be planned during a refresh.")
            } else if !allowed.contains(session.dayOffset) {
                messages.append("AI session \(index + 1) is scheduled on a rest day.")
            }
            if session.dayOffset <= previousDayOffset {
                messages.append("AI sessions must use strictly increasing day offsets.")
            }
            previousDayOffset = session.dayOffset
            if SessionFocus(rawValue: session.focus) == nil {
                messages.append("AI session \(index + 1) has an unknown focus.")
            }
            for exercise in session.exercises {
                if ExerciseKind(rawValue: exercise.exercise) == nil {
                    messages.append("AI session \(index + 1) has an unknown exercise.")
                }
                if exercise.sets < 1 || exercise.reps < 0 || exercise.seconds < 0 || exercise.restSeconds < 0 {
                    messages.append("AI session \(index + 1) has an invalid set, rep, hold, or rest value.")
                }
            }
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
    /// `hasSelectedDays` is true when the athlete picked running days; then
    /// an empty `allowedDayOffsets` (no running day left this week) allows
    /// no runs at all. Without a selection, any future day is fine.
    func validate(response: RunningWeekResponse, allowedDayOffsets: [Int], hasSelectedDays: Bool? = nil) -> PlanValidationResult {
        var messages: [String] = []
        let allowed = Set(allowedDayOffsets)
        let constrained = hasSelectedDays ?? !allowed.isEmpty
        var previousDayOffset = -1

        for (index, session) in response.sessions.enumerated() {
            if !(1...6).contains(session.dayOffset) {
                messages.append("AI run \(index + 1) must have a day offset from 1 through 6; day offset 0 is today and cannot be planned during a refresh.")
            }

            if constrained, (1...6).contains(session.dayOffset), !allowed.contains(session.dayOffset) {
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
    static let lastAttemptKey = "coachVerdictLastRefreshAttemptAt"
    static let retryInterval: TimeInterval = 10 * 60
}

/// The coach read is refreshed when a previous refresh failed (the retry
/// flag) or when newer training or a fresh morning snapshot exists.
func coachReadRefreshIsDue(
    retryFlag: Bool,
    latestLog: PerformanceLog?,
    latestConfirmedRun: RunLog?,
    latestSnapshot: GarminDailySnapshot?,
    latestVerdict: CoachVerdict?
) -> Bool {
    retryFlag || coachVerdictNeedsRefresh(
        latestLog: latestLog,
        latestConfirmedRun: latestConfirmedRun,
        latestSnapshot: latestSnapshot,
        latestVerdict: latestVerdict
    )
}

/// The newest plan the coach generated. Rule records (old deload markers)
/// are not plans.
func latestAIPlan(from plans: [CoachPlan]) -> CoachPlan? {
    plans
        .filter { $0.sourceRaw == PlanSource.ai.rawValue }
        .max { $0.generatedAt < $1.generatedAt }
}

/// Background Garmin pulls run at most every 30 minutes after a success and
/// back off 10 minutes after a failed attempt (logged out, sidecar down).
func shouldAttemptGarminSync(now: Date, lastSuccessAt: Double, lastAttemptAt: Double) -> Bool {
    let t = now.timeIntervalSince1970
    return t - lastSuccessAt > 30 * 60 && t - lastAttemptAt > 10 * 60
}

/// A training-day, running-day or long-run-day change asks for one forced
/// replan, sent when the athlete leaves Profile (or on the next app open).
enum PlanRefreshRequest {
    static let key = "planRefreshAfterScheduleChange"

    static func mark(defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: key)
    }

    static func consume(defaults: UserDefaults = .standard) -> Bool {
        guard defaults.bool(forKey: key) else { return false }
        defaults.set(false, forKey: key)
        return true
    }

    /// Ask again when the replan never reached the proxy (offline, busy).
    /// A proxy answer, even a failure, ends it: no forced-replan loop.
    static func shouldRetry(after outcome: AutoPlanTriggerOutcome) -> Bool {
        !outcome.appliedNewPlan && !outcome.reachedProxy
    }
}

/// Builds the coach request from a fresh fetch, never from view @Query
/// arrays that an awaited replan may have changed or deleted underneath.
@MainActor
func makeCoachRequestFromStore(profile: UserProfile, modelID: String, in modelContext: ModelContext) throws -> CoachPlanRequest {
    makeCoachRequest(
        profile: profile,
        modelID: modelID,
        logs: try modelContext.fetch(FetchDescriptor<PerformanceLog>(sortBy: [SortDescriptor(\.completedAt, order: .reverse)])),
        sessions: try modelContext.fetch(FetchDescriptor<WorkoutSession>(sortBy: [SortDescriptor(\.scheduledDate)])),
        prescriptions: try modelContext.fetch(FetchDescriptor<SetPrescription>(sortBy: [SortDescriptor(\.orderIndex)])),
        raceGoal: try modelContext.fetch(FetchDescriptor<RaceGoal>(sortBy: [SortDescriptor(\.createdAt)])).first,
        runLogs: try modelContext.fetch(FetchDescriptor<RunLog>(sortBy: [SortDescriptor(\.completedAt, order: .reverse)])),
        weekStart: rollingPlanStart()
    )
}

/// The one way the app refreshes the coach read. Clears the retry flag on
/// success and keeps it set on failure, so the next app open retries.
@MainActor
enum CoachReadRefresher {
    @discardableResult
    static func refresh(
        endpoint: String,
        profile: UserProfile,
        modelID: String,
        sourceLogId: UUID? = nil,
        in modelContext: ModelContext
    ) async -> Bool {
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: CoachVerdictRefreshFlag.lastAttemptKey)
        do {
            let request = try makeCoachRequestFromStore(profile: profile, modelID: modelID, in: modelContext)
            let response = try await LocalCoachClient(endpointString: endpoint).generateVerdict(request: request)
            modelContext.insert(CoachVerdict(response: response, sourceLogId: sourceLogId))
            try modelContext.save()
            UserDefaults.standard.set(false, forKey: CoachVerdictRefreshFlag.needsRefreshKey)
            return true
        } catch {
            UserDefaults.standard.set(true, forKey: CoachVerdictRefreshFlag.needsRefreshKey)
            return false
        }
    }

    /// Refreshes on app open when due, at most every 10 minutes.
    static func refreshIfDue(endpoint: String, profile: UserProfile, modelID: String, in modelContext: ModelContext) async {
        let lastAttempt = UserDefaults.standard.double(forKey: CoachVerdictRefreshFlag.lastAttemptKey)
        guard Date().timeIntervalSince1970 - lastAttempt > CoachVerdictRefreshFlag.retryInterval else { return }
        let latestLog = try? modelContext.fetch(FetchDescriptor<PerformanceLog>(sortBy: [SortDescriptor(\.completedAt, order: .reverse)])).first
        let latestRun = confirmedRunLogs(from: (try? modelContext.fetch(FetchDescriptor<RunLog>())) ?? []).last
        let latestSnapshot = try? modelContext.fetch(FetchDescriptor<GarminDailySnapshot>(sortBy: [SortDescriptor(\.date, order: .reverse)])).first
        let latestVerdict = try? modelContext.fetch(FetchDescriptor<CoachVerdict>(sortBy: [SortDescriptor(\.createdAt, order: .reverse)])).first
        guard coachReadRefreshIsDue(
            retryFlag: UserDefaults.standard.bool(forKey: CoachVerdictRefreshFlag.needsRefreshKey),
            latestLog: latestLog,
            latestConfirmedRun: latestRun,
            latestSnapshot: latestSnapshot,
            latestVerdict: latestVerdict
        ) else { return }
        await refresh(endpoint: endpoint, profile: profile, modelID: modelID, in: modelContext)
    }
}

func makeCoachRequest(
    profile: UserProfile,
    modelID: String,
    logs: [PerformanceLog],
    sessions: [WorkoutSession],
    prescriptions: [SetPrescription] = [],
    raceGoal: RaceGoal? = nil,
    runLogs: [RunLog] = [],
    weekStart: Date = rollingPlanStart(),
    timeZone: TimeZone = .current
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
    let recentRunLogs = Array(confirmedRunLogs(from: runLogs).suffix(30))
    let plannedRunKinds = Dictionary(
        sessions
            .filter { $0.discipline == .running && !$0.runKindRaw.isEmpty }
            .map { ($0.id, $0.runKindRaw) },
        uniquingKeysWith: { first, _ in first }
    )
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
            recentRuns: recentRunLogs
                .map {
                    CoachRunSummary(
                        completedAt: $0.completedAt,
                        distanceKm: $0.distanceKm,
                        movingSeconds: $0.movingSeconds,
                        elevationGainM: $0.elevationGainM,
                        elevationLossM: $0.elevationLossM > 0 ? $0.elevationLossM : nil,
                        averageHr: $0.averageHr > 0 ? $0.averageHr : nil,
                        rpe: $0.rpe > 0 ? $0.rpe : nil,
                        feelScore: $0.feelScore > 0 ? $0.feelScore : nil,
                        kind: coachRunKind(for: $0, plannedKindsBySessionId: plannedRunKinds, peers: recentRunLogs)
                    )
                }
        )
    }

    return CoachPlanRequest(
        userId: profile.id.uuidString,
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
        profileNotes: coachProfileNotes(for: profile),
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
        planBlockStartedAt: Calendar.current.startOfDay(for: profile.planBlockStartedAt),
        running: running,
        timeZone: timeZone.identifier
    )
}

/// The athlete's notes for the coach: pain notes, plus the session length
/// cap when one is set. The request has no field for it; the planner reads
/// these notes.
func coachProfileNotes(for profile: UserProfile) -> String {
    guard profile.sessionMinutes > 0 else { return profile.painNotes }
    let cap = "Keep each strength session within \(profile.sessionMinutes) minutes."
    let notes = profile.painNotes.trimmingCharacters(in: .whitespacesAndNewlines)
    return notes.isEmpty ? cap : "\(notes) \(cap)"
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
    static let hostedEndpointString = "https://lockin.elevenfactor.com/generate-week-plan"
    private static let bundledProxyEndpointKey = "CoachProxyEndpoint"
    // The endpoint is configuration, not app state: it is never stored on the
    // device and never shown or editable in the app. Debug Simulator builds
    // talk to the proxy on the developer's machine. A Debug build installed on
    // a physical iPhone can embed COACH_PROXY_ENDPOINT at build time to point
    // to a Mac LAN IP. Release builds (TestFlight, App Store) compile the
    // local path out entirely and stay pinned to the hosted proxy.
    #if DEBUG
    static let defaultEndpointString = resolvedDevelopmentEndpoint()
    static let allowsLocalEndpointsByDefault = true

    static func resolvedDevelopmentEndpoint(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        isSimulator: Bool = isRunningInSimulator,
        bundledEndpoint: String? = Bundle.main.object(forInfoDictionaryKey: bundledProxyEndpointKey) as? String
    ) -> String {
        if let override = validatedDevelopmentEndpoint(environment["COACH_PROXY_ENDPOINT"], isSimulator: isSimulator) {
            return override
        }
        if let bundledEndpoint = validatedDevelopmentEndpoint(bundledEndpoint, isSimulator: isSimulator) {
            return bundledEndpoint
        }
        return isSimulator ? "http://127.0.0.1:8787/generate-week-plan" : hostedEndpointString
    }
    #else
    static let defaultEndpointString = hostedEndpointString
    static let allowsLocalEndpointsByDefault = false
    #endif
    private static let hostedProxyHost = "lockin.elevenfactor.com"
    #if DEBUG
    private static var isRunningInSimulator: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }
    #endif

    var endpoint: URL
    var session: URLSession = .shared
    var validator = CoachPlanValidator()
    var runningValidator = RunningWeekValidator()
    /// Sent as `X-Lockin-App-Token` when set. The proxy requires it once
    /// LOCKIN_APP_TOKEN is configured there; it comes from the
    /// COACH_PROXY_APP_TOKEN build setting (Debug: also the scheme env var).
    var appToken: String? = Self.configuredAppToken

    static let configuredAppToken: String? = {
        #if DEBUG
        if let override = ProcessInfo.processInfo.environment["COACH_PROXY_APP_TOKEN"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !override.isEmpty {
            return override
        }
        #endif
        let bundled = (Bundle.main.object(forInfoDictionaryKey: "CoachProxyAppToken") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return bundled.isEmpty || bundled.hasPrefix("$(") ? nil : bundled
    }()

    func authorized(_ request: URLRequest) -> URLRequest {
        guard let appToken, !appToken.isEmpty else { return request }
        var request = request
        request.setValue(appToken, forHTTPHeaderField: "X-Lockin-App-Token")
        return request
    }

    init(endpointString: String = defaultEndpointString, allowsLocalEndpoints: Bool = allowsLocalEndpointsByDefault) throws {
        guard let endpoint = Self.normalizedEndpoint(from: endpointString, allowsLocalEndpoints: allowsLocalEndpoints) else { throw CoachClientError.invalidURL }
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
            (data, response) = try await session.data(for: authorized(urlRequest))
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
            (data, response) = try await session.data(for: authorized(urlRequest))
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
            (data, response) = try await session.data(for: authorized(urlRequest))
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

    func sendCoachChat(_ request: CoachChatRequest) async throws -> CoachChatResponse {
        guard let chatEndpoint = Self.chatEndpoint(from: endpoint) else { throw CoachClientError.invalidURL }
        var urlRequest = URLRequest(url: chatEndpoint)
        urlRequest.httpMethod = "POST"
        // The proxy gives the coach model 45 s before it falls back to a
        // quick answer; leave room for that answer to arrive.
        urlRequest.timeoutInterval = 60
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONEncoder.coachEncoder.encode(request)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: authorized(urlRequest))
        } catch let error as URLError {
            if error.isLocalProxyConnectionFailure {
                throw CoachClientError.proxyUnavailable(chatEndpoint, error)
            }
            throw CoachClientError.transportFailed(chatEndpoint, error)
        }

        guard let http = response as? HTTPURLResponse else { throw CoachClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 404 {
                throw CoachClientError.missingCoachChatRoute(chatEndpoint)
            }
            throw CoachClientError.invalidStatus(http.statusCode, proxyErrorMessage(from: data))
        }

        return try JSONDecoder.coachDecoder.decode(CoachChatResponse.self, from: data)
    }

    func fetchProxyHealth() async throws -> CoachProxyHealthResponse {
        guard let healthEndpoint = Self.healthEndpoint(from: endpoint) else { throw CoachClientError.invalidURL }
        let urlRequest = URLRequest(url: healthEndpoint)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: authorized(urlRequest))
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
            (data, response) = try await session.data(for: authorized(urlRequest))
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

    func fetchAutoPlanStatus(userId: String) async throws -> AutoPlanStatusResponse {
        guard let statusEndpoint = Self.autoPlanStatusEndpoint(from: endpoint, userId: userId) else { throw CoachClientError.invalidURL }
        var urlRequest = URLRequest(url: statusEndpoint)
        urlRequest.timeoutInterval = 15

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: authorized(urlRequest))
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

        return try JSONDecoder.coachDecoder.decode(AutoPlanStatusResponse.self, from: data)
    }

    func triggerAutoPlan(_ request: AutoPlanTriggerRequest) async throws -> AutoPlanTriggerResponse {
        guard let triggerEndpoint = Self.autoPlanTriggerEndpoint(from: endpoint) else { throw CoachClientError.invalidURL }
        var urlRequest = URLRequest(url: triggerEndpoint)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = request.force ? 300 : 240
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONEncoder.coachEncoder.encode(request)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: authorized(urlRequest))
        } catch let error as URLError {
            if error.isLocalProxyConnectionFailure {
                throw CoachClientError.proxyUnavailable(triggerEndpoint, error)
            }
            throw CoachClientError.transportFailed(triggerEndpoint, error)
        }

        guard let http = response as? HTTPURLResponse else { throw CoachClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CoachClientError.invalidStatus(http.statusCode, proxyErrorMessage(from: data))
        }

        return try JSONDecoder.coachDecoder.decode(AutoPlanTriggerResponse.self, from: data)
    }

    func fetchGarminStatus(userId: String? = nil) async throws -> GarminStatusResponse {
        guard let statusEndpoint = Self.garminStatusEndpoint(from: endpoint, userId: userId) else { throw CoachClientError.invalidURL }
        var urlRequest = URLRequest(url: statusEndpoint)
        urlRequest.timeoutInterval = 15

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: authorized(urlRequest))
        } catch let error as URLError {
            if error.isLocalProxyConnectionFailure {
                throw CoachClientError.proxyUnavailable(statusEndpoint, error)
            }
            throw CoachClientError.transportFailed(statusEndpoint, error)
        }

        guard let http = response as? HTTPURLResponse else { throw CoachClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw proxyStatusError(http, data: data, endpoint: statusEndpoint, isGarminRoute: true)
        }

        return try JSONDecoder.coachDecoder.decode(GarminStatusResponse.self, from: data)
    }

    func connectGarmin(_ request: GarminConnectRequest) async throws -> GarminStatusResponse {
        guard let connectEndpoint = Self.garminConnectEndpoint(from: endpoint) else { throw CoachClientError.invalidURL }
        var urlRequest = URLRequest(url: connectEndpoint)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 75
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONEncoder.coachEncoder.encode(request)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: authorized(urlRequest))
        } catch let error as URLError {
            if error.isLocalProxyConnectionFailure {
                throw CoachClientError.proxyUnavailable(connectEndpoint, error)
            }
            throw CoachClientError.transportFailed(connectEndpoint, error)
        }

        guard let http = response as? HTTPURLResponse else { throw CoachClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw proxyStatusError(http, data: data, endpoint: connectEndpoint, isGarminRoute: true)
        }

        return try JSONDecoder.coachDecoder.decode(GarminStatusResponse.self, from: data)
    }

    func disconnectGarmin(userId: String) async throws -> GarminStatusResponse {
        guard let disconnectEndpoint = Self.garminDisconnectEndpoint(from: endpoint) else { throw CoachClientError.invalidURL }
        var urlRequest = URLRequest(url: disconnectEndpoint)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 30
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONEncoder.coachEncoder.encode(GarminDisconnectRequest(userId: userId))

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: authorized(urlRequest))
        } catch let error as URLError {
            if error.isLocalProxyConnectionFailure {
                throw CoachClientError.proxyUnavailable(disconnectEndpoint, error)
            }
            throw CoachClientError.transportFailed(disconnectEndpoint, error)
        }

        guard let http = response as? HTTPURLResponse else { throw CoachClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw proxyStatusError(http, data: data, endpoint: disconnectEndpoint, isGarminRoute: true)
        }

        return try JSONDecoder.coachDecoder.decode(GarminStatusResponse.self, from: data)
    }

    func fetchGarminSnapshot(sinceDays: Int = 7, userId: String? = nil) async throws -> GarminSnapshotResponse {
        guard let snapshotEndpoint = Self.garminSnapshotEndpoint(from: endpoint, sinceDays: sinceDays, userId: userId) else {
            throw CoachClientError.invalidURL
        }
        var urlRequest = URLRequest(url: snapshotEndpoint)
        // The proxy route budget is 120s (a cold sidecar cache serializes ~29
        // upstream Garmin calls), so leave headroom on top of that.
        urlRequest.timeoutInterval = 150

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: authorized(urlRequest))
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

    func fetchGarminSyncStatus(userId: String) async throws -> GarminSyncPlanResponse {
        guard let syncStatusEndpoint = Self.garminSyncStatusEndpoint(from: endpoint, userId: userId) else { throw CoachClientError.invalidURL }
        var urlRequest = URLRequest(url: syncStatusEndpoint)
        urlRequest.timeoutInterval = 15

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: authorized(urlRequest))
        } catch let error as URLError {
            if error.isLocalProxyConnectionFailure {
                throw CoachClientError.proxyUnavailable(syncStatusEndpoint, error)
            }
            throw CoachClientError.transportFailed(syncStatusEndpoint, error)
        }

        guard let http = response as? HTTPURLResponse else { throw CoachClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CoachClientError.invalidStatus(http.statusCode, proxyErrorMessage(from: data))
        }

        return try JSONDecoder.coachDecoder.decode(GarminSyncPlanResponse.self, from: data)
    }

    func syncGarminPlan(_ request: GarminSyncPlanRequest) async throws -> GarminSyncPlanResponse {
        guard let syncEndpoint = Self.garminSyncPlanEndpoint(from: endpoint) else { throw CoachClientError.invalidURL }
        var urlRequest = URLRequest(url: syncEndpoint)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 120
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONEncoder.coachEncoder.encode(request)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: authorized(urlRequest))
        } catch let error as URLError {
            if error.isLocalProxyConnectionFailure {
                throw CoachClientError.proxyUnavailable(syncEndpoint, error)
            }
            throw CoachClientError.transportFailed(syncEndpoint, error)
        }

        guard let http = response as? HTTPURLResponse else { throw CoachClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CoachClientError.invalidStatus(http.statusCode, proxyErrorMessage(from: data))
        }

        return try JSONDecoder.coachDecoder.decode(GarminSyncPlanResponse.self, from: data)
    }

    func retryGarminSync(userId: String) async throws -> GarminSyncPlanResponse {
        guard let retryEndpoint = Self.garminRetrySyncEndpoint(from: endpoint) else { throw CoachClientError.invalidURL }
        var urlRequest = URLRequest(url: retryEndpoint)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 120
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONEncoder.coachEncoder.encode(GarminRetrySyncRequest(userId: userId))

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: authorized(urlRequest))
        } catch let error as URLError {
            if error.isLocalProxyConnectionFailure {
                throw CoachClientError.proxyUnavailable(retryEndpoint, error)
            }
            throw CoachClientError.transportFailed(retryEndpoint, error)
        }

        guard let http = response as? HTTPURLResponse else { throw CoachClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CoachClientError.invalidStatus(http.statusCode, proxyErrorMessage(from: data))
        }

        return try JSONDecoder.coachDecoder.decode(GarminSyncPlanResponse.self, from: data)
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
            (data, response) = try await session.data(for: authorized(urlRequest))
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
            (data, response) = try await session.data(for: authorized(urlRequest))
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

    private static func normalizedEndpoint(from value: String, allowsLocalEndpoints: Bool) -> URL? {
        var rawValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawValue.isEmpty else { return nil }
        let hadScheme = rawValue.contains("://")
        if !hadScheme {
            rawValue = "https://\(rawValue)"
        }
        guard var components = URLComponents(string: rawValue) else { return nil }
        let scheme = components.scheme?.lowercased()
        let host = components.host?.lowercased() ?? ""

        if host == hostedProxyHost {
            guard scheme == "https" else { return nil }
            components.scheme = "https"
            components.host = hostedProxyHost
        } else if allowsLocalEndpoints, scheme == "http" || scheme == "https", isPrivateDevelopmentHost(host) {
            // Debug-only: a proxy on the developer's own machine (simulator) or LAN (device).
            // A bare "192.168.x.x:8787" gets http, since local dev servers don't serve TLS.
            if !hadScheme {
                components.scheme = "http"
            }
        } else {
            return nil
        }

        if components.path.isEmpty || components.path == "/" {
            components.path = "/generate-week-plan"
        }
        return components.url
    }

    static func isPrivateDevelopmentHost(_ host: String) -> Bool {
        if host == "localhost" || host == "127.0.0.1" || host == "::1" { return true }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else { return false }
        if octets[0] == 10 { return true }
        if octets[0] == 192, octets[1] == 168 { return true }
        if octets[0] == 172, (16...31).contains(octets[1]) { return true }
        return false
    }

    private static func isLoopbackEndpoint(_ value: String) -> Bool {
        var rawValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !rawValue.contains("://") {
            rawValue = "http://\(rawValue)"
        }
        guard let host = URLComponents(string: rawValue)?.host?.lowercased() else { return false }
        return host == "localhost" || host == "127.0.0.1" || host == "::1"
    }

    private static func validatedDevelopmentEndpoint(_ value: String?, isSimulator: Bool) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains("$(") else { return nil }
        if !isSimulator, isLoopbackEndpoint(trimmed) {
            return nil
        }
        return trimmed
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

    private static func chatEndpoint(from endpoint: URL) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/coach-chat"
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

    private static func autoPlanStatusEndpoint(from endpoint: URL, userId: String) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/plan/status"
        components.queryItems = [URLQueryItem(name: "userId", value: userId)]
        return components.url
    }

    private static func autoPlanTriggerEndpoint(from endpoint: URL) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/plan/trigger"
        components.query = nil
        return components.url
    }

    private static func garminStatusEndpoint(from endpoint: URL, userId: String?) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/garmin/status"
        components.queryItems = garminUserQueryItems(userId: userId)
        return components.url
    }

    private static func garminConnectEndpoint(from endpoint: URL) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/garmin/connect"
        components.query = nil
        return components.url
    }

    private static func garminDisconnectEndpoint(from endpoint: URL) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/garmin/disconnect"
        components.query = nil
        return components.url
    }

    private static func garminSnapshotEndpoint(from endpoint: URL, sinceDays: Int, userId: String?) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/garmin/snapshot"
        components.queryItems = [URLQueryItem(name: "sinceDays", value: "\(sinceDays)")] + garminUserQueryItems(userId: userId)
        return components.url
    }

    private static func garminSyncStatusEndpoint(from endpoint: URL, userId: String) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/garmin/sync-status"
        components.queryItems = [URLQueryItem(name: "userId", value: userId)]
        return components.url
    }

    private static func garminSyncPlanEndpoint(from endpoint: URL) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/garmin/sync-plan"
        components.query = nil
        return components.url
    }

    private static func garminRetrySyncEndpoint(from endpoint: URL) -> URL? {
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/garmin/retry-sync"
        components.query = nil
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

    private static func garminUserQueryItems(userId: String?) -> [URLQueryItem] {
        let trimmed = userId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? [] : [URLQueryItem(name: "userId", value: trimmed)]
    }

    private func proxyStatusError(_ response: HTTPURLResponse, data: Data, endpoint: URL, isGarminRoute: Bool = false) -> CoachClientError {
        if isGarminRoute, response.statusCode == 404 {
            return .missingGarminRoute(endpoint)
        }
        return .invalidStatus(response.statusCode, proxyErrorMessage(from: data))
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
        // Not `.iso8601`: on iOS 17 it rejects fractional seconds, and the
        // proxy's dates come from JavaScript's toISOString() ("...:00.123Z").
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            guard let date = parseCoachDate(value) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Expected an ISO-8601 date, got \(value)"
                )
            }
            return date
        }
        return decoder
    }
}

/// An ISO-8601 instant with or without fractional seconds.
func parseCoachDate(_ value: String) -> Date? {
    let plain = ISO8601DateFormatter()
    if let date = plain.date(from: value) { return date }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: value)
}
