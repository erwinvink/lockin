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
            CoachDecision.self,
            CoachVerdict.self,
            CoachChatMessage.self,
            RaceGoal.self,
            RunLog.self,
            GarminDailySnapshot.self
        ])
    }

    /// UserDefaults key holding the path of a store backup made at launch,
    /// until the athlete has seen the notice.
    static let recoveredStoreBackupKey = "recoveredStoreBackupPath"

    /// Opens the store. If it can't be opened (failed migration, damaged
    /// file), the files are moved aside as a timestamped backup and a fresh
    /// store is created, instead of crashing on every launch.
    static func make(inMemory: Bool = false, cloudKitEnabled: Bool = true, storeURL: URL? = nil) throws -> ModelContainer {
        if inMemory {
            let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true, cloudKitDatabase: .none)
            return try ModelContainer(for: schema, configurations: [config])
        }

        func configuration(cloudKit: Bool) -> ModelConfiguration {
            let database: ModelConfiguration.CloudKitDatabase = cloudKit ? .private(cloudKitContainerIdentifier) : .none
            if let storeURL {
                return ModelConfiguration(schema: schema, url: storeURL, cloudKitDatabase: database)
            }
            return ModelConfiguration(schema: schema, isStoredInMemoryOnly: false, cloudKitDatabase: database)
        }

        var lastError: Error
        do {
            return try ModelContainer(for: schema, configurations: [configuration(cloudKit: cloudKitEnabled)])
        } catch {
            lastError = error
        }
        if cloudKitEnabled {
            do {
                return try ModelContainer(for: schema, configurations: [configuration(cloudKit: false)])
            } catch {
                lastError = error
            }
        }

        // Only a store that is there, readable, and on a disk with room is
        // damaged or unmigratable. Anything else (file protection before
        // first unlock, permissions, a full disk) is transient: rethrow and
        // keep the data where it is.
        let localConfig = configuration(cloudKit: false)
        guard storeCanBeMovedAside(at: localConfig.url) else { throw lastError }
        let backup = try moveStoreAside(at: localConfig.url)
        UserDefaults.standard.set(backup.path(percentEncoded: false), forKey: recoveredStoreBackupKey)
        return try ModelContainer(for: schema, configurations: [localConfig])
    }

    private static func storeCanBeMovedAside(at url: URL) -> Bool {
        let path = url.path(percentEncoded: false)
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: path), fileManager.isReadableFile(atPath: path) else { return false }
        let capacity = try? url.deletingLastPathComponent()
            .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            .volumeAvailableCapacityForImportantUsage
        return (capacity ?? .max) > 50_000_000
    }

    /// Renames the store and its -wal/-shm files to
    /// "<name>.unreadable-<timestamp>" next to the original. The journal
    /// files go first, so a half-finished move never leaves a stale -wal
    /// next to a fresh store.
    private static func moveStoreAside(at url: URL) throws -> URL {
        let stamp = Int(Date().timeIntervalSince1970)
        let backup = url.deletingLastPathComponent().appending(path: "\(url.lastPathComponent).unreadable-\(stamp)")
        let fileManager = FileManager.default
        for suffix in ["-wal", "-shm", ""] {
            let source = URL(filePath: url.path(percentEncoded: false) + suffix)
            guard fileManager.fileExists(atPath: source.path(percentEncoded: false)) else { continue }
            try fileManager.moveItem(at: source, to: URL(filePath: backup.path(percentEncoded: false) + suffix))
        }
        return backup
    }
}
