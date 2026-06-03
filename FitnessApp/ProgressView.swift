import SwiftData
import SwiftUI

struct ProgressView: View {
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
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

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "Progress") {
                overviewContent
            }
        }
    }

    private var overviewContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            ConsistencySummaryCard(rank: rank)
            liftContent
            HStack(spacing: 8) {
                MetricCard(title: "Streak", value: "\(rank.streak)", subtitle: "Current", systemImage: "flame.fill")
                MetricCard(title: "Best", value: "\(rank.bestStreak)", subtitle: "Best streak", systemImage: "checkmark.seal.fill")
                MetricCard(title: "Penalties", value: "\(rank.penaltyPoints)", subtitle: "+\(TrainingEngine.missedSessionPenaltyPoints) per miss", color: AppTheme.warning, systemImage: "exclamationmark.triangle.fill")
            }
            ConsistencyCard(rank: rank)
            NavigationLink {
                RanksView()
            } label: {
                HStack {
                    Label("Consistency details and benchmarks", systemImage: "chart.line.uptrend.xyaxis")
                    Spacer()
                    Image(systemName: "chevron.right")
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppTheme.text)
                .card()
            }
            .buttonStyle(.plain)
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

private struct ConsistencySummaryCard: View {
    var rank: RankState

    var body: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 5) {
                Text("\(rank.consistencyScore)")
                    .font(.system(.title, design: .rounded, weight: .black))
                    .foregroundStyle(AppTheme.accent)
                Text("Consistency score")
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            }
            Spacer()
            Image(systemName: "chart.line.uptrend.xyaxis.circle.fill")
                .font(.system(size: 46))
                .foregroundStyle(AppTheme.accent)
        }
        .card()
    }
}

private struct ConsistencyCard: View {
    var rank: RankState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Consistency")
                    .font(.headline)
                Spacer()
                Text("\(rank.consistencyScore)")
                    .font(.system(.title3, design: .rounded, weight: .bold))
                    .foregroundStyle(AppTheme.accent)
            }
            HStack {
                ForEach(0..<7, id: \.self) { index in
                    Image(systemName: index < min(rank.streak, 7) ? "checkmark.circle.fill" : "minus.circle.fill")
                        .foregroundStyle(index < min(rank.streak, 7) ? AppTheme.accent : AppTheme.muted.opacity(0.5))
                    Spacer(minLength: 0)
                }
            }
            Text("A missed session resets the streak immediately. Penalty points are score pressure only; the app does not add unsafe make-up volume.")
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
        }
        .card()
    }
}
