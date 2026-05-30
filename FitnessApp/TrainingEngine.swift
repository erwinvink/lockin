import Foundation

struct Baseline: Equatable {
    var pullUps: Int
    var pushUps: Int
    var plankSeconds: Int
}

struct GoalTargets: Equatable {
    var pullUps: Int
    var pushUps: Int
    var plankSeconds: Int
}

struct TrainingPreferences: Equatable {
    var weeklySessions: Int
    var equipment: Set<EquipmentKind>
    var targetDate: Date
}

struct ExerciseSetPlan: Identifiable, Equatable {
    var id = UUID()
    var exercise: ExerciseKind
    var sets: Int
    var reps: Int
    var seconds: Int
    var restSeconds: Int
    var intensity: String
}

struct WorkoutBlockPlan: Identifiable, Equatable {
    var id = UUID()
    var name: String
    var detail: String
    var sets: [ExerciseSetPlan]
}

struct TrainingSessionPlan: Identifiable, Equatable {
    var id = UUID()
    var date: Date
    var title: String
    var focus: SessionFocus
    var weekIndex: Int
    var summary: String
    var blocks: [WorkoutBlockPlan]
}

struct WeeklyPlan: Equatable {
    var weekStart: Date
    var weekIndex: Int
    var sessions: [TrainingSessionPlan]
    var summary: String
    var shouldTest: Bool
}

struct SessionLogInput: Equatable {
    var completed: Bool
    var pullUps: Int
    var pushUps: Int
    var plankSeconds: Int
    var loggedPullUps: Bool = true
    var loggedPushUps: Bool = true
    var loggedPlankSeconds: Bool = true
    var rpe: Int
    var painLevel: Int
    var fatigueLevel: Int
}

struct ScoreOutcome: Equatable {
    var xpDelta: Int
    var consistencyDelta: Int
    var penaltyDelta: Int
    var streakDelta: Int
    var didTriggerDeload: Bool
    var reason: String
}

struct PlanValidationResult: Equatable {
    var status: ValidationStatus
    var messages: [String]
}

struct RunningSessionPlan: Identifiable, Equatable {
    var id = UUID()
    var date: Date
    var title: String
    var runType: RunWorkoutType
    var focus: SessionFocus
    var weekIndex: Int
    var targetDurationMinutes: Int
    var targetDistanceKm: Double
    var targetElevationMeters: Int
    var targetHeartRateLow: Int
    var targetHeartRateHigh: Int
    var targetPaceSecondsPerKm: Int
    var terrain: RunningTerrain
    var runWalkStrategy: String
    var fuelingPlan: String
    var purpose: String
    var safetyNotes: String
}

struct UltraWeekPlan: Equatable {
    var weekStart: Date
    var weekIndex: Int
    var sessions: [RunningSessionPlan]
    var summary: String
    var readiness: String
}

struct TrainingEngine {
    static let defaultGoals = GoalTargets(pullUps: 50, pushUps: 100, plankSeconds: 300)
    static let missedSessionPenaltyPoints = 25
    static let missedSessionXPDelta = -70
    static let missedSessionConsistencyDelta = -12

    func generateWeek(
        start: Date,
        weekIndex: Int,
        baseline: Baseline,
        goals: GoalTargets = TrainingEngine.defaultGoals,
        preferences: TrainingPreferences,
        recentLogs: [SessionLogInput] = []
    ) -> WeeklyPlan {
        let sessionCount = min(max(preferences.weeklySessions, 2), 6)
        let deload = recentLogs.contains { $0.painLevel >= 4 || $0.fatigueLevel >= 9 }
        let readiness = readinessMultiplier(from: baseline, goals: goals, targetDate: preferences.targetDate, weekIndex: weekIndex)
        let multiplier = deload ? max(0.55, readiness * 0.65) : readiness
        let focuses = focusSequence(count: sessionCount)

        let sessions = (0..<sessionCount).map { index in
            let date = Calendar.current.date(byAdding: .day, value: index * max(1, 7 / sessionCount), to: start) ?? start
            return makeSession(
                date: date,
                index: index,
                weekIndex: weekIndex,
                focus: focuses[index],
                baseline: baseline,
                multiplier: multiplier,
                equipment: preferences.equipment,
                deload: deload
            )
        }

        return WeeklyPlan(
            weekStart: start,
            weekIndex: weekIndex,
            sessions: sessions,
            summary: deload ? "Deload week: score pressure stays on, training stress drops." : "Adaptive build week: exact volume, strict form, no junk reps.",
            shouldTest: shouldScheduleTest(weekIndex: weekIndex, baseline: baseline, goals: goals, recentLogs: recentLogs)
        )
    }

    func score(log: SessionLogInput, plannedSession: TrainingSessionPlan?) -> ScoreOutcome {
        guard log.completed else {
            return ScoreOutcome(
                xpDelta: Self.missedSessionXPDelta,
                consistencyDelta: Self.missedSessionConsistencyDelta,
                penaltyDelta: Self.missedSessionPenaltyPoints,
                streakDelta: -1,
                didTriggerDeload: false,
                reason: "Missed session: +\(Self.missedSessionPenaltyPoints) penalty points, \(Self.missedSessionXPDelta) XP, streak reset. No unsafe make-up volume added."
            )
        }

        if log.painLevel >= 4 || log.fatigueLevel >= 9 {
            return ScoreOutcome(
                xpDelta: 20,
                consistencyDelta: 4,
                penaltyDelta: 0,
                streakDelta: 1,
                didTriggerDeload: true,
                reason: "Logged pain or high fatigue. Credit kept, next work auto-deloaded."
            )
        }

        let effortBonus = log.rpe >= 8 ? 20 : 0
        return ScoreOutcome(
            xpDelta: 90 + effortBonus,
            consistencyDelta: 10,
            penaltyDelta: 0,
            streakDelta: 1,
            didTriggerDeload: false,
            reason: "Completed with strict form. XP and consistency climb."
        )
    }

    func rank(for xp: Int) -> CalisthenicsRank {
        CalisthenicsRank.allCases.last(where: { xp >= $0.minimumXP }) ?? .recruit
    }

    private func readinessMultiplier(from baseline: Baseline, goals: GoalTargets, targetDate: Date, weekIndex: Int) -> Double {
        let weeksRemaining = max(1.0, targetDate.timeIntervalSince(Date()) / (7 * 24 * 60 * 60))
        let pullGap = Double(max(goals.pullUps - baseline.pullUps, 1))
        let pushGap = Double(max(goals.pushUps - baseline.pushUps, 1))
        let plankGap = Double(max(goals.plankSeconds - baseline.plankSeconds, 1)) / 10.0
        let pressure = min(1.35, max(0.75, (pullGap + pushGap + plankGap) / weeksRemaining / 4.0))
        return min(1.35, 0.72 + Double(weekIndex) * 0.025 + pressure * 0.20)
    }

    private func shouldScheduleTest(weekIndex: Int, baseline: Baseline, goals: GoalTargets, recentLogs: [SessionLogInput]) -> Bool {
        if weekIndex > 0 && weekIndex % 4 == 0 { return true }
        guard let latest = recentLogs.last else { return false }
        let nearPull = latest.pullUps >= Int(Double(max(baseline.pullUps, 1)) * 1.20)
        let nearPush = latest.pushUps >= Int(Double(max(baseline.pushUps, 1)) * 1.20)
        let nearPlank = latest.plankSeconds >= Int(Double(max(baseline.plankSeconds, 1)) * 1.20)
        return nearPull || nearPush || nearPlank || latest.pullUps >= goals.pullUps || latest.pushUps >= goals.pushUps || latest.plankSeconds >= goals.plankSeconds
    }

    private func focusSequence(count: Int) -> [SessionFocus] {
        let base: [SessionFocus] = [.pull, .push, .core, .mixed, .recovery, .mixed]
        return (0..<count).map { base[$0 % base.count] }
    }

    private func makeSession(
        date: Date,
        index: Int,
        weekIndex: Int,
        focus: SessionFocus,
        baseline: Baseline,
        multiplier: Double,
        equipment: Set<EquipmentKind>,
        deload: Bool
    ) -> TrainingSessionPlan {
        let pullSet = capped(value: Double(max(baseline.pullUps, 1)) * 0.45 * multiplier, minimum: 1, maximum: max(1, Int(Double(max(baseline.pullUps, 1)) * 0.85)))
        let pushSet = capped(value: Double(max(baseline.pushUps, 4)) * 0.40 * multiplier, minimum: 3, maximum: max(3, Int(Double(max(baseline.pushUps, 4)) * 0.75)))
        let plankHold = capped(value: Double(max(baseline.plankSeconds, 20)) * 0.45 * multiplier, minimum: 15, maximum: max(15, Int(Double(max(baseline.plankSeconds, 20)) * 0.80)))
        let workSets = deload ? 3 : 5

        let warmup = WorkoutBlockPlan(
            name: "Warm-up",
            detail: "Joint prep, easy breathing, strict-form rehearsal.",
            sets: [
                ExerciseSetPlan(exercise: .shoulderMobility, sets: 2, reps: 8, seconds: 0, restSeconds: 30, intensity: "Easy"),
                ExerciseSetPlan(exercise: .hollowHold, sets: 2, reps: 0, seconds: 15, restSeconds: 30, intensity: "Controlled")
            ]
        )

        let main: WorkoutBlockPlan
        switch focus {
        case .pull:
            main = WorkoutBlockPlan(
                name: deload ? "Pull Deload" : "Strict Pull Strength",
                detail: "Clean reps only. Stop a set before form breaks.",
                sets: [
                    ExerciseSetPlan(exercise: equipment.contains(.pullUpBar) ? .pullUp : .scapularPull, sets: workSets, reps: pullSet, seconds: 0, restSeconds: 120, intensity: deload ? "Light" : "Hard"),
                    ExerciseSetPlan(exercise: equipment.contains(.pullUpBar) ? .deadHang : .hollowHold, sets: 3, reps: 0, seconds: deload ? 15 : 25, restSeconds: 60, intensity: "Support")
                ]
            )
        case .push:
            main = WorkoutBlockPlan(
                name: deload ? "Push Deload" : "Strict Push Volume",
                detail: "Chest-to-depth standard, locked plank body line.",
                sets: [
                    ExerciseSetPlan(exercise: .pushUp, sets: workSets, reps: pushSet, seconds: 0, restSeconds: 90, intensity: deload ? "Light" : "Hard"),
                    ExerciseSetPlan(exercise: .pikePushUp, sets: 3, reps: max(3, pushSet / 2), seconds: 0, restSeconds: 75, intensity: "Support")
                ]
            )
        case .core:
            main = WorkoutBlockPlan(
                name: deload ? "Core Deload" : "Plank Capacity",
                detail: "No sagging hips, no breath-holding.",
                sets: [
                    ExerciseSetPlan(exercise: .plank, sets: workSets, reps: 0, seconds: plankHold, restSeconds: 90, intensity: deload ? "Light" : "Hard"),
                    ExerciseSetPlan(exercise: .hollowHold, sets: 4, reps: 0, seconds: max(15, plankHold / 2), restSeconds: 60, intensity: "Support")
                ]
            )
        case .mixed:
            main = WorkoutBlockPlan(
                name: deload ? "Mixed Deload" : "Goal Support Circuit",
                detail: "Rotate clean pull, push, and core work without chasing failure.",
                sets: [
                    ExerciseSetPlan(exercise: equipment.contains(.pullUpBar) ? .pullUp : .scapularPull, sets: 4, reps: max(1, pullSet - 1), seconds: 0, restSeconds: 90, intensity: deload ? "Light" : "Moderate"),
                    ExerciseSetPlan(exercise: .pushUp, sets: 4, reps: max(3, pushSet - 2), seconds: 0, restSeconds: 75, intensity: deload ? "Light" : "Moderate"),
                    ExerciseSetPlan(exercise: .plank, sets: 3, reps: 0, seconds: max(15, plankHold - 10), restSeconds: 60, intensity: "Moderate")
                ]
            )
        case .recovery, .easyRun, .longRun, .hillHike, .steadyRun, .recoveryRun:
            main = WorkoutBlockPlan(
                name: "Recovery Debt",
                detail: "Low-risk work. Penalties live in score, not reckless volume.",
                sets: [
                    ExerciseSetPlan(exercise: .shoulderMobility, sets: 3, reps: 10, seconds: 0, restSeconds: 30, intensity: "Easy"),
                    ExerciseSetPlan(exercise: .hollowHold, sets: 3, reps: 0, seconds: 20, restSeconds: 45, intensity: "Easy")
                ]
            )
        }

        let title = "\(focus.title) Session \(index + 1)"
        return TrainingSessionPlan(
            date: date,
            title: title,
            focus: focus,
            weekIndex: weekIndex,
            summary: deload ? "Auto-deloaded from pain/fatigue signals." : "Exact work for strict goal progress.",
            blocks: [warmup, main]
        )
    }

    private func capped(value: Double, minimum: Int, maximum: Int) -> Int {
        min(maximum, max(minimum, Int(value.rounded(.down))))
    }
}

struct UltraRunningEngine {
    func generateWeek(
        start: Date,
        weekIndex: Int,
        profile: RunningTrainingProfile,
        recentRunLogs: [RunningLog],
        strengthSessions: [WorkoutSession] = []
    ) -> UltraWeekPlan {
        let calendar = Calendar.current
        let sessionCount = min(max(profile.weeklyRunSessions, 3), 6)
        let readiness = readinessState(profile: profile, recentRunLogs: recentRunLogs, strengthSessions: strengthSessions)
        let deload = readiness == "Recovery needed"
        let baseWeeklyKm = baselineWeeklyDistance(profile: profile, recentRunLogs: recentRunLogs)
        let abilityCap = weeklyBuildCap(for: profile.durability)
        let targetWeeklyKm = deload ? max(12, baseWeeklyKm * 0.72) : min(baseWeeklyKm * abilityCap, baseWeeklyKm + 6)
        let longRunKm = longRunTarget(profile: profile, targetWeeklyKm: targetWeeklyKm, deload: deload)
        let easyHeartRate = max(95, profile.easyHeartRate)
        let zoneLow = max(90, easyHeartRate - 8)
        let zoneHigh = min(max(profile.thresholdHeartRate - 8, zoneLow + 8), easyHeartRate + 10)
        let easyPace = max(270, profile.easyPaceSecondsPerKm)
        let runWalk = walkGuidance(for: profile)

        var sessions: [RunningSessionPlan] = []
        let days = dayOffsets(count: sessionCount)
        let recoveryKm = max(3, targetWeeklyKm * 0.12)
        let hillKm = max(4, targetWeeklyKm * 0.16)
        let steadyKm = max(5, targetWeeklyKm * 0.18)
        let remainingKm = max(0, targetWeeklyKm - longRunKm - recoveryKm - hillKm - (sessionCount >= 5 ? steadyKm : 0))
        let easySessionCount = max(1, sessionCount - (sessionCount >= 5 ? 4 : 3))
        let easyKm = max(4, remainingKm / Double(easySessionCount))

        sessions.append(makeRunSession(
            date: date(start, days[0], calendar),
            title: deload ? "Easy Reset Run" : "Easy Aerobic Run",
            runType: .easy,
            focus: .easyRun,
            weekIndex: weekIndex,
            distanceKm: easyKm,
            elevationMeters: terrainElevation(profile: profile, distanceKm: easyKm, multiplier: 0.4),
            heartRateLow: zoneLow,
            heartRateHigh: zoneHigh,
            paceSecondsPerKm: easyPace,
            terrain: profile.terrain,
            runWalkStrategy: runWalk,
            purpose: "Build low-intensity frequency while separating endurance background from current run durability.",
            safetyNotes: deload ? "Keep this embarrassingly easy. Stop if pain changes your stride." : "Nose-breathing or full-sentence effort. No pace chasing."
        ))

        if sessionCount >= 4 {
            sessions.append(makeRunSession(
                date: date(start, days[min(1, days.count - 1)], calendar),
                title: "Hill Hike Durability",
                runType: .hillHike,
                focus: .hillHike,
                weekIndex: weekIndex,
                distanceKm: hillKm,
                elevationMeters: max(120, terrainElevation(profile: profile, distanceKm: hillKm, multiplier: 1.4)),
                heartRateLow: zoneLow - 5,
                heartRateHigh: zoneHigh,
                paceSecondsPerKm: easyPace + 120,
                terrain: .hills,
                runWalkStrategy: "Power hike every climb; jog only when HR settles.",
                purpose: "Teach the legs to move uphill efficiently without adding speed stress.",
                safetyNotes: "Walk early, especially on climbs. This is muscular durability, not a threshold workout."
            ))
        }

        if sessionCount >= 5 {
            sessions.append(makeRunSession(
                date: date(start, days[min(2, days.count - 1)], calendar),
                title: deload ? "Short Recovery Shuffle" : "Steady Form Run",
                runType: deload ? .recovery : .steady,
                focus: deload ? .recoveryRun : .steadyRun,
                weekIndex: weekIndex,
                distanceKm: deload ? recoveryKm : steadyKm,
                elevationMeters: terrainElevation(profile: profile, distanceKm: deload ? recoveryKm : steadyKm, multiplier: 0.5),
                heartRateLow: zoneLow,
                heartRateHigh: deload ? zoneHigh : min(profile.thresholdHeartRate - 5, zoneHigh + 8),
                paceSecondsPerKm: deload ? easyPace + 30 : max(270, easyPace - 18),
                terrain: profile.terrain,
                runWalkStrategy: deload ? "Walk as needed to keep pain and HR quiet." : runWalk,
                purpose: deload ? "Keep rhythm without adding fatigue." : "Add a small controlled aerobic stimulus while staying below threshold.",
                safetyNotes: "If HR drifts or form gets noisy, turn it into easy running."
            ))
        }

        let easyIndexStart = sessions.count
        while sessions.count < max(1, sessionCount - 1) {
            let index = sessions.count
            sessions.append(makeRunSession(
                date: date(start, days[min(index, days.count - 1)], calendar),
                title: "Easy Volume Run",
                runType: .easy,
                focus: .easyRun,
                weekIndex: weekIndex,
                distanceKm: easyKm,
                elevationMeters: terrainElevation(profile: profile, distanceKm: easyKm, multiplier: 0.35),
                heartRateLow: zoneLow,
                heartRateHigh: zoneHigh,
                paceSecondsPerKm: easyPace,
                terrain: profile.terrain,
                runWalkStrategy: runWalk,
                purpose: "Accumulate quiet weekly volume. The win is finishing fresh enough to train again.",
                safetyNotes: index == easyIndexStart ? "Keep cadence relaxed and shorten stride on tired legs." : "Stay easy enough that tomorrow is still possible."
            ))
        }

        sessions.append(makeRunSession(
            date: date(start, days.last ?? 6, calendar),
            title: deload ? "Reduced Long Time-on-Feet" : "Long Time-on-Feet",
            runType: .long,
            focus: .longRun,
            weekIndex: weekIndex,
            distanceKm: longRunKm,
            elevationMeters: terrainElevation(profile: profile, distanceKm: longRunKm, multiplier: 1.0),
            heartRateLow: zoneLow - 5,
            heartRateHigh: zoneHigh,
            paceSecondsPerKm: easyPace + 35,
            terrain: profile.terrain,
            runWalkStrategy: runWalk,
            purpose: "Build \(profile.targetRaceKm) km durability through easy time-on-feet, walk discipline, and fueling practice.",
            safetyNotes: "Start slower than ego wants. If pain climbs above 3/10 or gait changes, cut it short and log it honestly."
        ))

        return UltraWeekPlan(
            weekStart: calendar.startOfDay(for: start),
            weekIndex: weekIndex,
            sessions: sessions.sorted { $0.date < $1.date },
            summary: deload
                ? "Ultra deload: pain, fatigue, or strength load says absorb before building."
                : "Ultra base week: mostly easy volume, one durability stimulus, one long time-on-feet run.",
            readiness: readiness
        )
    }

    private func baselineWeeklyDistance(profile: RunningTrainingProfile, recentRunLogs: [RunningLog]) -> Double {
        let cutoff = Calendar.current.date(byAdding: .day, value: -10, to: Date()) ?? Date.distantPast
        let recentKm = recentRunLogs
            .filter { $0.completedAt >= cutoff }
            .map(\.distanceKm)
            .reduce(0, +)
        return max(12, recentKm > 0 ? recentKm : Double(profile.currentWeeklyDistanceKm))
    }

    private func weeklyBuildCap(for durability: RunningDurability) -> Double {
        switch durability {
        case .fragile: 1.06
        case .stable: 1.08
        case .robust: 1.10
        }
    }

    private func longRunTarget(profile: RunningTrainingProfile, targetWeeklyKm: Double, deload: Bool) -> Double {
        let currentLong = max(6, Double(profile.currentLongRunKm))
        let cap = currentLong * (deload ? 0.78 : weeklyBuildCap(for: profile.durability))
        let shareCap = targetWeeklyKm * (profile.durability == .fragile ? 0.34 : 0.38)
        return max(6, min(cap, shareCap))
    }

    private func readinessState(
        profile: RunningTrainingProfile,
        recentRunLogs: [RunningLog],
        strengthSessions: [WorkoutSession]
    ) -> String {
        let lastFive = recentRunLogs.sorted { $0.completedAt > $1.completedAt }.prefix(5)
        if lastFive.contains(where: { $0.painLevel >= 4 || $0.fatigueLevel >= 9 || $0.hadGIIssues }) {
            return "Recovery needed"
        }
        let upcomingStrength = strengthSessions.filter { $0.domain == .strength && $0.status == .planned }.count
        if upcomingStrength >= 4 && profile.durability == .fragile {
            return "Strength load high"
        }
        if recentRunLogs.count < 3 {
            return "Building baseline"
        }
        return "Building"
    }

    private func dayOffsets(count: Int) -> [Int] {
        switch count {
        case 0...3: [0, 3, 6]
        case 4: [0, 2, 4, 6]
        case 5: [0, 1, 3, 5, 6]
        default: [0, 1, 2, 4, 5, 6]
        }
    }

    private func terrainElevation(profile: RunningTrainingProfile, distanceKm: Double, multiplier: Double) -> Int {
        let basePerKm: Double = switch profile.terrain {
        case .flat: 5
        case .rolling: 18
        case .hills: 35
        case .trails: 28
        case .mixed: 20
        }
        return Int((distanceKm * basePerKm * multiplier).rounded())
    }

    private func walkGuidance(for profile: RunningTrainingProfile) -> String {
        let custom = profile.runWalkStrategy.trimmingCharacters(in: .whitespacesAndNewlines)
        switch profile.walkStrategy {
        case .none:
            return "No planned walk breaks; keep effort easy enough to stay conversational."
        case .climbsOnly:
            return "Walk climbs early to keep heart rate controlled."
        case .timed:
            return custom.isEmpty ? "Use planned easy run-walk breaks before fatigue forces them." : custom
        case .custom:
            return custom.isEmpty ? "Use your custom walk strategy and log what happened." : custom
        }
    }

    private func date(_ start: Date, _ offset: Int, _ calendar: Calendar) -> Date {
        calendar.date(byAdding: .day, value: offset, to: calendar.startOfDay(for: start)) ?? start
    }

    private func makeRunSession(
        date: Date,
        title: String,
        runType: RunWorkoutType,
        focus: SessionFocus,
        weekIndex: Int,
        distanceKm: Double,
        elevationMeters: Int,
        heartRateLow: Int,
        heartRateHigh: Int,
        paceSecondsPerKm: Int,
        terrain: RunningTerrain,
        runWalkStrategy: String,
        purpose: String,
        safetyNotes: String
    ) -> RunningSessionPlan {
        let duration = max(20, Int((distanceKm * Double(paceSecondsPerKm) / 60).rounded()))
        return RunningSessionPlan(
            date: date,
            title: title,
            runType: runType,
            focus: focus,
            weekIndex: weekIndex,
            targetDurationMinutes: duration,
            targetDistanceKm: (distanceKm * 10).rounded() / 10,
            targetElevationMeters: elevationMeters,
            targetHeartRateLow: max(80, heartRateLow),
            targetHeartRateHigh: max(heartRateLow + 5, heartRateHigh),
            targetPaceSecondsPerKm: paceSecondsPerKm,
            terrain: terrain,
            runWalkStrategy: runWalkStrategy,
            fuelingPlan: fuelingPlan(forDurationMinutes: duration),
            purpose: purpose,
            safetyNotes: safetyNotes
        )
    }

    private func fuelingPlan(forDurationMinutes minutes: Int) -> String {
        if minutes < 75 {
            return "No forced calories. Bring water if weather or thirst asks for it."
        }
        if minutes < 150 {
            return "Practice 30-50g carbs/hour and steady fluids. Log gut response."
        }
        return "Practice 50-70g carbs/hour, 450-750 ml fluid/hour, and sodium if it is warm or you sweat salty."
    }
}
