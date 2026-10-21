import Foundation
import SwiftData

func currentWeekStart(date: Date = Date(), calendar: Calendar = .current) -> Date {
    calendar.startOfDay(for: calendar.dateInterval(of: .weekOfYear, for: date)?.start ?? date)
}

func rollingPlanStart(date: Date = Date(), calendar: Calendar = .current) -> Date {
    calendar.startOfDay(for: date)
}

func rollingPlanEnd(date: Date = Date(), calendar: Calendar = .current) -> Date {
    calendar.date(byAdding: .day, value: 7, to: rollingPlanStart(date: date, calendar: calendar)) ?? rollingPlanStart(date: date, calendar: calendar)
}

func duePlannedSessions(from sessions: [WorkoutSession], now: Date = Date(), calendar: Calendar = .current) -> [WorkoutSession] {
    let startOfToday = calendar.startOfDay(for: now)
    let endOfToday = calendar.dateInterval(of: .day, for: now)?.end ?? now
    return sessions
        .filter { $0.status == .planned && $0.scheduledDate >= startOfToday && $0.scheduledDate < endOfToday }
        .sorted { lhs, rhs in
            if lhs.isRun != rhs.isRun {
                return lhs.isRun
            }
            if lhs.scheduledDate != rhs.scheduledDate {
                return lhs.scheduledDate < rhs.scheduledDate
            }
            return lhs.title < rhs.title
        }
}

struct TrainingStreakSnapshot: Equatable {
    var current: Int
    var best: Int
}

/// Display streaks as training days, not scored sessions. Multiple completed
/// sessions on the same calendar day count once; any missed training day resets
/// the run. Rest days do not break the streak because they were never planned.
func trainingStreakSnapshot(
    from sessions: [WorkoutSession],
    now: Date = Date(),
    calendar: Calendar = .current
) -> TrainingStreakSnapshot {
    let today = calendar.startOfDay(for: now)
    let history = sessions
        .filter { $0.scheduledDate <= now || calendar.startOfDay(for: $0.scheduledDate) <= today }
        .reduce(into: [Date: (trained: Bool, missed: Bool)]()) { result, session in
            let day = calendar.startOfDay(for: session.scheduledDate)
            var state = result[day] ?? (trained: false, missed: false)
            switch session.status {
            case .completed, .deload:
                state.trained = true
            case .missed:
                state.missed = true
            case .planned, .partial:
                break
            }
            result[day] = state
        }
        .sorted { $0.key < $1.key }

    var current = 0
    var best = 0
    for (_, state) in history {
        if state.missed {
            current = 0
        }
        if state.trained {
            current += 1
            best = max(best, current)
        }
    }
    return TrainingStreakSnapshot(current: current, best: best)
}

/// Planned sessions that should be marked missed. Strength sessions are
/// overdue as soon as their scheduled day has passed. Running sessions get
/// one grace day so an evening run can still arrive via the overnight Garmin
/// sync before the session counts as missed. A real Garmin RunLog on the
/// session's scheduled calendar day keeps it out of the missed sweep because
/// Garmin has already provided activity data for that workout.
func overduePlannedSessions(
    from sessions: [WorkoutSession],
    runLogs: [RunLog],
    now: Date = Date(),
    calendar: Calendar = .current
) -> [WorkoutSession] {
    let startOfToday = calendar.startOfDay(for: now)
    let runningGraceCutoff = calendar.date(byAdding: .day, value: -1, to: startOfToday) ?? startOfToday
    let garminLogsBySessionId = Dictionary(
        grouping: runLogs.filter { $0.source == .garmin && !isReplaceablePreviewRunLog($0) },
        by: \.sessionId
    )
    return sessions
        .filter { session in
            guard session.status == .planned else { return false }
            if session.discipline == .running {
                let hasSameDayGarminLog = (garminLogsBySessionId[session.id] ?? []).contains {
                    calendar.isDate($0.completedAt, inSameDayAs: session.scheduledDate)
                }
                guard !hasSameDayGarminLog else { return false }
                return session.scheduledDate < runningGraceCutoff
            }
            return session.scheduledDate < startOfToday
        }
        .sorted { $0.scheduledDate < $1.scheduledDate }
}

func nextFuturePlannedSession(from sessions: [WorkoutSession], now: Date = Date(), calendar: Calendar = .current) -> WorkoutSession? {
    let endOfToday = calendar.dateInterval(of: .day, for: now)?.end ?? now
    return sessions
        .filter { $0.status == .planned && $0.scheduledDate >= endOfToday }
        .sorted { $0.scheduledDate < $1.scheduledDate }
        .first
}

@discardableResult
func markOverduePlannedSessionsMissed(
    from sessions: [WorkoutSession],
    runLogs: [RunLog],
    logs: [PerformanceLog],
    profile: UserProfile,
    ranks: [RankState],
    in modelContext: ModelContext,
    now: Date = Date(),
    calendar: Calendar = .current
) throws -> Int {
    let overdueSessions = overduePlannedSessions(from: sessions, runLogs: runLogs, now: now, calendar: calendar)
    guard !overdueSessions.isEmpty else { return 0 }

    let latestLog = logs.sorted { $0.completedAt > $1.completedAt }.first
    let rank = ranks.first ?? RankState()
    if ranks.isEmpty {
        modelContext.insert(rank)
    }

    for session in overdueSessions {
        session.status = .missed
        applyScoreOutcome(missedSessionOutcome(profile: profile, latestLog: latestLog), to: rank)
    }

    try modelContext.save()
    return overdueSessions.count
}

func missedSessionOutcome(profile: UserProfile, latestLog: PerformanceLog?) -> ScoreOutcome {
    TrainingEngine().score(
        log: SessionLogInput(
            completed: false,
            pullUps: latestLog?.pullUps ?? profile.baselinePullUps,
            pushUps: latestLog?.pushUps ?? profile.baselinePushUps,
            plankSeconds: latestLog?.plankSeconds ?? profile.baselinePlankSeconds,
            rpe: 1,
            painLevel: 0,
            fatigueLevel: 1
        ),
        plannedSession: nil
    )
}

private let garminFullRunCompletionRatio = 0.80
private let garminPartialRunCompletionRatio = 0.30

func garminRunCompletionRatio(plannedDistanceKm: Double, actualDistanceKm: Double) -> Double? {
    guard plannedDistanceKm > 0, actualDistanceKm > 0 else { return nil }
    return actualDistanceKm / plannedDistanceKm
}

func garminRunCompletionStatus(for session: WorkoutSession, actualDistanceKm: Double) -> SessionStatus? {
    guard session.isRun else { return nil }
    guard session.plannedDistanceKm > 0 else { return actualDistanceKm > 0 ? .completed : nil }
    guard let ratio = garminRunCompletionRatio(plannedDistanceKm: session.plannedDistanceKm, actualDistanceKm: actualDistanceKm) else {
        return nil
    }
    if ratio >= garminFullRunCompletionRatio { return .completed }
    if ratio >= garminPartialRunCompletionRatio { return .partial }
    return nil
}

func partialRunOutcome(completionRatio: Double?) -> ScoreOutcome {
    let consistency = (completionRatio ?? 0) >= 0.50 ? 6 : 4
    let percent = completionRatio.map { "\(Int(($0 * 100).rounded()))%" } ?? "part"
    return ScoreOutcome(
        consistencyDelta: consistency,
        penaltyDelta: 0,
        streakDelta: 0,
        didTriggerDeload: false,
        reason: "Garmin run covered \(percent) of the planned distance. Partial credit kept without a missed-run penalty."
    )
}

/// Garmin owns run completion. This marks the matched planned/missed session
/// completed or partial immediately when the activity arrives.
@discardableResult
func completeRunFromGarmin(
    session: WorkoutSession,
    log: RunLog,
    ranks: [RankState],
    in modelContext: ModelContext
) throws -> SessionStatus? {
    guard let completionStatus = garminRunCompletionStatus(for: session, actualDistanceKm: log.distanceKm) else {
        log.sessionId = RunLog.unattachedSessionId
        log.needsConfirmation = false
        return nil
    }

    log.needsConfirmation = false
    let previousStatus = session.status
    let shouldApplyScore = previousStatus == .planned || previousStatus == .missed || session.scoreImpact == 0
    if !shouldApplyScore {
        // Already scored (for example from a manual log). Keep a deload the
        // athlete reported; otherwise Garmin decides completed vs partial.
        guard previousStatus != .deload else { return session.status }
        if previousStatus == .partial, completionStatus == .completed {
            // Garmin shows the "partial" run was a full one: add the missing
            // credit and the streak day the partial didn't give.
            let full = TrainingEngine().score(
                log: SessionLogInput(
                    completed: true,
                    pullUps: 0,
                    pushUps: 0,
                    plankSeconds: 0,
                    loggedPullUps: false,
                    loggedPushUps: false,
                    loggedPlankSeconds: false,
                    rpe: log.rpe,
                    painLevel: 0,
                    fatigueLevel: ReadinessScale.fatigueLevel(fromHowFelt: log.feelScore)
                ),
                plannedSession: nil
            )
            let rank = ranks.first ?? RankState()
            if ranks.isEmpty { modelContext.insert(rank) }
            applyScoreOutcome(
                ScoreOutcome(
                    consistencyDelta: full.consistencyDelta - session.scoreImpact,
                    penaltyDelta: 0,
                    streakDelta: full.streakDelta,
                    didTriggerDeload: false,
                    reason: full.reason
                ),
                to: rank
            )
            session.scoreImpact = full.consistencyDelta
        }
        session.status = completionStatus
        return session.status
    }

    let rank = ranks.first ?? RankState()
    if ranks.isEmpty { modelContext.insert(rank) }

    if previousStatus == .missed {
        refundMissedSessionPenalty(on: rank)
    }

    session.status = completionStatus

    let outcome: ScoreOutcome
    if completionStatus == .completed {
        outcome = TrainingEngine().score(
            log: SessionLogInput(
                completed: true,
                pullUps: 0,
                pushUps: 0,
                plankSeconds: 0,
                loggedPullUps: false,
                loggedPushUps: false,
                loggedPlankSeconds: false,
                rpe: 0,
                painLevel: 0,
                fatigueLevel: ReadinessScale.fatigueLevel(fromHowFelt: 3)
            ),
            plannedSession: nil
        )
    } else {
        outcome = partialRunOutcome(
            completionRatio: garminRunCompletionRatio(plannedDistanceKm: session.plannedDistanceKm, actualDistanceKm: log.distanceKm)
        )
    }
    applyScoreOutcome(outcome, to: rank)
    session.scoreImpact = outcome.consistencyDelta

    // A Garmin-matched run is new training data — the coach read must catch up.
    UserDefaults.standard.set(true, forKey: CoachVerdictRefreshFlag.needsRefreshKey)
    return completionStatus
}

/// Undoes a miss that turned out to be trained after all (late Garmin sync,
/// late manual log). missedSessionConsistencyDelta is negative, so
/// subtracting it restores the lost consistency points. The display streak
/// is recomputed from session statuses, so it heals on its own.
func refundMissedSessionPenalty(on rank: RankState) {
    rank.penaltyPoints = max(0, rank.penaltyPoints - TrainingEngine.missedSessionPenaltyPoints)
    rank.consistencyScore = max(0, rank.consistencyScore - TrainingEngine.missedSessionConsistencyDelta)
}

enum SessionLoggingError: LocalizedError, Equatable {
    case alreadyLogged
    case notLoggable

    var errorDescription: String? {
        switch self {
        case .alreadyLogged: "This session is already logged."
        case .notLoggable: "This session can't be logged anymore."
        }
    }
}

/// What the athlete entered on the strength log sheet. Metrics that were not
/// part of the session carry the latest known value with `logged…` false.
struct StrengthLogEntry: Equatable {
    var pullUps: Int
    var pushUps: Int
    var plankSeconds: Int
    var loggedPullUps: Bool
    var loggedPushUps: Bool
    var loggedPlankSeconds: Bool
    var rpe: Int
    var painLevel: Int
    var howFelt: Int
    var notes: String
}

/// The actual RPE slider starts at the planned RPE so an untouched slider
/// never reads as "harder than planned".
func initialLoggedRPE(for session: WorkoutSession) -> Int {
    if (1...10).contains(session.plannedEffortTargetRPE) {
        return session.plannedEffortTargetRPE
    }
    if let label = session.plannedEffortLabel {
        return label.defaultTargetRPE
    }
    if session.isRun {
        return session.runKind?.isHard == true ? 7 : 4
    }
    return 7
}

/// Saves a strength log: the log row, the session status, and the score.
/// A session that the missed sweep already closed can still be logged (the
/// miss is refunded); a session that already has a log cannot be logged
/// again. Rolls back and rethrows when the save fails, so nothing half-saved
/// lingers in the context.
@discardableResult
func recordStrengthLog(
    _ entry: StrengthLogEntry,
    for session: WorkoutSession,
    in modelContext: ModelContext,
    now: Date = Date()
) throws -> (log: PerformanceLog, outcome: ScoreOutcome) {
    guard session.status == .planned || session.status == .missed else { throw SessionLoggingError.alreadyLogged }
    let sessionId = session.id
    let existingLogs = try modelContext.fetch(FetchDescriptor<PerformanceLog>(predicate: #Predicate { $0.sessionId == sessionId }))
    guard existingLogs.isEmpty else { throw SessionLoggingError.alreadyLogged }

    do {
        let plannedRPE: Int
        if (1...10).contains(session.plannedEffortTargetRPE) {
            plannedRPE = session.plannedEffortTargetRPE
        } else {
            plannedRPE = session.plannedEffortLabel?.defaultTargetRPE ?? 0
        }
        let fatigueLevel = ReadinessScale.fatigueLevel(fromHowFelt: entry.howFelt)
        let log = PerformanceLog(
            sessionId: session.id,
            completedAt: now,
            pullUps: entry.pullUps,
            pushUps: entry.pushUps,
            plankSeconds: entry.plankSeconds,
            loggedPullUps: entry.loggedPullUps,
            loggedPushUps: entry.loggedPushUps,
            loggedPlankSeconds: entry.loggedPlankSeconds,
            rpe: entry.rpe,
            plannedRPE: plannedRPE,
            plannedEffortLabelAtLog: session.plannedEffortLabel,
            plannedEffortReasonAtLog: session.plannedEffortReason,
            painLevel: entry.painLevel,
            fatigueLevel: fatigueLevel,
            notes: entry.notes
        )
        modelContext.insert(log)

        let rank = try modelContext.fetch(FetchDescriptor<RankState>()).first ?? {
            let rank = RankState()
            modelContext.insert(rank)
            return rank
        }()
        if session.status == .missed {
            refundMissedSessionPenalty(on: rank)
        }

        let outcome = TrainingEngine().score(
            log: SessionLogInput(
                completed: true,
                pullUps: entry.pullUps,
                pushUps: entry.pushUps,
                plankSeconds: entry.plankSeconds,
                loggedPullUps: entry.loggedPullUps,
                loggedPushUps: entry.loggedPushUps,
                loggedPlankSeconds: entry.loggedPlankSeconds,
                rpe: entry.rpe,
                painLevel: entry.painLevel,
                fatigueLevel: fatigueLevel
            ),
            plannedSession: nil
        )
        session.status = outcome.didTriggerDeload ? .deload : .completed
        applyScoreOutcome(outcome, to: rank)
        session.scoreImpact = outcome.consistencyDelta
        try modelContext.save()
        UserDefaults.standard.set(true, forKey: CoachVerdictRefreshFlag.needsRefreshKey)
        return (log, outcome)
    } catch {
        modelContext.rollback()
        throw error
    }
}

/// What the athlete entered on the run log sheet. Distance and time are
/// optional (0 = not entered).
struct RunLogEntry: Equatable {
    var distanceKm: Double
    var movingSeconds: Int
    var rpe: Int
    var howFelt: Int
    var notes: String
}

/// Completes a planned (or just-missed) run without Garmin. The run counts
/// like a Garmin completion: completed at 80% of the planned distance or
/// more, partial below that, and a "very weak" feel turns it into a deload.
/// A later Garmin activity on the same day replaces this manual row and
/// keeps the athlete's RPE and feel.
@discardableResult
func recordManualRun(
    _ entry: RunLogEntry,
    for session: WorkoutSession,
    in modelContext: ModelContext,
    now: Date = Date(),
    calendar: Calendar = .current
) throws -> SessionStatus {
    guard session.isRun else { throw SessionLoggingError.notLoggable }
    guard session.status == .planned || session.status == .missed else { throw SessionLoggingError.alreadyLogged }
    let sessionId = session.id
    let existingLogs = try modelContext.fetch(FetchDescriptor<RunLog>(predicate: #Predicate { $0.sessionId == sessionId }))
    guard existingLogs.isEmpty else { throw SessionLoggingError.alreadyLogged }

    do {
        let distanceKm = max(0, entry.distanceKm)
        let movingSeconds = max(0, entry.movingSeconds)
        let completedAt = calendar.isDate(now, inSameDayAs: session.scheduledDate)
            ? now
            : calendar.date(byAdding: .hour, value: 12, to: calendar.startOfDay(for: session.scheduledDate)) ?? session.scheduledDate
        let log = RunLog(
            sessionId: session.id,
            completedAt: completedAt,
            distanceKm: distanceKm,
            movingSeconds: movingSeconds,
            averagePaceSecPerKm: distanceKm > 0 && movingSeconds > 0 ? Int((Double(movingSeconds) / distanceKm).rounded()) : 0,
            rpe: min(10, max(0, entry.rpe)),
            feelScore: min(5, max(1, entry.howFelt)),
            notes: entry.notes,
            source: .manual
        )
        modelContext.insert(log)

        let rank = try modelContext.fetch(FetchDescriptor<RankState>()).first ?? {
            let rank = RankState()
            modelContext.insert(rank)
            return rank
        }()
        if session.status == .missed {
            refundMissedSessionPenalty(on: rank)
        }

        let ratio = garminRunCompletionRatio(plannedDistanceKm: session.plannedDistanceKm, actualDistanceKm: distanceKm)
        let fatigueLevel = ReadinessScale.fatigueLevel(fromHowFelt: entry.howFelt)
        let outcome: ScoreOutcome
        let status: SessionStatus
        // Feel decides first: a run cut short because the athlete felt
        // terrible is a deload, not merely a partial.
        if let ratio, ratio < garminFullRunCompletionRatio, fatigueLevel < 9 {
            outcome = partialRunOutcome(completionRatio: ratio)
            status = .partial
        } else {
            outcome = TrainingEngine().score(
                log: SessionLogInput(
                    completed: true,
                    pullUps: 0,
                    pushUps: 0,
                    plankSeconds: 0,
                    loggedPullUps: false,
                    loggedPushUps: false,
                    loggedPlankSeconds: false,
                    rpe: entry.rpe,
                    painLevel: 0,
                    fatigueLevel: fatigueLevel
                ),
                plannedSession: nil
            )
            status = outcome.didTriggerDeload ? .deload : .completed
        }
        session.status = status
        applyScoreOutcome(outcome, to: rank)
        session.scoreImpact = outcome.consistencyDelta
        try modelContext.save()
        UserDefaults.standard.set(true, forKey: CoachVerdictRefreshFlag.needsRefreshKey)
        return status
    } catch {
        modelContext.rollback()
        throw error
    }
}

/// Lets the athlete add RPE and feel to a run Garmin completed. A "very
/// weak" feel turns the completed session into a deload; the score already
/// counted the run, so it is not scored again.
func rateRun(
    _ log: RunLog,
    rpe: Int,
    howFelt: Int,
    notes: String? = nil,
    session: WorkoutSession?,
    in modelContext: ModelContext
) throws {
    do {
        log.rpe = min(10, max(1, rpe))
        log.feelScore = min(5, max(1, howFelt))
        if let notes {
            log.notes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let session, session.status == .completed,
           ReadinessScale.fatigueLevel(fromHowFelt: howFelt) >= 9 {
            session.status = .deload
        }
        try modelContext.save()
        UserDefaults.standard.set(true, forKey: CoachVerdictRefreshFlag.needsRefreshKey)
    } catch {
        modelContext.rollback()
        throw error
    }
}

/// Yesterday's sessions that were never logged: the athlete trained late
/// and logs the next morning. Strength needs a PerformanceLog, runs any
/// attached RunLog. Runs first, like the due list.
func lateLoggableSessions(
    from sessions: [WorkoutSession],
    logs: [PerformanceLog],
    runLogs: [RunLog],
    now: Date = Date(),
    calendar: Calendar = .current
) -> [WorkoutSession] {
    let startOfToday = calendar.startOfDay(for: now)
    guard let startOfYesterday = calendar.date(byAdding: .day, value: -1, to: startOfToday) else { return [] }
    let loggedStrength = Set(logs.map(\.sessionId))
    let loggedRuns = Set(runLogs.map(\.sessionId))
    return sessions
        .filter { session in
            guard session.status == .planned || session.status == .missed else { return false }
            guard session.scheduledDate >= startOfYesterday, session.scheduledDate < startOfToday else { return false }
            return session.isRun ? !loggedRuns.contains(session.id) : !loggedStrength.contains(session.id)
        }
        .sorted { lhs, rhs in
            if lhs.isRun != rhs.isRun { return lhs.isRun }
            return lhs.scheduledDate < rhs.scheduledDate
        }
}

private let localDeloadMarker = "Deloaded after pain or very weak feedback."

/// Cuts the next planned strength session to deload volume after a pain or
/// "very weak" log, for when the coach could not regenerate the plan (offline,
/// or the proxy skipped). Sets drop to at most 3, reps and holds to 65%, and
/// every effort to light. A session is never cut twice.
@discardableResult
func applyLocalDeload(in modelContext: ModelContext, now: Date = Date(), calendar: Calendar = .current) throws -> WorkoutSession? {
    let tomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) ?? now
    let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>(sortBy: [SortDescriptor(\.scheduledDate)]))
    guard let next = sessions.first(where: {
        $0.status == .planned && $0.discipline == .strength && $0.scheduledDate >= tomorrow
    }) else { return nil }
    guard !next.summary.contains(localDeloadMarker) else { return nil }

    do {
        let nextId = next.id
        let prescriptions = try modelContext.fetch(FetchDescriptor<SetPrescription>(predicate: #Predicate { $0.sessionId == nextId }))
        let light = PlannedEffort.light(localDeloadMarker)
        for prescription in prescriptions {
            prescription.sets = min(prescription.sets, 3)
            if prescription.targetReps > 0 {
                prescription.targetReps = max(1, Int(Double(prescription.targetReps) * 0.65))
            }
            if prescription.targetSeconds > 0 {
                prescription.targetSeconds = max(10, Int(Double(prescription.targetSeconds) * 0.65))
            }
            prescription.intensity = "Light"
            prescription.plannedEffortLabelRaw = light.label.rawValue
            prescription.plannedEffortTargetRPE = light.targetRPE
            prescription.plannedEffortTargetRIR = light.targetRIR
            prescription.plannedEffortStimulusRaw = light.stimulus.rawValue
            prescription.plannedEffortReason = light.reason
        }
        next.plannedEffortLabelRaw = light.label.rawValue
        next.plannedEffortTargetRPE = light.targetRPE
        next.plannedEffortReason = light.reason
        next.summary = "\(next.summary) \(localDeloadMarker)"
        next.estimatedDurationMinutes = estimatedWorkoutDurationMinutes(for: prescriptions)
        try modelContext.save()
        return next
    } catch {
        modelContext.rollback()
        throw error
    }
}

/// Garmin readiness only describes today when it is from today or
/// yesterday; older snapshots must not be shown as current.
func freshReadinessSnapshot(
    from snapshots: [GarminDailySnapshot],
    now: Date = Date(),
    calendar: Calendar = .current
) -> GarminDailySnapshot? {
    guard let newest = snapshots.max(by: { $0.date < $1.date }) else { return nil }
    let age = calendar.dateComponents([.day], from: calendar.startOfDay(for: newest.date), to: calendar.startOfDay(for: now)).day ?? .max
    return age <= 1 ? newest : nil
}

/// Parses the date strings the Garmin proxy passes through: bare ISO dates
/// ("2026-06-08"), full ISO-8601 instants, and Garmin's local activity time
/// ("2026-06-08 07:01:33"). Wall-clock formats are read in the calendar's
/// time zone so calendar-day matching stays consistent.
func parseGarminDate(_ value: String, calendar: Calendar = .current) -> Date? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }

    let isoWithFractionalSeconds = ISO8601DateFormatter()
    isoWithFractionalSeconds.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = isoWithFractionalSeconds.date(from: trimmed) { return date }

    if let date = ISO8601DateFormatter().date(from: trimmed) { return date }

    for format in ["yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd"] {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = format
        if let date = formatter.date(from: trimmed) { return date }
    }
    return nil
}

/// Upserts exactly one GarminDailySnapshot per calendar day. Days missing
/// from the response (throttled sidecar) are left absent, never zero-filled.
/// Within a day, a metric the sidecar could not fetch (`unavailableMetrics`)
/// or a zero reading never overwrites a stored value: zero means "no data".
func ingest(
    wellness: [GarminWellnessDayResponse],
    in modelContext: ModelContext,
    calendar: Calendar = .current
) throws {
    guard !wellness.isEmpty else { return }

    let existing = try modelContext.fetch(FetchDescriptor<GarminDailySnapshot>())
    var snapshotsByDay: [Date: GarminDailySnapshot] = [:]
    for snapshot in existing {
        snapshotsByDay[calendar.startOfDay(for: snapshot.date)] = snapshot
    }

    for day in wellness {
        guard let parsed = parseGarminDate(day.date, calendar: calendar) else { continue }
        let dayStart = calendar.startOfDay(for: parsed)
        let snapshot: GarminDailySnapshot
        if let found = snapshotsByDay[dayStart] {
            snapshot = found
        } else {
            snapshot = GarminDailySnapshot(date: dayStart)
            modelContext.insert(snapshot)
            snapshotsByDay[dayStart] = snapshot
        }
        let unavailable = Set(day.unavailableMetrics ?? [])
        func merged(_ stored: Int, _ incoming: Int, _ metric: String) -> Int {
            unavailable.contains(metric) || incoming == 0 ? stored : incoming
        }
        snapshot.date = dayStart
        snapshot.sleepScore = merged(snapshot.sleepScore, day.sleepScore, "sleepScore")
        snapshot.sleepSeconds = merged(snapshot.sleepSeconds, day.sleepSeconds, "sleepSeconds")
        if !unavailable.contains("hrvStatus"), !day.hrvStatus.isEmpty {
            snapshot.hrvStatus = day.hrvStatus
        }
        snapshot.hrvMs = merged(snapshot.hrvMs, day.hrvMs, "hrvMs")
        snapshot.bodyBattery = merged(snapshot.bodyBattery, day.bodyBattery, "bodyBattery")
        snapshot.trainingReadiness = merged(snapshot.trainingReadiness, day.trainingReadiness, "trainingReadiness")
        snapshot.restingHr = merged(snapshot.restingHr, day.restingHr, "restingHr")
        snapshot.fetchedAt = Date()
    }
}

struct GarminActivityIngest: Equatable {
    /// Matched planned/missed sessions completed automatically from Garmin.
    var completedRuns = 0
    /// Matched sessions where Garmin shows meaningful work below the plan.
    var partialRuns = 0
    /// New standalone Garmin logs (real runs that matched no session).
    var importedRuns = 0
}

struct GarminAttachedLogReconciliation: Equatable {
    var completedRuns = 0
    var partialRuns = 0
    var detachedLogs = 0

    var changedCount: Int {
        completedRuns + partialRuns + detachedLogs
    }
}

/// Repairs legacy Garmin rows that were attached to a planned or missed run
/// before automatic completion existed. The relationship itself is trusted
/// only when both the exact session id and local calendar day agree. That keeps
/// duplicate activity ids attached to another replanned session out of scope.
///
/// The strongest same-day log becomes the session's completion source. Any
/// extra same-day logs remain real Garmin history but are detached, matching
/// the current ingest rule that one planned session can claim only one run.
@discardableResult
func reconcileAttachedGarminRunLogs(
    sessions: [WorkoutSession],
    runLogs: [RunLog],
    ranks: [RankState],
    in modelContext: ModelContext,
    calendar: Calendar = .current
) throws -> GarminAttachedLogReconciliation {
    let logsBySessionId = Dictionary(
        grouping: runLogs.filter {
            $0.source == .garmin &&
            $0.sessionId != RunLog.unattachedSessionId &&
            !isReplaceablePreviewRunLog($0)
        },
        by: \.sessionId
    )
    var availableRanks = ranks
    var result = GarminAttachedLogReconciliation()

    for session in sessions.sorted(by: { $0.scheduledDate < $1.scheduledDate }) {
        guard session.discipline == .running else { continue }
        guard session.status == .planned || session.status == .missed else { continue }
        let sameDayLogs = (logsBySessionId[session.id] ?? []).filter {
            calendar.isDate($0.completedAt, inSameDayAs: session.scheduledDate)
        }
        guard let strongestLog = sameDayLogs.max(by: { $0.distanceKm < $1.distanceKm }) else { continue }

        if garminRunCompletionStatus(for: session, actualDistanceKm: strongestLog.distanceKm) != nil,
           availableRanks.isEmpty {
            let rank = RankState()
            modelContext.insert(rank)
            availableRanks = [rank]
        }

        let completionStatus = try completeRunFromGarmin(
            session: session,
            log: strongestLog,
            ranks: availableRanks,
            in: modelContext
        )

        switch completionStatus {
        case .some(.completed):
            result.completedRuns += 1
        case .some(.partial):
            result.partialRuns += 1
        default:
            break
        }

        for log in sameDayLogs where completionStatus == nil || log.id != strongestLog.id {
            log.sessionId = RunLog.unattachedSessionId
            log.needsConfirmation = false
            result.detachedLogs += 1
        }
    }

    return result
}

/// Ingests synced Garmin running activities. An activity landing on the same
/// calendar day as a planned — or already auto-missed — running session
/// becomes the session's source-of-truth completion or partial completion
/// immediately. A missed session matching here means the run happened but
/// synced after the missed sweep, so the miss penalty is refunded.
/// An activity matching no session is still real training history: imported as
/// a standalone Garmin RunLog (sessionId = RunLog.unattachedSessionId) so
/// volume, baselines, and the coaches see it without touching sessions/scores.
@discardableResult
func matchGarminActivities(
    _ activities: [GarminActivityResponse],
    sessions: [WorkoutSession],
    existingRunLogs: [RunLog],
    in modelContext: ModelContext,
    calendar: Calendar = .current
) throws -> GarminActivityIngest {
    let ranks = try modelContext.fetch(FetchDescriptor<RankState>())
    let reconciliation = try reconcileAttachedGarminRunLogs(
        sessions: sessions,
        runLogs: existingRunLogs,
        ranks: ranks,
        in: modelContext,
        calendar: calendar
    )
    let existingGarminRunLogs = existingRunLogs.filter { $0.source == .garmin }
    var existingLogsByActivityId: [String: RunLog] = [:]
    for log in existingGarminRunLogs where !log.garminActivityId.isEmpty {
        existingLogsByActivityId[log.garminActivityId] = log
    }
    // Preview/demo rows and the athlete's own manual run logs give way to
    // the first real Garmin activity on the planned day; a manual log's RPE
    // and feel carry over to the Garmin row.
    let manualLogs = existingRunLogs.filter { $0.source == .manual && $0.sessionId != RunLog.unattachedSessionId }
    let replaceableLogs = existingGarminRunLogs.filter(isReplaceablePreviewRunLog) + manualLogs
    let replaceableLogsBySession = Dictionary(grouping: replaceableLogs, by: \.sessionId)
    let replaceableSessionIds = Set(replaceableLogs.map(\.sessionId))
    // A session already holding a real Garmin log is not a candidate, and each
    // session takes at most one activity per batch. Preview/demo logs can be
    // replaced by the first real Garmin activity on the planned day.
    var claimedSessionIds = Set(
        existingGarminRunLogs
            .filter { $0.sessionId != RunLog.unattachedSessionId && !isReplaceablePreviewRunLog($0) }
            .map(\.sessionId)
    )
    var ingest = GarminActivityIngest()
    ingest.completedRuns = reconciliation.completedRuns
    ingest.partialRuns = reconciliation.partialRuns

    for activity in activities {
        // The proxy only forwards running activities; this is a defensive check.
        guard isGarminRunningActivityType(activity.activityType) else { continue }
        guard !activity.garminActivityId.isEmpty else { continue }
        let existingLog = existingLogsByActivityId[activity.garminActivityId]
        if let existingLog, existingLog.sessionId != RunLog.unattachedSessionId {
            continue
        }
        guard let startTime = parseGarminDate(activity.startTime, calendar: calendar) else { continue }

        let candidates = sessions.filter {
            $0.discipline == .running &&
            ($0.status == .planned || $0.status == .missed || replaceableSessionIds.contains($0.id)) &&
            !claimedSessionIds.contains($0.id) &&
            calendar.isDate($0.scheduledDate, inSameDayAs: startTime) &&
            garminRunCompletionStatus(for: $0, actualDistanceKm: activity.distanceKm) != nil
        }
        let session = candidates.min(by: { lhs, rhs in
            let lhsSynced = isSyncedGarminPlannedRun(lhs)
            let rhsSynced = isSyncedGarminPlannedRun(rhs)
            if lhsSynced != rhsSynced { return lhsSynced }

            let lhsDistanceDelta = abs(lhs.plannedDistanceKm - activity.distanceKm)
            let rhsDistanceDelta = abs(rhs.plannedDistanceKm - activity.distanceKm)
            if lhsDistanceDelta != rhsDistanceDelta { return lhsDistanceDelta < rhsDistanceDelta }

            return lhs.scheduledDate < rhs.scheduledDate
        })

        if existingLog != nil && session == nil {
            continue
        }

        let log = existingLog ?? RunLog(garminActivityId: activity.garminActivityId, source: .garmin)
        log.sessionId = session?.id ?? RunLog.unattachedSessionId
        log.completedAt = startTime
        log.distanceKm = activity.distanceKm
        log.movingSeconds = activity.movingSeconds
        log.elevationGainM = activity.elevationGainM
        log.elevationLossM = activity.elevationLossM ?? 0
        log.averageHr = activity.averageHr
        log.averagePaceSecPerKm = activity.averagePaceSecPerKm
        log.rpe = 0
        log.feelScore = 3
        log.garminActivityId = activity.garminActivityId
        log.sourceRaw = RunLogSource.garmin.rawValue
        log.needsConfirmation = false
        if existingLog == nil {
            modelContext.insert(log)
        }

        if let session {
            claimedSessionIds.insert(session.id)
            for replaceableLog in replaceableLogsBySession[session.id] ?? [] where replaceableLog.id != log.id {
                if replaceableLog.source == .manual {
                    if replaceableLog.rpe > 0 {
                        log.rpe = replaceableLog.rpe
                        log.feelScore = replaceableLog.feelScore
                    }
                    if log.notes.isEmpty {
                        log.notes = replaceableLog.notes
                    }
                }
                modelContext.delete(replaceableLog)
            }
            let ranks = try modelContext.fetch(FetchDescriptor<RankState>())
            let completionStatus = try completeRunFromGarmin(session: session, log: log, ranks: ranks, in: modelContext)
            switch completionStatus {
            case .some(.completed):
                ingest.completedRuns += 1
            case .some(.partial):
                ingest.partialRuns += 1
            default:
                break
            }
        } else {
            ingest.importedRuns += 1
        }
    }
    return ingest
}

private func isReplaceablePreviewRunLog(_ log: RunLog) -> Bool {
    log.garminActivityId.hasPrefix("preview-")
}

private func isSyncedGarminPlannedRun(_ session: WorkoutSession) -> Bool {
    session.garminSyncStatus == .synced || !session.garminWorkoutId.isEmpty || session.pushedToGarminAt != nil
}

/// Real running history: Garmin logs (one per activity id) plus the
/// athlete's manual run logs. A same-day Garmin activity normally replaces
/// the manual row during sync; when it can't (too short to match, or not
/// attached), Garmin still wins that day so a run is never counted twice.
func confirmedRunLogs(from logs: [RunLog], calendar: Calendar = .current) -> [RunLog] {
    var logsByActivityId: [String: RunLog] = [:]
    var logsWithoutActivityId: [RunLog] = []
    let garminDays = Set(logs.filter { $0.source == .garmin }.map { calendar.startOfDay(for: $0.completedAt) })
    let manualLogs = logs.filter {
        $0.source == .manual &&
        $0.sessionId != RunLog.unattachedSessionId &&
        !garminDays.contains(calendar.startOfDay(for: $0.completedAt))
    }

    for log in logs where log.source == .garmin {
        let activityId = log.garminActivityId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !activityId.isEmpty else {
            logsWithoutActivityId.append(log)
            continue
        }

        if let existing = logsByActivityId[activityId] {
            logsByActivityId[activityId] = preferredGarminRunLog(existing, log)
        } else {
            logsByActivityId[activityId] = log
        }
    }

    return (logsWithoutActivityId + Array(logsByActivityId.values) + manualLogs)
        .sorted { $0.completedAt < $1.completedAt }
}

private func preferredGarminRunLog(_ lhs: RunLog, _ rhs: RunLog) -> RunLog {
    func score(_ log: RunLog) -> Int {
        var value = 0
        if !log.needsConfirmation { value += 8 }
        if log.sessionId != RunLog.unattachedSessionId { value += 4 }
        if log.movingSeconds > 0 { value += 2 }
        if log.averageHr > 0 || log.averagePaceSecPerKm > 0 { value += 1 }
        return value
    }

    let lhsScore = score(lhs)
    let rhsScore = score(rhs)
    if lhsScore != rhsScore { return lhsScore > rhsScore ? lhs : rhs }
    return lhs.completedAt >= rhs.completedAt ? lhs : rhs
}

/// Keeps the race goal's training baselines aligned with actual Garmin
/// run history: baseline weekly volume = the last 28 days of running divided
/// by four weeks; longest recent run = the longest run in the last 42 days.
/// Manually entered values act only as a fallback until real runs exist.
func updateRaceGoalBaselines(
    goal: RaceGoal,
    logs: [RunLog],
    now: Date = Date(),
    calendar: Calendar = .current
) {
    let garminLogs = confirmedRunLogs(from: logs)
    guard !garminLogs.isEmpty else { return }

    let fourWeeksAgo = calendar.date(byAdding: .day, value: -28, to: now) ?? now
    let sixWeeksAgo = calendar.date(byAdding: .day, value: -42, to: now) ?? now

    let inWindow = garminLogs.filter { $0.completedAt >= fourWeeksAgo && $0.completedAt <= now }
    let recentVolume = inWindow.reduce(0.0) { $0 + $1.distanceKm }
    if recentVolume > 0, let oldest = inWindow.map(\.completedAt).min() {
        // Divide by the span the data actually covers (a first sync only sees
        // ~7 days), converging to a true 4-week average as history grows.
        let daysCovered = min(28.0, max(1.0, now.timeIntervalSince(oldest) / 86_400))
        let weeksCovered = max(1.0, daysCovered / 7.0)
        goal.baselineWeeklyKm = (recentVolume / weeksCovered * 10).rounded() / 10
    }

    let longestRecent = garminLogs
        .filter { $0.completedAt >= sixWeeksAgo && $0.completedAt <= now }
        .map(\.distanceKm)
        .max() ?? 0
    if longestRecent > 0 {
        goal.longestRecentRunKm = (longestRecent * 10).rounded() / 10
    }
}

/// Mirrors the sidecar's running filter (any typeKey containing "running" or
/// "ultra": running, trail_running, ultra_run, treadmill_running, ...).
private func isGarminRunningActivityType(_ type: String) -> Bool {
    let normalized = type.lowercased()
    return normalized.contains("running") || normalized.contains("ultra")
}

/// Shared "Last sync" formatting for the Garmin rows in Coach and Settings.
/// The timestamp is recorded on successful syncs only; 0 means no sync has
/// completed yet.
func relativeSyncText(epochSeconds: Double) -> String {
    guard epochSeconds > 0 else { return "Never" }
    return Date(timeIntervalSince1970: epochSeconds)
        .formatted(.relative(presentation: .named))
}

enum GarminSyncError: LocalizedError {
    case notLoggedIn
    var errorDescription: String? { "Garmin is not logged in on the server — nothing synced." }
}

/// The Garmin pull shared by the app-shell background sync and the Settings
/// "Sync now" button: fetch the 7-day snapshot, ingest wellness, match
/// activities to planned runs, save, and return a summary of completed/imported
/// runs. A snapshot from a logged-out sidecar throws GarminSyncError.notLoggedIn
/// instead of "succeeding" with nothing, so callers retry and Settings can say
/// why. Throws after rolling back any partial ingest, so a failed sync never
/// leaves half-written snapshots or logs; callers own garminLastSyncAt and
/// error surfacing.
///
/// Caveat (mirrors saveAtomically): rollback() discards ALL unsaved
/// mainContext changes, not just this sync's — safe under the app's
/// save-immediately-after-every-mutation convention.
@MainActor
func performGarminSync(endpoint: String, userId: String, in modelContext: ModelContext) async throws -> GarminActivityIngest {
    do {
        let client = try LocalCoachClient(endpointString: endpoint)
        let snapshot = try await client.fetchGarminSnapshot(sinceDays: 7, userId: userId)
        // A logged-out sidecar returns empty wellness/activities; ingest and
        // matching would be skipped anyway, so report the truth instead.
        guard snapshot.status.loggedIn else { throw GarminSyncError.notLoggedIn }
        try ingest(wellness: snapshot.wellness, in: modelContext)
        // Fetch fresh after the await: any view snapshot the caller holds may
        // be stale by the time the response lands (e.g. the missed sweep ran
        // meanwhile).
        let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())
        let existingRunLogs = try modelContext.fetch(FetchDescriptor<RunLog>())
        let ingested = try matchGarminActivities(
            snapshot.activities,
            sessions: sessions,
            existingRunLogs: existingRunLogs,
            in: modelContext
        )
        // Keep the race goal's baselines aligned with real run history.
        if let goal = try modelContext.fetch(
            FetchDescriptor<RaceGoal>(sortBy: [SortDescriptor(\.createdAt)])
        ).first {
            let logs = try modelContext.fetch(FetchDescriptor<RunLog>())
            updateRaceGoalBaselines(goal: goal, logs: logs)
        }
        try modelContext.save()
        return ingested
    } catch {
        modelContext.rollback()
        throw error
    }
}

func persist(
    plan: WeeklyPlan,
    in modelContext: ModelContext,
    source: PlanSource = .rules,
    replacingFuturePlannedSessions: Bool = false,
    maxSessions: Int? = nil
) throws {
    if replacingFuturePlannedSessions {
        try deleteFuturePlannedSessions(in: modelContext, for: plan.weekStart, discipline: .strength)
    }

    let coachPlan = CoachPlan(weekStart: plan.weekStart, summary: plan.summary, source: source, validationStatus: .accepted)
    modelContext.insert(coachPlan)

    let sessionPlans = maxSessions.map { Array(plan.sessions.prefix($0)) } ?? plan.sessions
    for sessionPlan in sessionPlans {
        guard shouldPersistGeneratedSession(
            scheduledDate: sessionPlan.date,
            replacingFuturePlannedSessions: replacingFuturePlannedSessions
        ) else { continue }

        let estimatedDurationMinutes = sessionPlan.estimatedDurationMinutes > 0
            ? sessionPlan.estimatedDurationMinutes
            : estimatedWorkoutDurationMinutes(for: sessionPlan.blocks)
        let session = WorkoutSession(
            id: sessionPlan.id,
            scheduledDate: sessionPlan.date,
            title: sessionPlan.title,
            weekIndex: sessionPlan.weekIndex,
            focus: sessionPlan.focus,
            summary: sessionPlan.summary,
            plannedEffort: sessionPlan.plannedEffort,
            estimatedDurationMinutes: estimatedDurationMinutes
        )
        modelContext.insert(session)

        for (blockIndex, blockPlan) in sessionPlan.blocks.enumerated() {
            let block = WorkoutBlock(sessionId: session.id, orderIndex: blockIndex, name: blockPlan.name, detail: blockPlan.detail)
            modelContext.insert(block)

            for (setIndex, setPlan) in blockPlan.sets.enumerated() {
                modelContext.insert(SetPrescription(
                    sessionId: session.id,
                    blockId: block.id,
                    orderIndex: blockIndex * 100 + setIndex,
                    exercise: setPlan.exercise,
                    sets: setPlan.sets,
                    targetReps: setPlan.reps,
                    targetSeconds: setPlan.seconds,
                    restSeconds: setPlan.restSeconds,
                    intensity: setPlan.intensity,
                    plannedEffort: setPlan.plannedEffort
                ))
            }
        }
    }
}

/// Returns the Garmin workout ids of replaced runs that were already pushed
/// to the watch, so the caller can delete them from Garmin before pushing
/// the fresh week.
@discardableResult
func persist(
    runningWeek: RunningWeekResponse,
    weekStart: Date,
    in modelContext: ModelContext,
    replacingFuturePlannedSessions: Bool = false
) throws -> [String] {
    var stalePushedGarminIds: [String] = []
    if replacingFuturePlannedSessions {
        stalePushedGarminIds = try deleteFuturePlannedSessions(in: modelContext, for: weekStart, discipline: .running)
    }

    let calendar = Calendar.current
    let start = calendar.startOfDay(for: weekStart)
    for run in runningWeek.sessions {
        let date = calendar.date(byAdding: .day, value: run.dayOffset, to: start) ?? start
        guard shouldPersistGeneratedSession(
            scheduledDate: date,
            replacingFuturePlannedSessions: replacingFuturePlannedSessions,
            calendar: calendar
        ) else { continue }

        let session = WorkoutSession(
            scheduledDate: date,
            title: run.title,
            weekIndex: 0,
            focus: .mixed,
            summary: "AI: \(run.purpose)",
            estimatedDurationMinutes: max(0, run.durationMinutes),
            discipline: .running,
            runKind: RunKind(rawValue: run.kind),
            plannedDistanceKm: run.distanceKm,
            plannedElevationM: run.elevationMeters,
            runTargetType: RunTargetType(rawValue: run.target.type),
            runTargetLow: run.target.low,
            runTargetHigh: run.target.high,
            runZone: run.zone
        )
        modelContext.insert(session)
    }
    return stalePushedGarminIds
}

private func shouldPersistGeneratedSession(
    scheduledDate: Date,
    replacingFuturePlannedSessions: Bool,
    calendar: Calendar = .current
) -> Bool {
    guard replacingFuturePlannedSessions else { return true }
    let today = calendar.startOfDay(for: Date())
    let tomorrow = calendar.date(byAdding: .day, value: 1, to: today) ?? today
    return calendar.startOfDay(for: scheduledDate) >= tomorrow
}

@discardableResult
func deleteNonAIPlannedSessions(from sessions: [WorkoutSession], in modelContext: ModelContext) throws -> Int {
    let sessionsToDelete = sessions.filter { $0.status == .planned && !$0.summary.hasPrefix("AI:") }
    guard !sessionsToDelete.isEmpty else { return 0 }

    let sessionIds = Set(sessionsToDelete.map(\.id))
    let prescriptions = try modelContext.fetch(FetchDescriptor<SetPrescription>())
    for prescription in prescriptions where sessionIds.contains(prescription.sessionId) {
        modelContext.delete(prescription)
    }

    let blocks = try modelContext.fetch(FetchDescriptor<WorkoutBlock>())
    for block in blocks where sessionIds.contains(block.sessionId) {
        modelContext.delete(block)
    }

    for session in sessionsToDelete {
        modelContext.delete(session)
    }

    try modelContext.save()
    return sessionsToDelete.count
}

/// Returns the non-empty `garminWorkoutId`s of the deleted running sessions
/// so a replan can clear the matching structured workouts from the watch.
@discardableResult
private func deleteFuturePlannedSessions(in modelContext: ModelContext, for weekStart: Date, discipline: Discipline?) throws -> [String] {
    let calendar = Calendar.current
    let start = calendar.startOfDay(for: weekStart)
    let end = calendar.date(byAdding: .day, value: 7, to: start) ?? start
    let today = calendar.startOfDay(for: Date())
    // Today stays locked during refreshes, even after training today: a
    // double day keeps its second session and its watch workout.
    let tomorrow = calendar.date(byAdding: .day, value: 1, to: today) ?? today
    let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())

    let sessionsToDelete = sessions.filter {
        $0.status == .planned &&
        $0.scheduledDate >= start &&
        $0.scheduledDate < end &&
        $0.scheduledDate >= tomorrow &&
        (discipline == nil || $0.discipline == discipline)
    }

    let stalePushedGarminIds = sessionsToDelete
        .filter { $0.discipline == .running && !$0.garminWorkoutId.isEmpty }
        .map(\.garminWorkoutId)

    let sessionIds = Set(sessionsToDelete.map(\.id))
    let prescriptions = try modelContext.fetch(FetchDescriptor<SetPrescription>())
    for prescription in prescriptions where sessionIds.contains(prescription.sessionId) {
        modelContext.delete(prescription)
    }

    let blocks = try modelContext.fetch(FetchDescriptor<WorkoutBlock>())
    for block in blocks where sessionIds.contains(block.sessionId) {
        modelContext.delete(block)
    }

    for session in sessionsToDelete {
        modelContext.delete(session)
    }
    return stalePushedGarminIds
}

func wipeAllData(in modelContext: ModelContext) throws {
    try deleteAll(CoachChatMessage.self, in: modelContext)
    try deleteAll(CoachVerdict.self, in: modelContext)
    try deleteAll(CoachDecision.self, in: modelContext)
    try deleteAll(CoachPlan.self, in: modelContext)
    try deleteAll(PerformanceLog.self, in: modelContext)
    try deleteAll(SetPrescription.self, in: modelContext)
    try deleteAll(WorkoutBlock.self, in: modelContext)
    try deleteAll(WorkoutSession.self, in: modelContext)
    try deleteAll(RankState.self, in: modelContext)
    try deleteAll(RunLog.self, in: modelContext)
    try deleteAll(RaceGoal.self, in: modelContext)
    try deleteAll(GarminDailySnapshot.self, in: modelContext)
    try deleteAll(UserProfile.self, in: modelContext)
}

// MARK: - New plan

/// Everything the coach plans from, as one editable value. Onboarding starts
/// from the defaults; "Start a new plan" starts from the current profile.
struct PlanInputs: Equatable {
    var pullUps = 5
    var pushUps = 20
    var plankSeconds = 60
    var goalPullUps = 50
    var goalPushUps = 100
    var goalPlankSeconds = 300
    var targetDate = Calendar.current.date(byAdding: .year, value: 1, to: Date()) ?? Date()
    var trainingDays: Set<TrainingWeekday> = TrainingWeekday.defaultTrainingDays(for: 4)
    /// The longest a strength session may take; 0 leaves it to the coach.
    var sessionMinutes = 0
    var equipment: Set<EquipmentKind> = [.pullUpBar, .yogaMat]
    var strictForm = true
    var painNotes = ""
    var isTrainingForRace = false
    var raceName = ""
    var raceDate = Calendar.current.date(byAdding: .weekOfYear, value: 16, to: Date()) ?? Date()
    var raceDistanceKm = 50
    var raceElevationGainM = 1000
    var runningDays: Set<TrainingWeekday> = [.tuesday, .thursday, .saturday]
    var longRunDay: TrainingWeekday = .saturday

    /// Why the inputs can't be saved yet, in the order the athlete meets the
    /// controls. Nil when they can.
    var blockingReason: String? {
        if !(2...6).contains(trainingDays.count) { return "Pick 2 to 6 strength days." }
        if isTrainingForRace && runningDays.isEmpty { return "Pick at least one running day." }
        if !equipment.contains(.pullUpBar) { return "Add a pull-up bar to continue." }
        if !strictForm { return "Turn on strict reps to continue." }
        return nil
    }

    /// The long-run day, moved onto a picked running day if it isn't one.
    var resolvedLongRunDay: TrainingWeekday? {
        runningDays.contains(longRunDay) ? longRunDay : TrainingWeekday.allCases.last { runningDays.contains($0) }
    }

    func applyingStrengthNumbers(_ numbers: StrengthNumbers) -> PlanInputs {
        var copy = self
        copy.pullUps = numbers.pullUps
        copy.pushUps = numbers.pushUps
        copy.plankSeconds = numbers.plankSeconds
        return copy
    }
}

extension PlanInputs {
    /// Pre-filled from the profile, the race goal and the athlete's current
    /// numbers.
    init(profile: UserProfile, raceGoal: RaceGoal?, current: StrengthNumbers) {
        self.init()
        pullUps = current.pullUps
        pushUps = current.pushUps
        plankSeconds = current.plankSeconds
        goalPullUps = profile.goalPullUps
        goalPushUps = profile.goalPushUps
        goalPlankSeconds = profile.goalPlankSeconds
        targetDate = profile.targetDate
        trainingDays = profile.trainingDays
        sessionMinutes = max(0, profile.sessionMinutes)
        equipment = profile.equipment
        strictForm = profile.strictFormAccepted
        painNotes = profile.painNotes
        if let raceGoal {
            isTrainingForRace = true
            raceName = raceGoal.name
            raceDate = raceGoal.raceDate
            raceDistanceKm = max(1, Int(raceGoal.distanceKm.rounded()))
            raceElevationGainM = max(0, raceGoal.elevationGainM)
        }
        if !profile.runningDays.isEmpty {
            runningDays = profile.runningDays
        }
        longRunDay = profile.longRunDay.flatMap { runningDays.contains($0) ? $0 : nil }
            ?? TrainingWeekday.allCases.last { runningDays.contains($0) }
            ?? .saturday
    }
}

struct StrengthNumbers: Equatable {
    var pullUps: Int
    var pushUps: Int
    var plankSeconds: Int
}

/// Where the athlete stands now, per movement: the best strict value logged
/// in the last four weeks; with nothing that recent, the latest logged
/// value; with nothing logged, the profile's baseline.
func currentStrengthNumbers(
    profile: UserProfile,
    logs: [PerformanceLog],
    now: Date = Date(),
    calendar: Calendar = .current
) -> StrengthNumbers {
    let recentStart = calendar.date(byAdding: .day, value: -28, to: calendar.startOfDay(for: now)) ?? now
    let newestFirst = logs.filter { $0.completedAt <= now }.sorted { $0.completedAt > $1.completedAt }

    func current(_ value: (PerformanceLog) -> Int, logged: (PerformanceLog) -> Bool, baseline: Int) -> Int {
        let loggedValues = newestFirst.filter(logged)
        if let recentBest = loggedValues.filter({ $0.completedAt >= recentStart }).map(value).max() {
            return recentBest
        }
        return loggedValues.first.map(value) ?? baseline
    }

    return StrengthNumbers(
        pullUps: current(\.pullUps, logged: \.loggedPullUps, baseline: profile.baselinePullUps),
        pushUps: current(\.pushUps, logged: \.loggedPushUps, baseline: profile.baselinePushUps),
        plankSeconds: current(\.plankSeconds, logged: \.loggedPlankSeconds, baseline: profile.baselinePlankSeconds)
    )
}

struct NewPlanReset: Equatable {
    var removedSessionCount: Int
    /// Watch workouts of removed sessions, queued for deletion on Garmin.
    var stalePushedGarminIds: [String]
}

/// "Start a new plan": keeps the athlete's history and replaces the plan.
/// In one save it removes every open (planned) session from today on with
/// its blocks and prescriptions, clears the coach plan, decisions and read,
/// writes the new inputs to the profile and race goal, and starts a new plan
/// block now. Logs, runs, readiness, past sessions, rank and chat stay.
/// Today's open sessions go too: the athlete asked for a fresh start, and a
/// replan never fills today, so leaving them would turn into misses.
/// Removed watch workouts join the stale queue only once the save succeeds;
/// the next Garmin plan sync deletes them.
@discardableResult
func startNewPlan(
    with inputs: PlanInputs,
    profile: UserProfile,
    in modelContext: ModelContext,
    staleWorkoutQueue: GarminStaleWorkoutQueue = GarminStaleWorkoutQueue(),
    now: Date = Date(),
    calendar: Calendar = .current
) throws -> NewPlanReset {
    do {
        let startOfToday = calendar.startOfDay(for: now)
        let openSessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())
            .filter { $0.status == .planned && $0.scheduledDate >= startOfToday }
            .sorted { $0.scheduledDate < $1.scheduledDate }
        let staleIds = openSessions.map(\.garminWorkoutId).filter { !$0.isEmpty }
        let openIds = Set(openSessions.map(\.id))

        for prescription in try modelContext.fetch(FetchDescriptor<SetPrescription>()) where openIds.contains(prescription.sessionId) {
            modelContext.delete(prescription)
        }
        for block in try modelContext.fetch(FetchDescriptor<WorkoutBlock>()) where openIds.contains(block.sessionId) {
            modelContext.delete(block)
        }
        for session in openSessions {
            modelContext.delete(session)
        }

        // Decisions belong to plans; the read judged the old plan.
        try deleteAll(CoachDecision.self, in: modelContext)
        try deleteAll(CoachPlan.self, in: modelContext)
        try deleteAll(CoachVerdict.self, in: modelContext)

        profile.baselinePullUps = inputs.pullUps
        profile.baselinePushUps = inputs.pushUps
        profile.baselinePlankSeconds = inputs.plankSeconds
        profile.goalPullUps = inputs.goalPullUps
        profile.goalPushUps = inputs.goalPushUps
        profile.goalPlankSeconds = inputs.goalPlankSeconds
        profile.targetDate = inputs.targetDate
        profile.trainingDays = inputs.trainingDays
        profile.sessionMinutes = max(0, inputs.sessionMinutes)
        profile.equipment = inputs.equipment
        profile.strictFormAccepted = inputs.strictForm
        profile.painNotes = inputs.painNotes.trimmingCharacters(in: .whitespacesAndNewlines)
        profile.planBlockStartedAt = now

        let raceGoals = try modelContext.fetch(FetchDescriptor<RaceGoal>(sortBy: [SortDescriptor(\.createdAt)]))
        if inputs.isTrainingForRace {
            // Edit the goal in place: its weekly base and longest run come
            // from run history, which a new plan keeps.
            let goal: RaceGoal
            if let existing = raceGoals.first {
                goal = existing
            } else {
                goal = RaceGoal(createdAt: now)
                modelContext.insert(goal)
            }
            goal.name = inputs.raceName.trimmingCharacters(in: .whitespacesAndNewlines)
            goal.raceDate = inputs.raceDate
            goal.distanceKm = Double(inputs.raceDistanceKm)
            goal.elevationGainM = inputs.raceElevationGainM
            profile.runningDays = inputs.runningDays
            profile.longRunDay = inputs.resolvedLongRunDay
        } else {
            for goal in raceGoals {
                modelContext.delete(goal)
            }
        }

        try modelContext.save()
        staleWorkoutQueue.enqueue(staleIds)
        return NewPlanReset(removedSessionCount: openSessions.count, stalePushedGarminIds: staleIds)
    } catch {
        modelContext.rollback()
        throw error
    }
}

func applyScoreOutcome(_ outcome: ScoreOutcome, to rank: RankState) {
    rank.consistencyScore = max(0, rank.consistencyScore + outcome.consistencyDelta)
    rank.penaltyPoints = max(0, rank.penaltyPoints + outcome.penaltyDelta)
    if outcome.streakDelta < 0 {
        rank.streak = 0
    } else {
        rank.streak = max(0, rank.streak + outcome.streakDelta)
    }
    rank.bestStreak = max(rank.bestStreak, rank.streak)
    rank.updatedAt = Date()
}

private func deleteAll<T: PersistentModel>(_ modelType: T.Type, in modelContext: ModelContext) throws {
    let items = try modelContext.fetch(FetchDescriptor<T>())
    for item in items {
        modelContext.delete(item)
    }
}

func prescriptionText(_ item: SetPrescription) -> String {
    if item.targetSeconds > 0 {
        return "\(item.sets) x \(format(seconds: item.targetSeconds))"
    }
    return "\(item.sets) x \(item.targetReps)"
}

func workoutTargetText(_ item: SetPrescription) -> String {
    if item.targetSeconds > 0 {
        return "\(item.sets) sets of \(durationText(seconds: item.targetSeconds)) each"
    }
    return "\(item.sets) sets of \(item.targetReps) strict reps each"
}

func estimatedWorkoutDurationMinutes(for session: WorkoutSession, prescriptions: [SetPrescription]) -> Int {
    if session.estimatedDurationMinutes > 0 {
        return session.estimatedDurationMinutes
    }
    return estimatedWorkoutDurationMinutes(for: prescriptions)
}

func estimatedWorkoutDurationMinutes(for blocks: [WorkoutBlockPlan]) -> Int {
    estimatedWorkoutDurationMinutes(totalSeconds: blocks.flatMap(\.sets).reduce(0) { total, set in
        total + estimatedExerciseDurationSeconds(
            sets: set.sets,
            reps: set.reps,
            seconds: set.seconds,
            restSeconds: set.restSeconds
        )
    })
}

func estimatedWorkoutDurationMinutes(for prescriptions: [SetPrescription]) -> Int {
    estimatedWorkoutDurationMinutes(totalSeconds: prescriptions.reduce(0) { total, prescription in
        total + estimatedExerciseDurationSeconds(
            sets: prescription.sets,
            reps: prescription.targetReps,
            seconds: prescription.targetSeconds,
            restSeconds: prescription.restSeconds
        )
    })
}

private func estimatedWorkoutDurationMinutes(totalSeconds: Int) -> Int {
    guard totalSeconds > 0 else { return 0 }
    return max(1, Int(ceil(Double(totalSeconds) / 60.0)))
}

private func estimatedExerciseDurationSeconds(sets: Int, reps: Int, seconds: Int, restSeconds: Int) -> Int {
    let safeSets = max(0, sets)
    let workSeconds = max(0, seconds) > 0 ? max(0, seconds) : max(0, reps) * 3
    return safeSets * (workSeconds + max(0, restSeconds))
}

func durationText(seconds: Int) -> String {
    if seconds < 60 {
        return "\(seconds) sec"
    }
    let minutes = seconds / 60
    let remainingSeconds = seconds % 60
    if remainingSeconds == 0 {
        return "\(minutes) min"
    }
    return "\(minutes) min \(remainingSeconds) sec"
}

func format(seconds: Int) -> String {
    let minutes = seconds / 60
    let seconds = seconds % 60
    return "\(minutes):" + String(format: "%02d", seconds)
}

func runDistanceText(km: Double, locale: Locale = .current) -> String {
    "\(km.formatted(.number.precision(.fractionLength(0...1)).locale(locale))) km"
}

func runPaceText(secondsPerKm: Int) -> String {
    "\(format(seconds: secondsPerKm)) /km"
}

func runTargetText(session: WorkoutSession) -> String {
    let low = session.runTargetLow
    let high = session.runTargetHigh
    let zone = session.runZone.trimmingCharacters(in: .whitespacesAndNewlines)
    let target: String?
    switch session.runTargetType {
    case .pace where low > 0 && high > 0:
        target = low == high
            ? runPaceText(secondsPerKm: low)
            : "\(format(seconds: low))\u{2013}\(format(seconds: high)) /km"
    case .hr where low > 0 && high > 0:
        target = low == high ? "\(low) bpm" : "\(low)\u{2013}\(high) bpm"
    default:
        target = nil
    }
    // The zone is the athlete-facing language; the target is the watch-facing
    // number. Show both when both exist.
    switch (zone.isEmpty, target) {
    case (false, let target?): return "\(zone) \u{B7} \(target)"
    case (false, nil): return zone
    case (true, let target?): return target
    case (true, nil): return "Easy"
    }
}

func exerciseMovementDescription(_ exercise: ExerciseKind) -> String {
    switch exercise {
    case .pullUp:
        "A vertical pull on a bar: start hanging with straight arms, pull until your chin clears the bar, then lower back to straight arms."
    case .pushUp:
        "A floor press: keep your body in one straight line, lower your chest toward the floor, then press back to locked arms."
    case .plank:
        "A timed front hold: brace your abs and glutes, keep ribs down, and hold a straight line from shoulders to heels."
    case .scapularPull:
        "A small pull from a dead hang: keep elbows straight, pull the shoulder blades down and back, pause, then release."
    case .hollowHold:
        "A floor core hold: lie on your back, press your low back into the floor, lift shoulders and legs, and hold the hollow shape."
    case .inclinePushUp:
        "A push-up with hands on a raised surface: lower your chest to the surface, then press back up with a straight body line."
    case .pikePushUp:
        "A shoulder-focused push-up: keep hips high, lower your head between your hands, then press back up without losing the pike shape."
    case .deadHang:
        "A timed hang from a bar: grip the bar, keep arms straight, keep shoulders active, and hold without swinging."
    case .shoulderMobility:
        "Slow arm circles: raise both arms forward to overhead, sweep them out and down, then reverse the direction. Stay pain-free."
    }
}
