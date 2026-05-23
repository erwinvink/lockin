import SwiftData
import SwiftUI

@main
struct FitnessApp: App {
    private let modelContainer: ModelContainer

    init() {
        do {
            let isUITesting = ProcessInfo.processInfo.arguments.contains("UITesting")
            let isUnitTesting = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
            let isTesting = isUITesting || isUnitTesting
            let cloudKitEnabled = ProcessInfo.processInfo.arguments.contains("EnableCloudKit") ||
                ProcessInfo.processInfo.environment["ENABLE_CLOUDKIT"] == "1"
            modelContainer = try ModelContainerFactory.make(inMemory: isTesting, cloudKitEnabled: cloudKitEnabled && !isTesting)
        } catch {
            fatalError("Unable to create model container: \(error)")
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
        .modelContainer(modelContainer)
    }
}
