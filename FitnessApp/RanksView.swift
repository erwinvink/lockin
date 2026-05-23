import SwiftData
import SwiftUI

struct RanksView: View {
    @Query private var ranks: [RankState]

    private var rank: RankState {
        ranks.first ?? RankState()
    }

    var body: some View {
        ScreenBackground(title: "Ranks") {
            HStack(spacing: 14) {
                RankBadge(rank: rank.rank)
                VStack(alignment: .leading, spacing: 5) {
                    Text(rank.rank.title)
                        .font(.system(.largeTitle, design: .rounded, weight: .black))
                        .foregroundStyle(AppTheme.gold)
                    Text("Consistency and execution layer")
                        .font(.caption)
                        .foregroundStyle(AppTheme.muted)
                }
                Spacer()
            }
            .card()

            HStack(spacing: 8) {
                MetricCard(title: "XP", value: "\(rank.xp)", subtitle: "Execution")
                MetricCard(title: "Streak", value: "\(rank.streak)", subtitle: "Sessions")
            }
            HStack(spacing: 8) {
                MetricCard(title: "Consistency", value: "\(rank.consistencyScore)", subtitle: "Long-term score")
                MetricCard(title: "Penalties", value: "\(rank.penaltyPoints)", subtitle: "Misses visible", color: AppTheme.warning)
            }

            RankDetailLadder(current: rank)
            BenchmarkAnchorsCard()
        }
        .navigationTitle("Ranks")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct RankDetailLadder: View {
    var current: RankState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("XP ladder")
                .font(.headline)
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

private struct BenchmarkAnchorsCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Real-world anchors")
                .font(.headline)
            ForEach(RealWorldBenchmark.examples) { benchmark in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(benchmark.title)
                            .font(.subheadline.bold())
                        Spacer()
                        Text(benchmark.value)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(AppTheme.accent)
                    }
                    Text(benchmark.detail)
                        .font(.caption)
                        .foregroundStyle(AppTheme.muted)
                    if let url = URL(string: benchmark.sourceURL) {
                        Link(benchmark.sourceLabel, destination: url)
                            .font(.caption.weight(.bold))
                    }
                }
                .padding(12)
                .background(AppTheme.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
            }
        }
        .card()
    }
}
