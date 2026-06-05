import Foundation
import SwiftData

enum PlannedEffortLabel: String, CaseIterable, Codable {
    case light
    case medium
    case hard
    case veryHard = "very_hard"
    case maxOutput = "max_output"

    var title: String {
        switch self {
        case .light: "Light"
        case .medium: "Medium"
        case .hard: "Hard"
        case .veryHard: "Very hard"
        case .maxOutput: "Max output"
        }
    }

    var defaultTargetRPE: Int {
        switch self {
        case .light: 3
        case .medium: 6
        case .hard: 7
        case .veryHard: 9
        case .maxOutput: 10
        }
    }

    static func fromRPE(_ value: Int) -> PlannedEffortLabel {
        switch value {
        case ...4: .light
        case 5...6: .medium
        case 7...8: .hard
        case 9: .veryHard
        default: .maxOutput
        }
    }

    static func fromLegacyIntensity(_ value: String) -> PlannedEffortLabel? {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalized.contains("max") { return .maxOutput }
        if normalized.contains("very hard") || normalized.contains("near") { return .veryHard }
        if normalized.contains("hard") || normalized.contains("challeng") || normalized.contains("difficult") || normalized.contains("high") { return .hard }
        if normalized.contains("moderate") || normalized.contains("medium") || normalized.contains("controlled") || normalized.contains("support") { return .medium }
        if normalized.contains("light") || normalized.contains("easy") || normalized.contains("recovery") || normalized.contains("warm") { return .light }
        return nil
    }
}

enum EffortStimulus: String, CaseIterable, Codable {
    case recovery
    case technique
    case volume
    case strength
    case test
}

struct PlannedEffort: Equatable {
    var label: PlannedEffortLabel
    var targetRPE: Int
    var targetRIR: Int
    var stimulus: EffortStimulus
    var reason: String

    static func light(_ reason: String = "Easy support work.") -> PlannedEffort {
        PlannedEffort(label: .light, targetRPE: 3, targetRIR: 6, stimulus: .technique, reason: reason)
    }

    static func medium(_ reason: String = "Repeatable capacity work.") -> PlannedEffort {
        PlannedEffort(label: .medium, targetRPE: 6, targetRIR: 4, stimulus: .volume, reason: reason)
    }

    static func hard(_ reason: String = "Productive goal stimulus.") -> PlannedEffort {
        PlannedEffort(label: .hard, targetRPE: 7, targetRIR: 3, stimulus: .strength, reason: reason)
    }
}

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
        return Self.allCases.filter { capped.contains($0) }.prefix(6).map { $0 }
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
    var sessionMinutes: Int = 0
    var trainingDaysRaw: String = ""
    var equipmentRaw: String = ""
    var baselinePullUps: Int = 0
    var baselinePushUps: Int = 0
    var baselinePlankSeconds: Int = 0
    var goalPullUps: Int = 50
    var goalPushUps: Int = 100
    var goalPlankSeconds: Int = 300
    var strictFormAccepted: Bool = true
    var remindersEnabled: Bool = false
    var reminderHour: Int = 9
    var reminderMinute: Int = 0
    var painNotes: String = ""

    init(
        id: UUID = UUID(),
        createdAt: Date = Date(),
        name: String = "Athlete",
        targetDate: Date,
        weeklySessions: Int,
        sessionMinutes: Int = 0,
        trainingDays: Set<TrainingWeekday> = [],
        equipment: Set<EquipmentKind>,
        baselinePullUps: Int,
        baselinePushUps: Int,
        baselinePlankSeconds: Int,
        goalPullUps: Int = 50,
        goalPushUps: Int = 100,
        goalPlankSeconds: Int = 300,
        strictFormAccepted: Bool = true,
        remindersEnabled: Bool = false,
        reminderHour: Int = 9,
        reminderMinute: Int = 0,
        painNotes: String = ""
    ) {
        self.id = id
        self.createdAt = createdAt
        self.name = name
        self.targetDate = targetDate
        self.weeklySessions = weeklySessions
        self.sessionMinutes = sessionMinutes
        let resolvedTrainingDays = trainingDays.isEmpty ? TrainingWeekday.defaultTrainingDays(for: weeklySessions) : trainingDays
        self.trainingDaysRaw = TrainingWeekday.storageValue(for: resolvedTrainingDays, weeklySessions: weeklySessions)
        self.equipmentRaw = equipment.map(\.rawValue).sorted().joined(separator: ",")
        self.baselinePullUps = baselinePullUps
        self.baselinePushUps = baselinePushUps
        self.baselinePlankSeconds = baselinePlankSeconds
        self.goalPullUps = goalPullUps
        self.goalPushUps = goalPushUps
        self.goalPlankSeconds = goalPlankSeconds
        self.strictFormAccepted = strictFormAccepted
        self.remindersEnabled = remindersEnabled
        self.reminderHour = Self.normalizedReminderHour(reminderHour)
        self.reminderMinute = Self.normalizedReminderMinute(reminderMinute)
        self.painNotes = painNotes
    }

    var equipment: Set<EquipmentKind> {
        Set(equipmentRaw.split(separator: ",").compactMap { EquipmentKind(rawValue: String($0)) })
    }

    var trainingDays: Set<TrainingWeekday> {
        get {
            let parsed = Set(trainingDaysRaw.split(separator: ",").compactMap { TrainingWeekday(rawValue: String($0)) })
            return Set(TrainingWeekday.normalized(parsed, weeklySessions: weeklySessions))
        }
        set {
            let resolved = Set(TrainingWeekday.normalized(newValue, weeklySessions: newValue.count))
            weeklySessions = resolved.count
            trainingDaysRaw = TrainingWeekday.storageValue(for: resolved, weeklySessions: weeklySessions)
        }
    }

    var trainingDayLabels: [String] {
        TrainingWeekday.normalized(trainingDays, weeklySessions: weeklySessions).map(\.shortTitle)
    }

    var reminderTime: Date {
        get {
            let calendar = Calendar.current
            return calendar.date(
                bySettingHour: Self.normalizedReminderHour(reminderHour),
                minute: Self.normalizedReminderMinute(reminderMinute),
                second: 0,
                of: Date()
            ) ?? Date()
        }
        set {
            let components = Calendar.current.dateComponents([.hour, .minute], from: newValue)
            reminderHour = Self.normalizedReminderHour(components.hour ?? reminderHour)
            reminderMinute = Self.normalizedReminderMinute(components.minute ?? reminderMinute)
        }
    }

    private static func normalizedReminderHour(_ value: Int) -> Int {
        min(23, max(0, value))
    }

    private static func normalizedReminderMinute(_ value: Int) -> Int {
        min(59, max(0, value))
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
    var plannedEffortLabelRaw: String = ""
    var plannedEffortTargetRPE: Int = 0
    var plannedEffortReason: String = ""
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
        plannedEffort: PlannedEffort? = nil,
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
        self.plannedEffortLabelRaw = plannedEffort?.label.rawValue ?? ""
        self.plannedEffortTargetRPE = plannedEffort?.targetRPE ?? 0
        self.plannedEffortReason = plannedEffort?.reason ?? ""
        self.createdAt = createdAt
    }

    var focus: SessionFocus { SessionFocus(rawValue: focusRaw) ?? .mixed }
    var plannedEffortLabel: PlannedEffortLabel? {
        PlannedEffortLabel(rawValue: plannedEffortLabelRaw)
    }
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
    var plannedEffortLabelRaw: String = ""
    var plannedEffortTargetRPE: Int = 0
    var plannedEffortTargetRIR: Int = 0
    var plannedEffortStimulusRaw: String = ""
    var plannedEffortReason: String = ""

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
        intensity: String,
        plannedEffort: PlannedEffort? = nil
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
        self.plannedEffortLabelRaw = plannedEffort?.label.rawValue ?? ""
        self.plannedEffortTargetRPE = plannedEffort?.targetRPE ?? 0
        self.plannedEffortTargetRIR = plannedEffort?.targetRIR ?? 0
        self.plannedEffortStimulusRaw = plannedEffort?.stimulus.rawValue ?? ""
        self.plannedEffortReason = plannedEffort?.reason ?? ""
    }

    var exercise: ExerciseKind { ExerciseKind(rawValue: exerciseRaw) ?? .pullUp }
    var plannedEffortLabel: PlannedEffortLabel? {
        PlannedEffortLabel(rawValue: plannedEffortLabelRaw) ?? PlannedEffortLabel.fromLegacyIntensity(intensity)
    }
    var plannedEffortStimulus: EffortStimulus? {
        EffortStimulus(rawValue: plannedEffortStimulusRaw)
    }
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
    var plannedRPE: Int = 0
    var plannedEffortLabelRawAtLog: String = ""
    var plannedEffortReasonAtLog: String = ""
    var rpeSummary: String = ""
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
        plannedRPE: Int = 0,
        plannedEffortLabelAtLog: PlannedEffortLabel? = nil,
        plannedEffortReasonAtLog: String = "",
        rpeSummary: String = "",
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
        self.plannedRPE = Self.normalizedPlannedRPE(plannedRPE)
        self.plannedEffortLabelRawAtLog = plannedEffortLabelAtLog?.rawValue ?? ""
        self.plannedEffortReasonAtLog = plannedEffortReasonAtLog
        if rpeSummary.isEmpty {
            self.rpeSummary = Self.summaryText(plannedRPE: self.plannedRPE, actualRPE: rpe)
        } else {
            self.rpeSummary = rpeSummary
        }
        self.painLevel = painLevel
        self.fatigueLevel = fatigueLevel
        self.notes = notes
    }

    var plannedEffortLabelAtLog: PlannedEffortLabel? {
        PlannedEffortLabel(rawValue: plannedEffortLabelRawAtLog)
    }

    var hasPlannedRPESnapshot: Bool {
        (1...10).contains(plannedRPE)
    }

    var rpeDelta: Int? {
        hasPlannedRPESnapshot ? rpe - plannedRPE : nil
    }

    var rpeSummaryText: String {
        rpeSummary.isEmpty ? Self.summaryText(plannedRPE: plannedRPE, actualRPE: rpe) : rpeSummary
    }

    static func summaryText(plannedRPE: Int, actualRPE: Int) -> String {
        let actual = min(10, max(1, actualRPE))
        let planned = normalizedPlannedRPE(plannedRPE)
        guard planned > 0 else { return "RPE - Actual \(actual)" }
        return "RPE - Planned \(planned) | Actual \(actual)"
    }

    private static func normalizedPlannedRPE(_ value: Int) -> Int {
        (1...10).contains(value) ? value : 0
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

    var displayedBestStreak: Int {
        max(bestStreak, streak)
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
            detail: "Bodyweight strength comparisons depend on age, sex, body weight, and strict form, so the app treats them as external references instead of app scores.",
            sourceLabel: "ExRx strength standards",
            sourceURL: "https://exrx.net/WorkoutTools/StrengthStandards"
        )
    ]
}
