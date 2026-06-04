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
    var trainingDays: Set<TrainingWeekday> = []
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
    var plannedEffort: PlannedEffort = .medium()
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
    var plannedEffort: PlannedEffort = .medium()
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

struct TrainingEngine {
    static let defaultGoals = GoalTargets(pullUps: 50, pushUps: 100, plankSeconds: 300)
    static let missedSessionPenaltyPoints = 25
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
        let selectedDayOffsets = preferences.trainingDays.isEmpty
            ? []
            : TrainingWeekday.dayOffsets(for: preferences.trainingDays, weeklySessions: sessionCount, weekStart: start)

        let sessions = (0..<sessionCount).map { index in
            let offset = selectedDayOffsets.indices.contains(index) ? selectedDayOffsets[index] : index * max(1, 7 / sessionCount)
            let date = Calendar.current.date(byAdding: .day, value: offset, to: start) ?? start
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
            summary: deload ? "Deload week: your pain or how-you-felt signal says training stress drops." : "Adaptive build week: exact volume, strict form, no junk reps.",
            shouldTest: shouldScheduleTest(weekIndex: weekIndex, baseline: baseline, goals: goals, recentLogs: recentLogs)
        )
    }

    func score(log: SessionLogInput, plannedSession: TrainingSessionPlan?) -> ScoreOutcome {
        guard log.completed else {
            return ScoreOutcome(
                consistencyDelta: Self.missedSessionConsistencyDelta,
                penaltyDelta: Self.missedSessionPenaltyPoints,
                streakDelta: -1,
                didTriggerDeload: false,
                reason: "Missed training recorded. Streak reset, with no unsafe make-up volume added."
            )
        }

        if log.painLevel >= 4 || log.fatigueLevel >= 9 {
            return ScoreOutcome(
                consistencyDelta: 4,
                penaltyDelta: 0,
                streakDelta: 1,
                didTriggerDeload: true,
                reason: "Logged pain or Very weak how-you-felt feedback. Credit kept, next work auto-deloaded."
            )
        }

        let effortBonus = log.rpe >= 8 ? 20 : 0
        return ScoreOutcome(
            consistencyDelta: 10 + effortBonus / 10,
            penaltyDelta: 0,
            streakDelta: 1,
            didTriggerDeload: false,
            reason: "Completed with strict form. Streak updated."
        )
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
        let pullSet = capped(value: Double(max(baseline.pullUps, 1)) * 0.50 * multiplier, minimum: 1, maximum: max(1, Int(Double(max(baseline.pullUps, 1)) * 0.85)))
        let pushSet = capped(value: Double(max(baseline.pushUps, 4)) * 0.55 * multiplier, minimum: 3, maximum: max(3, Int(Double(max(baseline.pushUps, 4)) * 0.75)))
        let plankHold = capped(value: Double(max(baseline.plankSeconds, 20)) * 0.50 * multiplier, minimum: 15, maximum: max(15, Int(Double(max(baseline.plankSeconds, 20)) * 0.80)))
        let workSets = deload ? 3 : 5
        let mainEffort = deload
            ? PlannedEffort.light("Deloaded because pain or how-you-felt signals need lower stress.")
            : PlannedEffort.hard("Hard enough to move the goal while leaving clean reps in reserve.")
        let supportEffort = deload
            ? PlannedEffort.light("Easy support work while recovering.")
            : PlannedEffort.medium("Useful support volume without chasing failure.")

        let warmup = WorkoutBlockPlan(
            name: "Warm-up",
            detail: "Joint prep, easy breathing, strict-form rehearsal.",
            sets: [
                ExerciseSetPlan(exercise: .shoulderMobility, sets: 2, reps: 8, seconds: 0, restSeconds: 30, intensity: "Easy", plannedEffort: .light("Warm-up effort before goal work.")),
                ExerciseSetPlan(exercise: .hollowHold, sets: 2, reps: 0, seconds: 15, restSeconds: 30, intensity: "Controlled", plannedEffort: .light("Controlled trunk prep, not a max hold."))
            ]
        )

        let main: WorkoutBlockPlan
        switch focus {
        case .pull:
            main = WorkoutBlockPlan(
                name: deload ? "Pull Deload" : "Strict Pull Strength",
                detail: "Clean reps only. Stop a set before form breaks.",
                sets: [
                    ExerciseSetPlan(exercise: equipment.contains(.pullUpBar) ? .pullUp : .scapularPull, sets: workSets, reps: pullSet, seconds: 0, restSeconds: 120, intensity: deload ? "Light" : "Hard", plannedEffort: mainEffort),
                    ExerciseSetPlan(exercise: equipment.contains(.pullUpBar) ? .deadHang : .hollowHold, sets: 3, reps: 0, seconds: deload ? 15 : 25, restSeconds: 60, intensity: "Support", plannedEffort: supportEffort)
                ]
            )
        case .push:
            main = WorkoutBlockPlan(
                name: deload ? "Push Deload" : "Strict Push Volume",
                detail: "Chest-to-depth standard, locked plank body line.",
                sets: [
                    ExerciseSetPlan(exercise: .pushUp, sets: workSets, reps: pushSet, seconds: 0, restSeconds: 90, intensity: deload ? "Light" : "Hard", plannedEffort: mainEffort),
                    ExerciseSetPlan(exercise: .pikePushUp, sets: 3, reps: max(3, pushSet / 2), seconds: 0, restSeconds: 75, intensity: "Support", plannedEffort: supportEffort)
                ]
            )
        case .core:
            main = WorkoutBlockPlan(
                name: deload ? "Core Deload" : "Plank Capacity",
                detail: "No sagging hips, no breath-holding.",
                sets: [
                    ExerciseSetPlan(exercise: .plank, sets: workSets, reps: 0, seconds: plankHold, restSeconds: 90, intensity: deload ? "Light" : "Hard", plannedEffort: mainEffort),
                    ExerciseSetPlan(exercise: .hollowHold, sets: 4, reps: 0, seconds: max(15, plankHold / 2), restSeconds: 60, intensity: "Support", plannedEffort: supportEffort)
                ]
            )
        case .mixed:
            main = WorkoutBlockPlan(
                name: deload ? "Mixed Deload" : "Goal Support Circuit",
                detail: "Rotate clean pull, push, and core work without chasing failure.",
                sets: [
                    ExerciseSetPlan(exercise: equipment.contains(.pullUpBar) ? .pullUp : .scapularPull, sets: 4, reps: max(1, pullSet - 1), seconds: 0, restSeconds: 90, intensity: deload ? "Light" : "Moderate", plannedEffort: deload ? mainEffort : supportEffort),
                    ExerciseSetPlan(exercise: .pushUp, sets: 4, reps: max(3, pushSet - 2), seconds: 0, restSeconds: 75, intensity: deload ? "Light" : "Moderate", plannedEffort: deload ? mainEffort : supportEffort),
                    ExerciseSetPlan(exercise: .plank, sets: 3, reps: 0, seconds: max(15, plankHold - 10), restSeconds: 60, intensity: "Moderate", plannedEffort: supportEffort)
                ]
            )
        case .recovery:
            main = WorkoutBlockPlan(
                name: "Recovery Debt",
                detail: "Low-risk work after missed training, without chasing make-up volume.",
                sets: [
                    ExerciseSetPlan(exercise: .shoulderMobility, sets: 3, reps: 10, seconds: 0, restSeconds: 30, intensity: "Easy", plannedEffort: .light("Recovery work, not goal stress.")),
                    ExerciseSetPlan(exercise: .hollowHold, sets: 3, reps: 0, seconds: 20, restSeconds: 45, intensity: "Easy", plannedEffort: .light("Easy trunk work after missed training."))
                ]
            )
        }

        let title = "\(focus.title) Session \(index + 1)"
        return TrainingSessionPlan(
            date: date,
            title: title,
            focus: focus,
            weekIndex: weekIndex,
            summary: deload ? "Auto-deloaded from pain/how-you-felt signals." : "Exact work for strict goal progress.",
            plannedEffort: focus == .recovery ? .light("Recovery session keeps the habit without hard stress.") : mainEffort,
            blocks: [warmup, main]
        )
    }

    private func capped(value: Double, minimum: Int, maximum: Int) -> Int {
        min(maximum, max(minimum, Int(value.rounded(.down))))
    }
}
