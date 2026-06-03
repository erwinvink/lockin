import SwiftData
import SwiftUI

struct RanksView: View {
    @Query private var ranks: [RankState]

    private var rank: RankState {
        ranks.first ?? RankState()
    }

    var body: some View {
        ScreenBackground(title: "Consistency") {
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("\(rank.consistencyScore)")
                        .font(.system(.largeTitle, design: .rounded, weight: .black))
                        .foregroundStyle(AppTheme.accent)
                    Text("Consistency score")
                        .font(.caption)
                        .foregroundStyle(AppTheme.muted)
                }
                Spacer()
                Image(systemName: "chart.line.uptrend.xyaxis.circle.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(AppTheme.accent)
            }
            .card()

            HStack(spacing: 8) {
                MetricCard(title: "Streak", value: "\(rank.streak)", subtitle: "Current sessions")
                MetricCard(title: "Best", value: "\(rank.bestStreak)", subtitle: "Best streak")
            }
            HStack(spacing: 8) {
                MetricCard(title: "Consistency", value: "\(rank.consistencyScore)", subtitle: "Long-term score")
                MetricCard(title: "Penalties", value: "\(rank.penaltyPoints)", subtitle: "Misses visible", color: AppTheme.warning)
            }

            ConsistencyRulesCard()
            BenchmarkAnchorsCard()
        }
        .navigationTitle("Consistency")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct ConsistencyRulesCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("How it works")
                .font(.headline)
            Text("Completed sessions add consistency. Missed sessions reduce it, add visible penalty points, and reset the current streak. No unsafe make-up volume is added.")
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
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
