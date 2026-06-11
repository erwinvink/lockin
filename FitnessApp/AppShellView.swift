import SwiftData
import SwiftUI

struct AppShellView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query private var ranks: [RankState]
    // Configuration, not state: fixed per build flavor (see LocalCoachClient).
    private let coachEndpoint = LocalCoachClient.defaultEndpointString
    @AppStorage("garminLastSyncAt") private var garminLastSyncAt: Double = 0
    @State private var isSyncingGarmin = false

    private static let garminSyncInterval: TimeInterval = 30 * 60

    var profile: UserProfile

    var body: some View {
        TabView {
            TodayView(profile: profile)
                .tabItem { Label("Today", systemImage: "house.fill") }

            ProgressView(profile: profile)
                .tabItem { Label("Progress", systemImage: "chart.bar.fill") }

            CoachView(profile: profile)
                .tabItem { Label("Coach", systemImage: "brain.head.profile") }

            CalendarView()
                .tabItem { Label("Log", systemImage: "list.clipboard") }

            SettingsView(profile: profile)
                .tabItem { Label("Profile", systemImage: "person.crop.circle") }
        }
        .tint(AppTheme.accent)
        .onAppear(perform: refreshTrainingPlanState)
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                refreshTrainingPlanState()
            }
        }
    }

    private func refreshTrainingPlanState() {
        let retainedSessions = sessions.filter { $0.status != .planned || $0.summary.hasPrefix("AI:") }
        _ = try? deleteNonAIPlannedSessions(from: sessions, in: modelContext)
        let runLogs = (try? modelContext.fetch(FetchDescriptor<RunLog>())) ?? []
        _ = try? markOverduePlannedSessionsMissed(
            from: retainedSessions,
            runLogs: runLogs,
            logs: logs,
            profile: profile,
            ranks: ranks,
            in: modelContext
        )
        syncGarminIfDue()
    }

    /// Pulls the Garmin snapshot at most every 30 minutes. All failures stay
    /// silent here; Settings surfaces the Garmin status and sync errors
    /// separately. UI tests run against the in-memory store and must stay
    /// hermetic: a live sync would pour real account data into seeded state.
    private func syncGarminIfDue() {
        guard !ProcessInfo.processInfo.arguments.contains("UITesting") else { return }
        guard !isSyncingGarmin else { return }
        guard Date().timeIntervalSince1970 - garminLastSyncAt > Self.garminSyncInterval else { return }

        isSyncingGarmin = true
        Task {
            defer { isSyncingGarmin = false }
            do {
                let ingested = try await performGarminSync(endpoint: coachEndpoint, in: modelContext)
                garminLastSyncAt = Date().timeIntervalSince1970
                if ingested.importedRuns > 0 {
                    // Auto-imported confirmed runs are new training data for
                    // the coach read; pending ones wait for confirmation.
                    UserDefaults.standard.set(true, forKey: CoachVerdictRefreshFlag.needsRefreshKey)
                }
            } catch {
                // Swallowed by design: performGarminSync already rolled back
                // any partial ingest, and the next foreground retries.
            }
        }
    }
}
