import Foundation
import SwiftData

enum ExerciseKind: String, CaseIterable, Codable, Identifiable {
    case pullUp
    case pushUp
    case plank
    case scapularPull
    case hollowHold
    case inclinePushUp
    case pikePushUp
    case deadHang
    case shoulderMobility

    var id: String { rawValue }

    var title: String {
        switch self {
        case .pullUp: "Pull-up"
        case .pushUp: "Push-up"
        case .plank: "Plank"
        case .scapularPull: "Scapular pull"
        case .hollowHold: "Hollow hold"
        case .inclinePushUp: "Incline push-up"
        case .pikePushUp: "Pike push-up"
        case .deadHang: "Dead hang"
        case .shoulderMobility: "Shoulder mobility"
        }
    }
}

enum EquipmentKind: String, CaseIterable, Codable, Identifiable {
    case pullUpBar
    case resistanceBand
    case dipBars
    case dumbbells
    case backpack
    case yogaMat

    var id: String { rawValue }

    var title: String {
        switch self {
        case .pullUpBar: "Pull-up bar"
        case .resistanceBand: "Resistance band"
        case .dipBars: "Dip bars"
        case .dumbbells: "Dumbbells"
        case .backpack: "Loaded backpack"
        case .yogaMat: "Yoga mat"
        }
    }
}

enum TrainingWeekday: String, CaseIterable, Codable, Identifiable {
    case monday
    case tuesday
    case wednesday
    case thursday
    case friday
    case saturday
    case sunday

    var id: String { rawValue }

    var title: String {
        switch self {
        case .monday: "Monday"
        case .tuesday: "Tuesday"
        case .wednesday: "Wednesday"
        case .thursday: "Thursday"
        case .friday: "Friday"
        case .saturday: "Saturday"
        case .sunday: "Sunday"
        }
    }

    var shortTitle: String {
        switch self {
        case .monday: "Mo"
        case .tuesday: "Tu"
        case .wednesday: "We"
        case .thursday: "Th"
        case .friday: "Fr"
        case .saturday: "Sa"
        case .sunday: "Su"
        }
    }

    var calendarWeekday: Int {
        switch self {
        case .sunday: 1
        case .monday: 2
        case .tuesday: 3
        case .wednesday: 4
        case .thursday: 5
        case .friday: 6
        case .saturday: 7
        }
    }

    static func defaultTrainingDays(for sessionCount: Int) -> Set<TrainingWeekday> {
        let ordered: [TrainingWeekday]
        switch sessionCount {
        case 1:
            ordered = [.monday]
        case 2:
            ordered = [.monday, .thursday]
        case 3:
            ordered = [.monday, .wednesday, .saturday]
        case 4:
            ordered = [.monday, .wednesday, .friday, .saturday]
        case 5:
            ordered = [.monday, .tuesday, .thursday, .friday, .saturday]
        case 6:
            ordered = [.monday, .tuesday, .wednesday, .thursday, .friday, .saturday]
        default:
            ordered = Array(Self.allCases.prefix(max(1, min(6, sessionCount))))
        }
        return Set(ordered)
    }

    static func normalized(_ days: Set<TrainingWeekday>, weeklySessions: Int) -> [TrainingWeekday] {
        let selected = days.isEmpty ? defaultTrainingDays(for: weeklySessions) : days
        let capped = selected.intersection(Self.allCases)
        let limited: Set<TrainingWeekday>
        if capped.count > 6 {
            limited = Set(Self.allCases.prefix(6))
        } else {
            limited = capped
        }
        return Self.allCases.filter { limited.contains($0) }
    }

    static func dayOffsets(for days: Set<TrainingWeekday>, weeklySessions: Int, weekStart: Date, calendar: Calendar = .current) -> [Int] {
        let startWeekday = calendar.component(.weekday, from: calendar.startOfDay(for: weekStart))
        return normalized(days, weeklySessions: weeklySessions)
            .map { ($0.calendarWeekday - startWeekday + 7) % 7 }
            .sorted()
    }

    static func storageValue(for days: Set<TrainingWeekday>, weeklySessions: Int) -> String {
        normalized(days, weeklySessions: weeklySessions)
            .map(\.rawValue)
            .joined(separator: ",")
    }
}

enum SessionStatus: String, Codable {
    case planned
    case completed
    case missed
    case deload
}

enum SessionFocus: String, Codable {
    case pull
    case push
    case core
    case mixed
    case recovery

    var title: String { rawValue.capitalized }
}

enum RunningWorkoutKind: String, CaseIterable, Codable, Identifiable {
    case easy
    case long
    case recovery
    case hills
    case tempo
    case intervals

    var id: String { rawValue }

    var title: String {
        switch self {
        case .easy: "Easy Run"
        case .long: "Long Run"
        case .recovery: "Recovery Run"
        case .hills: "Hill Session"
        case .tempo: "Tempo Run"
        case .intervals: "Intervals"
        }
    }
}

enum RunningWorkoutStatus: String, Codable {
    case planned
    case completed
    case missed
}

enum LockinAchievementKind: String, CaseIterable, Codable, Identifiable {
    case consistencyKing
    case earlyRiser
    case unbroken
    case plankMaster

    var id: String { rawValue }

    var title: String {
        switch self {
        case .consistencyKing: "Consistency King"
        case .earlyRiser: "Early Riser"
        case .unbroken: "Unbroken"
        case .plankMaster: "Plank Master"
        }
    }

    var detail: String {
        switch self {
        case .consistencyKing: "Train 14 days in a row"
        case .earlyRiser: "Log a workout before 8am"
        case .unbroken: "Complete 50 pull-ups in a day"
        case .plankMaster: "Hold a 5 minute plank"
        }
    }

    var target: Int {
        switch self {
        case .consistencyKing: 14
        case .earlyRiser: 1
        case .unbroken: 50
        case .plankMaster: 300
        }
    }
}

enum PlanSource: String, Codable {
    case rules
    case ai
}

enum ValidationStatus: String, Codable {
    case accepted
    case clamped
    case rejected
}

@Model
final class UserProfile {
    var id: UUID = UUID()
    var createdAt: Date = Date()
    var name: String = "Athlete"
    var targetDate: Date = Date()
    var weeklySessions: Int = 4
    var trainingDaysRaw: String = ""
    var sessionMinutes: Int = 0
    var equipmentRaw: String = ""
    var baselinePullUps: Int = 0
    var baselinePushUps: Int = 0
    var baselinePlankSeconds: Int = 0
    var goalPullUps: Int = 50
    var goalPushUps: Int = 100
    var goalPlankSeconds: Int = 300
    var strictFormAccepted: Bool = true
    var remindersEnabled: Bool = true
    var painNotes: String = ""

    init(
        id: UUID = UUID(),
        createdAt: Date = Date(),
        name: String = "Athlete",
        targetDate: Date,
        weeklySessions: Int,
        trainingDays: Set<TrainingWeekday> = [],
        sessionMinutes: Int = 0,
        equipment: Set<EquipmentKind>,
        baselinePullUps: Int,
        baselinePushUps: Int,
        baselinePlankSeconds: Int,
        goalPullUps: Int = 50,
        goalPushUps: Int = 100,
        goalPlankSeconds: Int = 300,
        strictFormAccepted: Bool = true,
        remindersEnabled: Bool = true,
        painNotes: String = ""
    ) {
        self.id = id
        self.createdAt = createdAt
        self.name = name
        self.targetDate = targetDate
        let boundedWeeklySessions = max(1, min(6, weeklySessions))
        let resolvedTrainingDays = Set(TrainingWeekday.normalized(trainingDays, weeklySessions: boundedWeeklySessions))
        self.weeklySessions = resolvedTrainingDays.count
        self.trainingDaysRaw = TrainingWeekday.storageValue(for: resolvedTrainingDays, weeklySessions: self.weeklySessions)
        self.sessionMinutes = sessionMinutes
        self.equipmentRaw = equipment.map(\.rawValue).sorted().joined(separator: ",")
        self.baselinePullUps = baselinePullUps
        self.baselinePushUps = baselinePushUps
        self.baselinePlankSeconds = baselinePlankSeconds
        self.goalPullUps = goalPullUps
        self.goalPushUps = goalPushUps
        self.goalPlankSeconds = goalPlankSeconds
        self.strictFormAccepted = strictFormAccepted
        self.remindersEnabled = remindersEnabled
        self.painNotes = painNotes
    }

    var equipment: Set<EquipmentKind> {
        Set(equipmentRaw.split(separator: ",").compactMap { EquipmentKind(rawValue: String($0)) })
    }

    var trainingDays: Set<TrainingWeekday> {
        let parsed = Set(trainingDaysRaw.split(separator: ",").compactMap { TrainingWeekday(rawValue: String($0)) })
        return parsed.isEmpty ? TrainingWeekday.defaultTrainingDays(for: weeklySessions) : parsed
    }

    var trainingDayLabels: [String] {
        TrainingWeekday.normalized(trainingDays, weeklySessions: weeklySessions).map(\.shortTitle)
    }
}

@Model
final class WorkoutSession {
    var id: UUID = UUID()
    var scheduledDate: Date = Date()
    var title: String = ""
    var weekIndex: Int = 0
    var focusRaw: String = SessionFocus.mixed.rawValue
    var statusRaw: String = SessionStatus.planned.rawValue
    var scoreImpact: Int = 0
    var summary: String = ""
    var createdAt: Date = Date()

    init(
        id: UUID = UUID(),
        scheduledDate: Date,
        title: String,
        weekIndex: Int,
        focus: SessionFocus,
        status: SessionStatus = .planned,
        scoreImpact: Int = 0,
        summary: String,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.scheduledDate = scheduledDate
        self.title = title
        self.weekIndex = weekIndex
        self.focusRaw = focus.rawValue
        self.statusRaw = status.rawValue
        self.scoreImpact = scoreImpact
        self.summary = summary
        self.createdAt = createdAt
    }

    var focus: SessionFocus { SessionFocus(rawValue: focusRaw) ?? .mixed }
    var status: SessionStatus {
        get { SessionStatus(rawValue: statusRaw) ?? .planned }
        set { statusRaw = newValue.rawValue }
    }
}

@Model
final class WorkoutBlock {
    var id: UUID = UUID()
    var sessionId: UUID = UUID()
    var orderIndex: Int = 0
    var name: String = ""
    var detail: String = ""

    init(id: UUID = UUID(), sessionId: UUID, orderIndex: Int, name: String, detail: String) {
        self.id = id
        self.sessionId = sessionId
        self.orderIndex = orderIndex
        self.name = name
        self.detail = detail
    }
}

@Model
final class SetPrescription {
    var id: UUID = UUID()
    var sessionId: UUID = UUID()
    var blockId: UUID = UUID()
    var orderIndex: Int = 0
    var exerciseRaw: String = ExerciseKind.pullUp.rawValue
    var sets: Int = 0
    var targetReps: Int = 0
    var targetSeconds: Int = 0
    var restSeconds: Int = 0
    var intensity: String = ""

    init(
        id: UUID = UUID(),
        sessionId: UUID,
        blockId: UUID,
        orderIndex: Int,
        exercise: ExerciseKind,
        sets: Int,
        targetReps: Int = 0,
        targetSeconds: Int = 0,
        restSeconds: Int,
        intensity: String
    ) {
        self.id = id
        self.sessionId = sessionId
        self.blockId = blockId
        self.orderIndex = orderIndex
        self.exerciseRaw = exercise.rawValue
        self.sets = sets
        self.targetReps = targetReps
        self.targetSeconds = targetSeconds
        self.restSeconds = restSeconds
        self.intensity = intensity
    }

    var exercise: ExerciseKind { ExerciseKind(rawValue: exerciseRaw) ?? .pullUp }
}

@Model
final class PerformanceLog {
    var id: UUID = UUID()
    var sessionId: UUID = UUID()
    var completedAt: Date = Date()
    var pullUps: Int = 0
    var pushUps: Int = 0
    var plankSeconds: Int = 0
    var loggedPullUps: Bool = true
    var loggedPushUps: Bool = true
    var loggedPlankSeconds: Bool = true
    var rpe: Int = 7
    var painLevel: Int = 0
    var fatigueLevel: Int = 5
    var notes: String = ""

    init(
        id: UUID = UUID(),
        sessionId: UUID,
        completedAt: Date = Date(),
        pullUps: Int,
        pushUps: Int,
        plankSeconds: Int,
        loggedPullUps: Bool = true,
        loggedPushUps: Bool = true,
        loggedPlankSeconds: Bool = true,
        rpe: Int,
        painLevel: Int,
        fatigueLevel: Int,
        notes: String
    ) {
        self.id = id
        self.sessionId = sessionId
        self.completedAt = completedAt
        self.pullUps = pullUps
        self.pushUps = pushUps
        self.plankSeconds = plankSeconds
        self.loggedPullUps = loggedPullUps
        self.loggedPushUps = loggedPushUps
        self.loggedPlankSeconds = loggedPlankSeconds
        self.rpe = rpe
        self.painLevel = painLevel
        self.fatigueLevel = fatigueLevel
        self.notes = notes
    }
}

@Model
final class RunningProfile {
    var id: UUID = UUID()
    var createdAt: Date = Date()
    var targetRaceName: String = "Comrades Marathon"
    var raceDate: Date = Date()
    var weeklyDistanceTargetKm: Double = 42
    var longRunTargetKm: Double = 28
    var easyPaceSecondsPerKm: Int = 360
    var preferredTerrain: String = "Road and trail"
    var injuryNotes: String = ""
    var runningDaysRaw: String = ""

    init(
        id: UUID = UUID(),
        createdAt: Date = Date(),
        targetRaceName: String = "Comrades Marathon",
        raceDate: Date,
        weeklyDistanceTargetKm: Double = 42,
        longRunTargetKm: Double = 28,
        easyPaceSecondsPerKm: Int = 360,
        preferredTerrain: String = "Road and trail",
        injuryNotes: String = "",
        runningDays: Set<TrainingWeekday> = TrainingWeekday.defaultTrainingDays(for: 4)
    ) {
        self.id = id
        self.createdAt = createdAt
        self.targetRaceName = targetRaceName
        self.raceDate = raceDate
        self.weeklyDistanceTargetKm = weeklyDistanceTargetKm
        self.longRunTargetKm = longRunTargetKm
        self.easyPaceSecondsPerKm = easyPaceSecondsPerKm
        self.preferredTerrain = preferredTerrain
        self.injuryNotes = injuryNotes
        self.runningDaysRaw = TrainingWeekday.storageValue(for: runningDays, weeklySessions: runningDays.count)
    }

    var runningDays: Set<TrainingWeekday> {
        get {
            let parsed = Set(runningDaysRaw.split(separator: ",").compactMap { TrainingWeekday(rawValue: String($0)) })
            return parsed.isEmpty ? TrainingWeekday.defaultTrainingDays(for: 4) : parsed
        }
        set {
            let resolved = newValue.isEmpty ? TrainingWeekday.defaultTrainingDays(for: 4) : newValue
            runningDaysRaw = TrainingWeekday.storageValue(for: resolved, weeklySessions: resolved.count)
        }
    }

    var runningDayLabels: [String] {
        TrainingWeekday.normalized(runningDays, weeklySessions: runningDays.count).map(\.shortTitle)
    }
}

@Model
final class RunningWorkout {
    var id: UUID = UUID()
    var scheduledDate: Date = Date()
    var title: String = ""
    var kindRaw: String = RunningWorkoutKind.easy.rawValue
    var statusRaw: String = RunningWorkoutStatus.planned.rawValue
    var distanceKm: Double = 0
    var durationSeconds: Int = 0
    var elevationMeters: Int = 0
    var zone: String = ""
    var notes: String = ""
    var createdAt: Date = Date()

    init(
        id: UUID = UUID(),
        scheduledDate: Date,
        title: String,
        kind: RunningWorkoutKind,
        status: RunningWorkoutStatus = .planned,
        distanceKm: Double,
        durationSeconds: Int,
        elevationMeters: Int,
        zone: String,
        notes: String = "",
        createdAt: Date = Date()
    ) {
        self.id = id
        self.scheduledDate = scheduledDate
        self.title = title
        self.kindRaw = kind.rawValue
        self.statusRaw = status.rawValue
        self.distanceKm = distanceKm
        self.durationSeconds = durationSeconds
        self.elevationMeters = elevationMeters
        self.zone = zone
        self.notes = notes
        self.createdAt = createdAt
    }

    var kind: RunningWorkoutKind {
        get { RunningWorkoutKind(rawValue: kindRaw) ?? .easy }
        set { kindRaw = newValue.rawValue }
    }

    var status: RunningWorkoutStatus {
        get { RunningWorkoutStatus(rawValue: statusRaw) ?? .planned }
        set { statusRaw = newValue.rawValue }
    }
}

@Model
final class RunningLog {
    var id: UUID = UUID()
    var workoutId: UUID = UUID()
    var completedAt: Date = Date()
    var distanceKm: Double = 0
    var durationSeconds: Int = 0
    var elevationMeters: Int = 0
    var averageHeartRate: Int = 0
    var calories: Int = 0
    var carbsGrams: Int = 0
    var fluidMl: Int = 0
    var sodiumMg: Int = 0
    var notes: String = ""

    init(
        id: UUID = UUID(),
        workoutId: UUID,
        completedAt: Date = Date(),
        distanceKm: Double,
        durationSeconds: Int,
        elevationMeters: Int,
        averageHeartRate: Int = 0,
        calories: Int = 0,
        carbsGrams: Int = 0,
        fluidMl: Int = 0,
        sodiumMg: Int = 0,
        notes: String = ""
    ) {
        self.id = id
        self.workoutId = workoutId
        self.completedAt = completedAt
        self.distanceKm = distanceKm
        self.durationSeconds = durationSeconds
        self.elevationMeters = elevationMeters
        self.averageHeartRate = averageHeartRate
        self.calories = calories
        self.carbsGrams = carbsGrams
        self.fluidMl = fluidMl
        self.sodiumMg = sodiumMg
        self.notes = notes
    }
}

@Model
final class RankState {
    var id: UUID = UUID()
    var consistencyScore: Int = 0
    var streak: Int = 0
    var bestStreak: Int = 0
    var penaltyPoints: Int = 0
    var updatedAt: Date = Date()

    init(
        id: UUID = UUID(),
        consistencyScore: Int = 0,
        streak: Int = 0,
        bestStreak: Int = 0,
        penaltyPoints: Int = 0,
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.consistencyScore = consistencyScore
        self.streak = streak
        self.bestStreak = bestStreak
        self.penaltyPoints = penaltyPoints
        self.updatedAt = updatedAt
    }
}

@Model
final class AchievementState {
    var id: UUID = UUID()
    var kindRaw: String = LockinAchievementKind.consistencyKing.rawValue
    var progress: Int = 0
    var completedAt: Date?
    var updatedAt: Date = Date()

    init(
        id: UUID = UUID(),
        kind: LockinAchievementKind,
        progress: Int = 0,
        completedAt: Date? = nil,
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.kindRaw = kind.rawValue
        self.progress = progress
        self.completedAt = completedAt
        self.updatedAt = updatedAt
    }

    var kind: LockinAchievementKind {
        get { LockinAchievementKind(rawValue: kindRaw) ?? .consistencyKing }
        set { kindRaw = newValue.rawValue }
    }
}

@Model
final class CoachPlan {
    var id: UUID = UUID()
    var weekStart: Date = Date()
    var summary: String = ""
    var sourceRaw: String = PlanSource.rules.rawValue
    var validationStatusRaw: String = ValidationStatus.accepted.rawValue
    var generatedAt: Date = Date()

    init(
        id: UUID = UUID(),
        weekStart: Date,
        summary: String,
        source: PlanSource,
        validationStatus: ValidationStatus,
        generatedAt: Date = Date()
    ) {
        self.id = id
        self.weekStart = weekStart
        self.summary = summary
        self.sourceRaw = source.rawValue
        self.validationStatusRaw = validationStatus.rawValue
        self.generatedAt = generatedAt
    }
}

@Model
final class CoachDecision {
    var id: UUID = UUID()
    var planId: UUID = UUID()
    var createdAt: Date = Date()
    var rationale: String = ""
    var safetyFlagsRaw: String = ""

    init(id: UUID = UUID(), planId: UUID, createdAt: Date = Date(), rationale: String, safetyFlags: [String]) {
        self.id = id
        self.planId = planId
        self.createdAt = createdAt
        self.rationale = rationale
        self.safetyFlagsRaw = safetyFlags.joined(separator: "|")
    }
}

@Model
final class CoachVerdict {
    var id: UUID = UUID()
    var createdAt: Date = Date()
    var sourceLogIdRaw: String = ""
    var headline: String = ""
    var summary: String = ""
    var latestChange: String = ""
    var recommendation: String = ""
    var shouldUpdatePlan: Bool = false
    var contextState: String = ""
    var safetyFlagsRaw: String = ""

    init(
        id: UUID = UUID(),
        createdAt: Date = Date(),
        sourceLogId: UUID?,
        headline: String,
        summary: String,
        latestChange: String,
        recommendation: String,
        shouldUpdatePlan: Bool,
        contextState: String,
        safetyFlags: [String]
    ) {
        self.id = id
        self.createdAt = createdAt
        self.sourceLogIdRaw = sourceLogId?.uuidString ?? ""
        self.headline = headline
        self.summary = summary
        self.latestChange = latestChange
        self.recommendation = recommendation
        self.shouldUpdatePlan = shouldUpdatePlan
        self.contextState = contextState
        self.safetyFlagsRaw = safetyFlags.joined(separator: "|")
    }

    convenience init(response: CoachVerdictResponse, sourceLogId: UUID?) {
        self.init(
            sourceLogId: sourceLogId,
            headline: response.headline,
            summary: response.summary,
            latestChange: response.latestChange,
            recommendation: response.recommendation,
            shouldUpdatePlan: response.shouldUpdatePlan,
            contextState: response.contextState,
            safetyFlags: response.safetyFlags
        )
    }

    var sourceLogId: UUID? {
        UUID(uuidString: sourceLogIdRaw)
    }

    var safetyFlags: [String] {
        safetyFlagsRaw.split(separator: "|").map(String.init)
    }
}

struct RealWorldBenchmark: Identifiable {
    let id = UUID()
    let title: String
    let value: String
    let detail: String
    let sourceLabel: String
    let sourceURL: String

    static let examples = [
        RealWorldBenchmark(
            title: "USMC pull-up PFT max",
            value: "20-23 men / 4-12 women",
            detail: "Official perfect-score pull-up targets vary by age and sex. A 50-pull-up goal is far above standard military max-score tables.",
            sourceLabel: "Marine Corps scoring table",
            sourceURL: "https://www.fitness.marines.mil/Portals/211/Docs/PFT_CFT/PFT_CFT%20Standards/Table%202-2%20Hybrid%20Pull-up%20Push-up%20Test%20Scoring%20Tables.pdf"
        ),
        RealWorldBenchmark(
            title: "USMC plank PFT max",
            value: "3:45",
            detail: "The Marine Corps plank score is age and gender neutral. Your 5:00 plank goal is beyond the current max-score standard.",
            sourceLabel: "Marine Corps plank table",
            sourceURL: "https://www.fitness.marines.mil/Portals/211/Docs/PFT_CFT/PFT_CFT%20Standards/Plank%20Scoring%20Table.pdf?ver=qjyQlKiDx7i5hVOH6DCfkw%3D%3D"
        ),
        RealWorldBenchmark(
            title: "ExRx strength tiers",
            value: "Frail to Elite",
            detail: "Bodyweight strength comparisons depend on age, sex, body weight, and strict form, so the app treats them as external references instead of consistency scores.",
            sourceLabel: "ExRx strength standards",
            sourceURL: "https://exrx.net/WorkoutTools/StrengthStandards"
        )
    ]
}
