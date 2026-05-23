import Foundation
import SwiftData

enum ModelContainerFactory {
    static let cloudKitContainerIdentifier = "iCloud.com.erwinvink.fitnessapp"

    static var schema: Schema {
        Schema([
            UserProfile.self,
            WorkoutSession.self,
            WorkoutBlock.self,
            SetPrescription.self,
            PerformanceLog.self,
            RankState.self,
            CoachPlan.self,
            CoachDecision.self
        ])
    }

    static func make(inMemory: Bool = false, cloudKitEnabled: Bool = true) throws -> ModelContainer {
        if inMemory {
            let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true, cloudKitDatabase: .none)
            return try ModelContainer(for: schema, configurations: [config])
        }

        let cloudConfig = ModelConfiguration(
            schema: schema,
            isStoredInMemoryOnly: false,
            cloudKitDatabase: cloudKitEnabled ? .private(cloudKitContainerIdentifier) : .none
        )

        do {
            return try ModelContainer(for: schema, configurations: [cloudConfig])
        } catch {
            let localConfig = ModelConfiguration(schema: schema, isStoredInMemoryOnly: false, cloudKitDatabase: .none)
            return try ModelContainer(for: schema, configurations: [localConfig])
        }
    }
}

