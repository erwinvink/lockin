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

enum CalisthenicsRank: String, CaseIterable, Codable {
    case recruit
    case grinder
    case operatorRank
    case specialist
    case elite
    case apex

    var title: String {
        switch self {
        case .recruit: "Recruit"
        case .grinder: "Grinder"
        case .operatorRank: "Operator"
        case .specialist: "Specialist"
        case .elite: "Elite"
        case .apex: "Apex"
        }
    }

    var minimumXP: Int {
        switch self {
        case .recruit: 0
        case .grinder: 400
        case .operatorRank: 1_000
        case .specialist: 2_000
        case .elite: 3_500
        case .apex: 5_500
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
        self.weeklySessions = weeklySessions
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
final class RankState {
    var id: UUID = UUID()
    var rankRaw: String = CalisthenicsRank.recruit.rawValue
    var xp: Int = 0
    var consistencyScore: Int = 0
    var streak: Int = 0
    var penaltyPoints: Int = 0
    var updatedAt: Date = Date()

    init(
        id: UUID = UUID(),
        rank: CalisthenicsRank = .recruit,
        xp: Int = 0,
        consistencyScore: Int = 0,
        streak: Int = 0,
        penaltyPoints: Int = 0,
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.rankRaw = rank.rawValue
        self.xp = xp
        self.consistencyScore = consistencyScore
        self.streak = streak
        self.penaltyPoints = penaltyPoints
        self.updatedAt = updatedAt
    }

    var rank: CalisthenicsRank {
        get { CalisthenicsRank(rawValue: rankRaw) ?? .recruit }
        set { rankRaw = newValue.rawValue }
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
            detail: "Bodyweight strength comparisons depend on age, sex, body weight, and strict form, so the app treats them as external references instead of direct XP ranks.",
            sourceLabel: "ExRx strength standards",
            sourceURL: "https://exrx.net/WorkoutTools/StrengthStandards"
        )
    ]
}
