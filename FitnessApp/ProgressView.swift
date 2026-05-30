import SwiftData
import SwiftUI

private enum ProgressTab: String, CaseIterable, Identifiable {
    case overview
    case strength
    case running

    var id: String { rawValue }

    var title: String {
        switch self {
        case .overview: "Overview"
        case .strength: "Strength"
        case .running: "Running"
        }
    }
}

struct ProgressView: View {
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query(sort: \RunningLog.completedAt, order: .reverse) private var runLogs: [RunningLog]
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \RunningTrainingProfile.createdAt) private var runningProfiles: [RunningTrainingProfile]
    @Query private var ranks: [RankState]
    @State private var selectedTab: ProgressTab = .overview

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

    private var runningProfile: RunningTrainingProfile {
        displayRunningProfile(for: profile, from: runningProfiles)
    }

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "Progress") {
                Picker("Progress", selection: $selectedTab) {
                    ForEach(ProgressTab.allCases) { tab in
                        Text(tab.title).tag(tab)
                    }
                }
                .pickerStyle(.segmented)

                switch selectedTab {
                case .overview:
                    overviewContent
                case .strength:
                    strengthContent
                case .running:
                    runningContent
                }
            }
        }
    }

    private var overviewContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            AthleteProgressOverviewCard(
                rank: rank,
                sessions: sessions,
                runningProfile: runningProfile,
                runLogs: runLogs,
                strengthLogs: logs
            )
            MilestoneCard(profile: profile, runningProfile: runningProfile, latestPullUps: latestPullUps, latestPushUps: latestPushUps, latestPlankSeconds: latestPlankSeconds, longestRun: longestRun)
        }
    }

    private var strengthContent: some View {
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

    private var runningContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            UltraProgressCard(profile: runningProfile, logs: runLogs)
            RunningTrendCard(profile: runningProfile, logs: runLogs)
        }
    }

    private var longestRun: Double {
        runLogs.map(\.distanceKm).max() ?? Double(runningProfile.currentLongRunKm)
    }

    private var liftContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            ProgressRing(title: "Pull-ups", current: latestPullUps, goal: profile.goalPullUps, benchmark: "Benchmark: 20 reps")
            ProgressRing(title: "Push-ups", current: latestPushUps, goal: profile.goalPushUps, benchmark: "Benchmark: 50 reps")
            ProgressRing(title: "Plank", current: latestPlankSeconds, goal: profile.goalPlankSeconds, seconds: true, benchmark: "Benchmark: 2:00")
        }
    }
}

private struct AthleteProgressOverviewCard: View {
    var rank: RankState
    var sessions: [WorkoutSession]
    var runningProfile: RunningTrainingProfile
    var runLogs: [RunningLog]
    var strengthLogs: [PerformanceLog]

    private var plannedThisWeek: [WorkoutSession] {
        let start = currentWeekStart()
        let end = Calendar.current.date(byAdding: .day, value: 7, to: start) ?? start
        return sessions.filter { $0.scheduledDate >= start && $0.scheduledDate < end }
    }

    private var completedCount: Int {
        plannedThisWeek.filter { $0.status == .completed || $0.status == .deload }.count
    }

    private var plannedCount: Int {
        plannedThisWeek.count
    }

    private var runKm14Days: Double {
        let cutoff = Calendar.current.date(byAdding: .day, value: -14, to: Date()) ?? Date.distantPast
        return runLogs.filter { $0.completedAt >= cutoff }.map(\.distanceKm).reduce(0, +)
    }

    private var status: ProgressOverviewState {
        if (strengthLogs.first?.painLevel ?? 0) >= 4 || (runLogs.first?.painLevel ?? 0) >= 4 || runLogs.first?.hadGIIssues == true {
            return .recovery
        }
        if plannedThisWeek.filter({ $0.status == .missed }).count > 0 {
            return .careful
        }
        return .green
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Athlete overview")
                        .font(.headline)
                    Text("\(runningProfile.background.title) · \(runningProfile.durability.title)")
                        .font(.caption)
                        .foregroundStyle(AppTheme.muted)
                }
                Spacer()
                StatusPill(text: status.title, color: status.color, systemImage: status.icon)
            }

            HStack(spacing: 8) {
                UltraMetricTile(title: "Week", value: "\(completedCount)/\(max(plannedCount, 1))", subtitle: "Sessions done")
                UltraMetricTile(title: "Run load", value: distanceText(km: runKm14Days), subtitle: "Last 14 days", color: AppTheme.gold)
            }
            InfoLine(title: "Strength rank", value: "\(rank.rank.title) · \(rank.xp) XP")
            InfoLine(title: "Race target", value: "\(runningProfile.targetRaceKm) km by \(runningProfile.targetRaceDate.formatted(date: .abbreviated, time: .omitted))")
        }
        .card()
    }
}

private enum ProgressOverviewState {
    case green
    case careful
    case recovery

    var title: String {
        switch self {
        case .green: "Green"
        case .careful: "Careful"
        case .recovery: "Recovery"
        }
    }

    var color: Color {
        switch self {
        case .green: AppTheme.accent
        case .careful: AppTheme.gold
        case .recovery: AppTheme.warning
        }
    }

    var icon: String {
        switch self {
        case .green: "checkmark.circle.fill"
        case .careful: "exclamationmark.circle.fill"
        case .recovery: "heart.fill"
        }
    }
}

private struct MilestoneCard: View {
    var profile: UserProfile
    var runningProfile: RunningTrainingProfile
    var latestPullUps: Int
    var latestPushUps: Int
    var latestPlankSeconds: Int
    var longestRun: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Next milestones", systemImage: "flag.checkered")
                .font(.headline)
            InfoLine(title: "Strength", value: "\(latestPullUps)/\(profile.goalPullUps) pull · \(latestPushUps)/\(profile.goalPushUps) push · \(format(seconds: latestPlankSeconds))/\(format(seconds: profile.goalPlankSeconds)) plank")
            InfoLine(title: "Running", value: "\(distanceText(km: longestRun)) long run toward \(runningProfile.targetRaceKm) km")
        }
        .card()
    }
}

private struct UltraProgressCard: View {
    var profile: RunningTrainingProfile
    var logs: [RunningLog]

    private var recentLogs: [RunningLog] {
        let cutoff = Calendar.current.date(byAdding: .day, value: -14, to: Date()) ?? Date.distantPast
        return logs.filter { $0.completedAt >= cutoff }
    }

    private var recentKm: Double {
        recentLogs.map(\.distanceKm).reduce(0, +)
    }

    private var longestRun: Double {
        logs.map(\.distanceKm).max() ?? Double(profile.currentLongRunKm)
    }

    private var latestRun: RunningLog? {
        logs.first
    }

    private var readiness: String {
        guard let latestRun else { return "Baseline" }
        if latestRun.painLevel >= 4 || latestRun.fatigueLevel >= 9 || latestRun.hadGIIssues {
            return "Recovery"
        }
        return "Building"
    }

    private var readinessColor: Color {
        readiness == "Recovery" ? AppTheme.warning : AppTheme.accent
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Running durability", systemImage: "figure.run")
                    .font(.headline)
                Spacer()
                StatusPill(text: readiness, color: readinessColor, systemImage: readiness == "Recovery" ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
            }
            HStack(spacing: 8) {
                UltraMetricTile(title: "14-day km", value: distanceText(km: recentKm), subtitle: "Recent run load")
                UltraMetricTile(title: "Long run", value: distanceText(km: longestRun), subtitle: "Durability anchor", color: AppTheme.gold)
            }
            VStack(spacing: 8) {
                InfoLine(title: "Target", value: "\(profile.targetRaceKm) km by \(profile.targetRaceDate.formatted(date: .abbreviated, time: .omitted))")
                InfoLine(title: "Easy guide", value: "\(paceText(secondsPerKm: profile.easyPaceSecondsPerKm)) · HR \(profile.easyHeartRate)")
                InfoLine(title: "Walk strategy", value: profile.walkStrategy.title)
                if let latestRun {
                    InfoLine(title: "Latest fuel", value: latestRun.carbsPerHour > 0 ? "\(latestRun.carbsPerHour)g carbs/hr" : "Not logged")
                }
            }
        }
        .card()
    }
}

private struct RunningTrendCard: View {
    var profile: RunningTrainingProfile
    var logs: [RunningLog]

    private var latest: RunningLog? { logs.first }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Running trend", systemImage: "waveform.path.ecg")
                .font(.headline)
            InfoLine(title: "Background", value: profile.background.title)
            InfoLine(title: "Durability", value: profile.durability.title)
            InfoLine(title: "Easy pace", value: paceText(secondsPerKm: profile.easyPaceSecondsPerKm))
            InfoLine(title: "Easy HR", value: "\(profile.easyHeartRate) bpm")
            InfoLine(title: "Walk strategy", value: profile.walkStrategy.title)
            if let latest {
                InfoLine(title: "Latest run", value: "\(distanceText(km: latest.distanceKm)) · \(minutesText(latest.durationMinutes)) · \(paceText(secondsPerKm: latest.averagePaceSecondsPerKm))")
            }
        }
        .card()
    }
}

private struct UltraMetricTile: View {
    var title: String
    var value: String
    var subtitle: String
    var color: Color = AppTheme.accent

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppTheme.muted)
            Text(value)
                .font(.system(.title3, design: .rounded, weight: .bold))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
            Text(subtitle)
                .font(.caption2)
                .foregroundStyle(AppTheme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(AppTheme.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
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
