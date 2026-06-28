import SwiftData
import SwiftUI

struct AppShellView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query(sort: \SetPrescription.orderIndex) private var prescriptions: [SetPrescription]
    @Query(sort: \RaceGoal.createdAt) private var raceGoals: [RaceGoal]
    @Query(sort: \RunLog.completedAt, order: .reverse) private var runLogs: [RunLog]
    @Query private var ranks: [RankState]
    // Configuration, not state: fixed per build flavor (see LocalCoachClient).
    private let coachEndpoint = LocalCoachClient.defaultEndpointString
    @AppStorage("coachModelID") private var selectedModelID = CoachModelCatalog.defaultModelID
    @AppStorage("garminLastSyncAt") private var garminLastSyncAt: Double = 0
    @AppStorage("garminConnectionActive") private var garminConnectionActive = false
    @AppStorage("autoPlanLastContextSyncAt") private var autoPlanLastContextSyncAt: Double = 0
    @State private var isSyncingGarmin = false
    @State private var isSyncingAutoPlan = false

    private static let garminSyncInterval: TimeInterval = 30 * 60
    private static let autoPlanContextInterval: TimeInterval = 30 * 60

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
        .onAppear {
            ensureCurrentUserProfile(profile, in: modelContext)
            refreshTrainingPlanState()
        }
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
        syncAutoPlanIfDue()
    }

    /// Pulls the Garmin snapshot at most every 30 minutes. All failures stay
    /// silent here; Settings surfaces the Garmin status and sync errors
    /// separately. UI tests run against the in-memory store and must stay
    /// hermetic: a live sync would pour real account data into seeded state.
    private func syncGarminIfDue() {
        guard !ProcessInfo.processInfo.arguments.contains("UITesting") else { return }
        guard garminConnectionActive else { return }
        guard !isSyncingGarmin else { return }
        guard Date().timeIntervalSince1970 - garminLastSyncAt > Self.garminSyncInterval else { return }

        isSyncingGarmin = true
        Task {
            defer { isSyncingGarmin = false }
            do {
                let ingested = try await performGarminSync(endpoint: coachEndpoint, userId: profile.id.uuidString, in: modelContext)
                garminLastSyncAt = Date().timeIntervalSince1970
                if ingested.completedRuns > 0 || ingested.partialRuns > 0 || ingested.importedRuns > 0 {
                    await refreshCoachReadAfterTraining()
                }
            } catch {
                // Swallowed by design: performGarminSync already rolled back
                // any partial ingest, and the next foreground retries.
            }
        }
    }

    private func refreshCoachReadAfterTraining() async {
        do {
            let refreshedLogs = try modelContext.fetch(FetchDescriptor<PerformanceLog>(sortBy: [SortDescriptor(\.completedAt, order: .reverse)]))
            let refreshedSessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>(sortBy: [SortDescriptor(\.scheduledDate)]))
            let refreshedPrescriptions = try modelContext.fetch(FetchDescriptor<SetPrescription>(sortBy: [SortDescriptor(\.orderIndex)]))
            let refreshedRunLogs = try modelContext.fetch(FetchDescriptor<RunLog>(sortBy: [SortDescriptor(\.completedAt, order: .reverse)]))
            let refreshedRaceGoal = try modelContext.fetch(FetchDescriptor<RaceGoal>(sortBy: [SortDescriptor(\.createdAt)])).first
            let request = makeCoachRequest(
                profile: profile,
                modelID: selectedModelID,
                logs: refreshedLogs,
                sessions: refreshedSessions,
                prescriptions: refreshedPrescriptions,
                raceGoal: refreshedRaceGoal,
                runLogs: refreshedRunLogs,
                weekStart: rollingPlanStart()
            )
            let response = try await LocalCoachClient(endpointString: coachEndpoint).generateVerdict(request: request)
            modelContext.insert(CoachVerdict(response: response, sourceLogId: nil))
            try modelContext.save()
            UserDefaults.standard.set(false, forKey: CoachVerdictRefreshFlag.needsRefreshKey)
        } catch {
            UserDefaults.standard.set(true, forKey: CoachVerdictRefreshFlag.needsRefreshKey)
        }
    }

    private func syncAutoPlanIfDue() {
        guard !ProcessInfo.processInfo.arguments.contains("UITesting") else { return }
        guard !isSyncingAutoPlan else { return }
        guard Date().timeIntervalSince1970 - autoPlanLastContextSyncAt > Self.autoPlanContextInterval else {
            Task { _ = await AutoPlanCoordinator.applyLatestServerPlan(endpoint: coachEndpoint, profile: profile, in: modelContext) }
            return
        }

        isSyncingAutoPlan = true
        Task {
            defer { isSyncingAutoPlan = false }
            _ = await AutoPlanCoordinator.applyLatestServerPlan(endpoint: coachEndpoint, profile: profile, in: modelContext)
            let request = makeCoachRequest(
                profile: profile,
                modelID: selectedModelID,
                logs: logs,
                sessions: sessions,
                prescriptions: prescriptions,
                raceGoal: raceGoals.first,
                runLogs: runLogs,
                weekStart: rollingPlanStart()
            )
            _ = await AutoPlanCoordinator.trigger(
                endpoint: coachEndpoint,
                source: .appActive,
                reason: "App refreshed the latest planning context.",
                request: request,
                profile: profile,
                in: modelContext
            )
            autoPlanLastContextSyncAt = Date().timeIntervalSince1970
        }
    }
}
