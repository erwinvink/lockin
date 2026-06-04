import SwiftData
import SwiftUI

struct ProgressView: View {
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query private var ranks: [RankState]

    var profile: UserProfile

    private var rank: RankState {
        ranks.first ?? RankState()
    }

    private var latestPullUps: Int {
        logs.first(where: { $0.loggedPullUps })?.pullUps ?? profile.baselinePullUps
    }

    private var latestPushUps: Int {
        logs.first(where: { $0.loggedPushUps })?.pushUps ?? profile.baselinePushUps
    }

    private var latestPlankSeconds: Int {
        logs.first(where: { $0.loggedPlankSeconds })?.plankSeconds ?? profile.baselinePlankSeconds
    }

    private var missedTrainingCount: Int {
        sessions.filter { $0.status == .missed }.count
    }

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "Progress") {
                overviewContent
            }
        }
    }

    private var overviewContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                MetricCard(title: "Streak", value: "\(rank.streak)", subtitle: "Current sessions", systemImage: "flame.fill")
                MetricCard(title: "Best", value: "\(rank.displayedBestStreak)", subtitle: "Best streak", systemImage: "checkmark.seal.fill")
            }
            MetricCard(title: "Missed trainings", value: "\(missedTrainingCount)", subtitle: "Total missed", color: AppTheme.warning, systemImage: "exclamationmark.triangle.fill")
            liftContent
        }
    }

    private var liftContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            ProgressRing(title: "Pull-ups", current: latestPullUps, goal: profile.goalPullUps, benchmark: "Benchmark: 20 reps")
            ProgressRing(title: "Push-ups", current: latestPushUps, goal: profile.goalPushUps, benchmark: "Benchmark: 50 reps")
            ProgressRing(title: "Plank", current: latestPlankSeconds, goal: profile.goalPlankSeconds, seconds: true, benchmark: "Benchmark: 2:00")
        }
    }
}
