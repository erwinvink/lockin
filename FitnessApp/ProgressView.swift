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
            RankSummaryCard(rank: rank)
            liftContent
            HStack(spacing: 8) {
                MetricCard(title: "XP", value: "\(rank.xp)", subtitle: "Earned by execution", systemImage: "bolt.fill")
                MetricCard(title: "Streak", value: "\(rank.streak)", subtitle: "Completed sessions", systemImage: "flame.fill")
                MetricCard(title: "Penalties", value: "\(rank.penaltyPoints)", subtitle: "+\(TrainingEngine.missedSessionPenaltyPoints) per miss", color: AppTheme.warning, systemImage: "exclamationmark.triangle.fill")
            }
            ConsistencyCard(rank: rank)
            RankLadderCard(current: rank)
            NavigationLink {
                RanksView()
            } label: {
                HStack {
                    Label("Rank details and benchmarks", systemImage: "shield.lefthalf.filled")
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

private struct RankSummaryCard: View {
    var rank: RankState

    var body: some View {
        HStack(spacing: 14) {
            RankBadge(rank: rank.rank)
            VStack(alignment: .leading, spacing: 5) {
                Text(rank.rank.title)
                    .font(.system(.title, design: .rounded, weight: .black))
                    .foregroundStyle(AppTheme.gold)
                Text("App rank based on consistency and execution.")
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            }
            Spacer()
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

private struct RankLadderCard: View {
    var current: RankState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("XP ladder")
                .font(.headline)
            Text("Ranks are a motivation layer for consistency and execution, not official sport, military, or medical classifications.")
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
            ForEach(CalisthenicsRank.allCases, id: \.self) { rank in
                HStack {
                    Text(rank.title)
                        .font(.subheadline.weight(.medium))
                    Spacer()
                    Text("\(rank.minimumXP) XP")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(current.xp >= rank.minimumXP ? AppTheme.accent : AppTheme.muted)
                }
                if rank != CalisthenicsRank.allCases.last {
                    Divider()
                }
            }
        }
        .card()
    }
}
