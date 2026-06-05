import SwiftData
import SwiftUI
import UIKit
import UserNotifications

final class AppNotificationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }
}

@main
struct FitnessApp: App {
    @UIApplicationDelegateAdaptor(AppNotificationDelegate.self) private var notificationDelegate

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
