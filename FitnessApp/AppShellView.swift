import SwiftData
import SwiftUI

enum AppTab: Hashable {
    case today
    case progress
    case coach
    case log
    case profile
}

private struct OpenTabKey: EnvironmentKey {
    static let defaultValue: (AppTab) -> Void = { _ in }
}

extension EnvironmentValues {
    /// Lets a screen send the user to another tab ("Plan my first week").
    var openTab: (AppTab) -> Void {
        get { self[OpenTabKey.self] }
        set { self[OpenTabKey.self] = newValue }
    }
}

struct AppShellView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query private var ranks: [RankState]
    // Configuration, not state: fixed per build flavor (see LocalCoachClient).
    private let coachEndpoint = LocalCoachClient.defaultEndpointString
    @AppStorage("coachModelID") private var selectedModelID = CoachModelCatalog.defaultModelID
    @AppStorage("garminLastSyncAt") private var garminLastSyncAt: Double = 0
    @AppStorage("garminLastSyncAttemptAt") private var garminLastSyncAttemptAt: Double = 0
    @AppStorage("garminConnectionActive") private var garminConnectionActive = false
    @AppStorage("autoPlanLastContextSyncAt") private var autoPlanLastContextSyncAt: Double = 0
    @State private var isSyncingGarmin = false
    @State private var isSyncingAutoPlan = false
    @State private var selectedTab: AppTab = .today

    private static let autoPlanContextInterval: TimeInterval = 30 * 60

    var profile: UserProfile

    var body: some View {
        TabView(selection: $selectedTab) {
            TodayView(profile: profile)
                .tabItem { Label("Today", systemImage: "signpost.right.fill") }
                .tag(AppTab.today)

            ProgressView(profile: profile)
                .tabItem { Label("Progress", systemImage: "mountain.2.fill") }
                .tag(AppTab.progress)

            CoachView(profile: profile)
                .tabItem { Label("Coach", systemImage: "bubble.left.and.bubble.right.fill") }
                .tag(AppTab.coach)

            CalendarView()
                .tabItem { Label("Log", systemImage: "list.bullet") }
                .tag(AppTab.log)

            SettingsView(profile: profile)
                .tabItem { Label("Profile", systemImage: "person.crop.circle.fill") }
                .tag(AppTab.profile)
        }
        .tint(AppTheme.accent)
        .environment(\.openTab) { selectedTab = $0 }
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
        do {
            let reconciliation = try reconcileAttachedGarminRunLogs(
                sessions: retainedSessions,
                runLogs: runLogs,
                ranks: ranks,
                in: modelContext
            )
            if reconciliation.changedCount > 0 {
                try modelContext.save()
            }
        } catch {
            modelContext.rollback()
        }
        _ = try? markOverduePlannedSessionsMissed(
            from: retainedSessions,
            runLogs: runLogs,
            logs: logs,
            profile: profile,
            ranks: ranks,
            in: modelContext
        )
        guard !ProcessInfo.processInfo.arguments.contains("UITesting") else { return }
        Task { await refreshWorkoutReminders(in: modelContext) }
        syncGarminIfDue()
        syncAutoPlanIfDue()
        Task {
            await CoachReadRefresher.refreshIfDue(endpoint: coachEndpoint, profile: profile, modelID: selectedModelID, in: modelContext)
        }
    }

    /// Pulls the Garmin snapshot at most every 30 minutes, backing off 10
    /// minutes after a failed attempt. It no longer waits for the Profile
    /// screen to mark Garmin as connected: a logged-out sidecar answers
    /// `notLoggedIn`, which clears the flag. All failures stay silent here;
    /// Settings surfaces the Garmin status and sync errors separately. UI
    /// tests run against the in-memory store and must stay hermetic: a live
    /// sync would pour real account data into seeded state.
    private func syncGarminIfDue() {
        guard !isSyncingGarmin else { return }
        guard shouldAttemptGarminSync(now: Date(), lastSuccessAt: garminLastSyncAt, lastAttemptAt: garminLastSyncAttemptAt) else { return }

        isSyncingGarmin = true
        garminLastSyncAttemptAt = Date().timeIntervalSince1970
        Task {
            defer { isSyncingGarmin = false }
            do {
                let ingested = try await performGarminSync(endpoint: coachEndpoint, userId: profile.id.uuidString, in: modelContext)
                garminLastSyncAt = Date().timeIntervalSince1970
                garminConnectionActive = true
                await refreshWorkoutReminders(in: modelContext)
                if ingested.completedRuns > 0 || ingested.partialRuns > 0 || ingested.importedRuns > 0 {
                    await CoachReadRefresher.refresh(endpoint: coachEndpoint, profile: profile, modelID: selectedModelID, in: modelContext)
                }
            } catch GarminSyncError.notLoggedIn {
                garminConnectionActive = false
            } catch {
                // Swallowed by design: performGarminSync already rolled back
                // any partial ingest, and a later foreground retries.
            }
        }
    }

    private func syncAutoPlanIfDue() {
        guard !isSyncingAutoPlan else { return }
        let scheduleChanged = PlanRefreshRequest.consume()
        let profileId = profile.id.uuidString
        let needsFirstPlan = FirstPlanRequest.shouldForce(profileId: profileId, sessionCount: sessions.count)
        guard scheduleChanged || needsFirstPlan || Date().timeIntervalSince1970 - autoPlanLastContextSyncAt > Self.autoPlanContextInterval else {
            Task { _ = await AutoPlanCoordinator.applyLatestServerPlan(endpoint: coachEndpoint, profile: profile, in: modelContext) }
            return
        }

        isSyncingAutoPlan = true
        Task {
            defer { isSyncingAutoPlan = false }
            _ = await AutoPlanCoordinator.applyLatestServerPlan(endpoint: coachEndpoint, profile: profile, in: modelContext)
            // Fetch after the await: the plan just applied may have replaced
            // the sessions and prescriptions the view's queries still hold.
            guard let request = try? makeCoachRequestFromStore(profile: profile, modelID: selectedModelID, in: modelContext) else { return }
            let outcome = await AutoPlanCoordinator.trigger(
                endpoint: coachEndpoint,
                source: scheduleChanged ? .manual : .appActive,
                reason: scheduleChanged
                    ? "Training days changed."
                    : needsFirstPlan ? "First plan for a new profile." : "App refreshed the latest planning context.",
                force: scheduleChanged || needsFirstPlan,
                request: request,
                profile: profile,
                in: modelContext
            )
            if scheduleChanged, PlanRefreshRequest.shouldRetry(after: outcome) {
                PlanRefreshRequest.mark()
            }
            // One forced first plan per profile once the proxy has answered;
            // an offline attempt is tried again on the next open.
            if needsFirstPlan, outcome.reachedProxy {
                FirstPlanRequest.markRequested(profileId: profileId)
            }
            autoPlanLastContextSyncAt = Date().timeIntervalSince1970
        }
    }
}
