import SwiftData
import SwiftUI

struct AppShellView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query private var ranks: [RankState]

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
        _ = try? markOverduePlannedSessionsMissed(
            from: retainedSessions,
            logs: logs,
            profile: profile,
            ranks: ranks,
            in: modelContext
        )
    }
}
