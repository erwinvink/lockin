import SwiftData
import SwiftUI

struct AppShellView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query private var ranks: [RankState]
    @State private var selectedTab: LockinTab = .today

    var profile: UserProfile

    var body: some View {
        selectedContent
            .safeAreaInset(edge: .bottom, spacing: 0) {
                LockinBottomTabBar(selection: $selectedTab)
            }
            .background(AppTheme.background.ignoresSafeArea())
            .onAppear(perform: refreshTrainingPlanState)
            .onChange(of: scenePhase) { _, newPhase in
                if newPhase == .active {
                    refreshTrainingPlanState()
                }
            }
    }

    @ViewBuilder
    private var selectedContent: some View {
        switch selectedTab {
        case .today:
            TodayView(profile: profile)
        case .progress:
            ProgressView(profile: profile)
        case .coach:
            CoachView(profile: profile)
        case .log:
            CalendarView()
        case .profile:
            SettingsView(profile: profile)
        }
    }

    private func refreshTrainingPlanState() {
        let retainedSessions = sessions.filter { $0.status != .planned || isCoachGeneratedSummary($0.summary) }
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

private enum LockinTab: String, CaseIterable, Identifiable {
    case today
    case progress
    case coach
    case log
    case profile

    var id: String { rawValue }

    var title: String {
        switch self {
        case .today: "Today"
        case .progress: "Progress"
        case .coach: "Coach"
        case .log: "Log"
        case .profile: "Profile"
        }
    }

    func systemImage(isSelected: Bool) -> String {
        switch self {
        case .today: isSelected ? "house.fill" : "house"
        case .progress: "chart.bar"
        case .coach: isSelected ? "bubble.left.fill" : "bubble.left"
        case .log: isSelected ? "calendar.badge.checkmark" : "calendar"
        case .profile: isSelected ? "person.fill" : "person"
        }
    }
}

private struct LockinBottomTabBar: View {
    @Binding var selection: LockinTab

    var body: some View {
        HStack(spacing: 0) {
            ForEach(LockinTab.allCases) { tab in
                Button {
                    selection = tab
                } label: {
                    VStack(spacing: 6) {
                        Image(systemName: tab.systemImage(isSelected: selection == tab))
                            .font(.system(size: 22, weight: selection == tab ? .semibold : .regular))
                            .frame(width: 26, height: 26)
                        Text(tab.title)
                            .font(.system(size: 12, weight: selection == tab ? .semibold : .medium))
                    }
                    .foregroundStyle(selection == tab ? AppTheme.forest : AppTheme.textTertiary)
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.title)
                .accessibilityAddTraits(selection == tab ? [.isSelected] : [])
            }
        }
        .padding(.top, 6)
        .padding(.horizontal, 12)
        .padding(.bottom, AppTheme.bottomSafeAreaExtra)
        .background(AppTheme.tabSurface.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) {
            Rectangle()
                .fill(AppTheme.border)
                .frame(height: 0.5)
        }
    }
}
