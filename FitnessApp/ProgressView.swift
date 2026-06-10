import SwiftData
import SwiftUI

struct ProgressView: View {
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query private var ranks: [RankState]
    @Query(sort: \GarminDailySnapshot.date, order: .reverse) private var snapshots: [GarminDailySnapshot]
    @Query(sort: \RunLog.completedAt, order: .reverse) private var runLogs: [RunLog]
    @Query(sort: \RaceGoal.createdAt) private var raceGoals: [RaceGoal]

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
            if let snapshot = snapshots.first {
                ReadinessStripCard(snapshot: snapshot)
            }
            if let raceGoal = raceGoals.first {
                RunningProgressCard(raceGoal: raceGoal, runLogs: runLogs)
            }
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

private struct ReadinessStripCard: View {
    var snapshot: GarminDailySnapshot

    // Whole calendar days between the snapshot and today, so a stale
    // snapshot is labeled honestly instead of looking current.
    private var snapshotAgeDays: Int {
        let calendar = Calendar.current
        return calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: snapshot.date),
            to: calendar.startOfDay(for: Date())
        ).day ?? 0
    }

    private var snapshotAgeText: String {
        switch snapshotAgeDays {
        case ...0: return "Today"
        case 1: return "Yesterday"
        default: return "\(snapshotAgeDays) days ago"
        }
    }

    private var snapshotAgeColor: Color {
        snapshotAgeDays > 1 ? AppTheme.warning : AppTheme.muted
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Readiness")
                    .font(.headline)
                Spacer()
                Text(snapshotAgeText)
                    .font(.caption2)
                    .foregroundStyle(snapshotAgeColor)
            }
            HStack(spacing: 8) {
                ReadinessTile(
                    title: "Sleep score",
                    value: metricText(snapshot.sleepScore),
                    status: "Overnight",
                    color: tileColor(hasData: snapshot.sleepScore > 0)
                )
                ReadinessTile(
                    title: "HRV status",
                    value: hrvValue,
                    status: hrvDetail,
                    color: tileColor(hasData: hrvValue != "—")
                )
                ReadinessTile(
                    title: "Body battery",
                    value: metricText(snapshot.bodyBattery),
                    status: "Charge",
                    color: tileColor(hasData: snapshot.bodyBattery > 0)
                )
            }
            HStack(spacing: 8) {
                ReadinessTile(
                    title: "Training readiness",
                    value: metricText(snapshot.trainingReadiness),
                    status: "Score",
                    color: tileColor(hasData: snapshot.trainingReadiness > 0)
                )
                ReadinessTile(
                    title: "Resting HR",
                    value: metricText(snapshot.restingHr),
                    status: "bpm",
                    color: tileColor(hasData: snapshot.restingHr > 0)
                )
            }
        }
    }

    // The Garmin sidecar zero-fills missing metrics, so zero means "no data".
    private func metricText(_ value: Int) -> String {
        value > 0 ? "\(value)" : "—"
    }

    private var hrvValue: String {
        let trimmed = snapshot.hrvStatus.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "—" }
        return trimmed.replacingOccurrences(of: "_", with: " ").capitalized
    }

    private var hrvDetail: String {
        snapshot.hrvMs > 0 ? "\(snapshot.hrvMs) ms" : "Overnight"
    }

    private func tileColor(hasData: Bool) -> Color {
        hasData ? AppTheme.accent : AppTheme.muted
    }
}

private struct RunningProgressCard: View {
    var raceGoal: RaceGoal
    var runLogs: [RunLog]

    private var calendar: Calendar { Calendar.current }

    // Only confirmed runs count toward volume; pending Garmin matches are excluded.
    private var confirmedLogs: [RunLog] {
        runLogs.filter { !$0.needsConfirmation }
    }

    // Calendar weeks (Garmin convention), intentionally not the coach's rolling plan window.
    private var thisWeekInterval: DateInterval? {
        calendar.dateInterval(of: .weekOfYear, for: Date())
    }

    private var lastWeekInterval: DateInterval? {
        guard let thisWeek = thisWeekInterval,
              let lastWeekStart = calendar.date(byAdding: .weekOfYear, value: -1, to: thisWeek.start)
        else { return nil }
        return DateInterval(start: lastWeekStart, end: thisWeek.start)
    }

    private var longestRecentRunKm: Double {
        let cutoff = calendar.date(byAdding: .weekOfYear, value: -6, to: calendar.startOfDay(for: Date())) ?? Date()
        return confirmedLogs
            .filter { $0.completedAt >= cutoff }
            .map(\.distanceKm)
            .max() ?? 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Running".uppercased())
                .font(.caption.weight(.bold))
                .foregroundStyle(AppTheme.text)
            InfoLine(title: "This week", value: volumeText(in: thisWeekInterval))
            InfoLine(title: "Last week", value: volumeText(in: lastWeekInterval))
            InfoLine(title: "Longest run (6 weeks)", value: longestRunText)
            Label(raceCountdownText, systemImage: "flag.checkered")
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppTheme.gold)
        }
        .card()
    }

    private func volumeText(in interval: DateInterval?) -> String {
        guard let interval else { return "—" }
        let logs = confirmedLogs.filter { interval.start <= $0.completedAt && $0.completedAt < interval.end }
        let km = logs.reduce(0) { $0 + $1.distanceKm }
        let elevation = logs.reduce(0) { $0 + $1.elevationGainM }
        return "\(runDistanceText(km: km)) · \(elevation) m+"
    }

    private var longestRunText: String {
        longestRecentRunKm > 0 ? runDistanceText(km: longestRecentRunKm) : "—"
    }

    // Same weeks math as CoachView's weeksToRaceText: ceil of remaining days / 7.
    private var raceCountdownText: String {
        let days = max(0, calendar.dateComponents([.day], from: calendar.startOfDay(for: Date()), to: raceGoal.raceDate).day ?? 0)
        let weeks = (days + 6) / 7
        if weeks == 0 { return "Race week" }
        let trimmedName = raceGoal.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = trimmedName.isEmpty ? "Race" : trimmedName
        return weeks == 1 ? "1 week to \(name)" : "\(weeks) weeks to \(name)"
    }
}
