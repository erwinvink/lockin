import SwiftData
import SwiftUI

struct AppShellView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query private var ranks: [RankState]
    @AppStorage("coachProxyEndpoint") private var coachEndpoint = LocalCoachClient.defaultEndpointString
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
    /// silent here; Settings surfaces the Garmin status separately.
    private func syncGarminIfDue() {
        guard !isSyncingGarmin else { return }
        guard Date().timeIntervalSince1970 - garminLastSyncAt > Self.garminSyncInterval else { return }
        guard let client = try? LocalCoachClient(endpointString: coachEndpoint) else { return }

        isSyncingGarmin = true
        Task {
            defer { isSyncingGarmin = false }
            await syncGarmin(client: client)
        }
    }

    @MainActor
    private func syncGarmin(client: LocalCoachClient) async {
        do {
            let snapshot = try await client.fetchGarminSnapshot(sinceDays: 7)
            try ingest(wellness: snapshot.wellness, in: modelContext)
            // Fetch fresh after the await: the @Query snapshot may be stale by
            // the time the response lands (e.g. the missed sweep ran meanwhile).
            let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())
            let existingRunLogs = try modelContext.fetch(FetchDescriptor<RunLog>())
            try matchGarminActivities(
                snapshot.activities,
                sessions: sessions,
                existingRunLogs: existingRunLogs,
                in: modelContext
            )
            try modelContext.save()
            garminLastSyncAt = Date().timeIntervalSince1970
        } catch {
            // Swallowed by design: the next foreground retries, and Settings
            // shows the Garmin connection state. Drop any partial ingest so
            // a failed sync never leaves half-written snapshots or logs.
            modelContext.rollback()
        }
    }
}
