import Charts
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
                if let raceGoal = raceGoals.first {
                    RaceCountdownHero(raceGoal: raceGoal)
                }
                if let snapshot = snapshots.first {
                    ReadinessStrip(snapshot: snapshot, history: Array(snapshots.prefix(14)))
                }
                if raceGoals.first != nil || !runLogs.isEmpty {
                    RunningSection(runLogs: runLogs, sessions: sessions)
                }
                coreProgress
            }
        }
    }

    private var coreProgress: some View {
        VStack(alignment: .leading, spacing: 18) {
            ConsistencyLedger(rank: rank, missedTrainingCount: missedTrainingCount)
            strengthGoals
        }
    }

    private var strengthGoals: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader("Strength goals")
            GoalProgressRow(title: "Pull-ups", current: latestPullUps, goal: profile.goalPullUps, benchmark: "Benchmark: 20 reps")
            GoalProgressRow(title: "Push-ups", current: latestPushUps, goal: profile.goalPushUps, benchmark: "Benchmark: 50 reps")
            GoalProgressRow(title: "Plank", current: latestPlankSeconds, goal: profile.goalPlankSeconds, seconds: true, benchmark: "Benchmark: 2:00")
        }
    }
}

// MARK: - Race hero

/// The emotional headline of an ultra block: how many weeks remain.
private struct RaceCountdownHero: View {
    var raceGoal: RaceGoal

    private var calendar: Calendar { Calendar.current }

    // Same weeks math as CoachView's weeksToRaceText: ceil of remaining days / 7.
    private var weeksOut: Int {
        let days = max(0, calendar.dateComponents([.day], from: calendar.startOfDay(for: Date()), to: raceGoal.raceDate).day ?? 0)
        return (days + 6) / 7
    }

    private var raceName: String {
        let trimmed = raceGoal.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Race" : trimmed
    }

    private var metaText: String {
        var parts: [String] = []
        if raceGoal.distanceKm > 0 {
            parts.append("\(raceGoal.distanceKm.formatted(.number.precision(.fractionLength(0...1)))) km")
        }
        if raceGoal.elevationGainM > 0 {
            parts.append("\(raceGoal.elevationGainM) m+")
        }
        parts.append(raceGoal.raceDate.formatted(date: .abbreviated, time: .omitted))
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            MicroLabel(text: "RACE GOAL", color: AppTheme.accent)
            if weeksOut == 0 {
                Text("Race week")
                    .font(.lockinDisplay)
                    .foregroundStyle(AppTheme.text)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(weeksOut)")
                        .font(.lockinNumeral(40))
                        .foregroundStyle(AppTheme.text)
                        .contentTransition(.numericText())
                    Text(weeksOut == 1 ? "week out" : "weeks out")
                        .font(.system(size: 17))
                        .foregroundStyle(AppTheme.muted)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(raceName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.text)
                Text(metaText)
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(AppTheme.muted)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Readiness

private struct ReadinessStrip: View {
    var snapshot: GarminDailySnapshot
    var history: [GarminDailySnapshot] = []

    private var readinessTrend: [GarminDailySnapshot] {
        history.filter { $0.trainingReadiness > 0 }.sorted { $0.date < $1.date }
    }

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
        snapshotAgeDays > 1 ? AppTheme.warning : AppTheme.faint
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader("Readiness") {
                Text(snapshotAgeText)
                    .font(.system(size: 12))
                    .foregroundStyle(snapshotAgeColor)
            }

            VStack(spacing: 0) {
                Hairline()
                HStack(spacing: 0) {
                    cell(label: "SLEEP", value: metricText(snapshot.sleepScore), detail: "Overnight")
                    columnRule
                    cell(label: "HRV", value: hrvDisplayValue, detail: hrvDisplayDetail)
                        .padding(.leading, 14)
                    columnRule
                    cell(label: "BATTERY", value: metricText(snapshot.bodyBattery), detail: "Charge")
                        .padding(.leading, 14)
                }
                Hairline()
                HStack(spacing: 0) {
                    cell(label: "READINESS", value: metricText(snapshot.trainingReadiness), detail: "Score")
                    columnRule
                    cell(label: "RESTING HR", value: metricText(snapshot.restingHr), detail: "bpm")
                        .padding(.leading, 14)
                }
                Hairline()
                // Two weeks of readiness as a quiet line — a snapshot alone
                // can't say whether you're trending up or digging a hole.
                if readinessTrend.count >= 3 {
                    Chart(readinessTrend, id: \.date) { day in
                        LineMark(
                            x: .value("Day", day.date, unit: .day),
                            y: .value("Readiness", day.trainingReadiness)
                        )
                        .interpolationMethod(.catmullRom)
                        .foregroundStyle(AppTheme.accent.opacity(0.8))
                        .lineStyle(StrokeStyle(lineWidth: 1.5))
                    }
                    .chartXAxis(.hidden)
                    .chartYAxis(.hidden)
                    .chartYScale(domain: 0...100)
                    .frame(height: 36)
                    .padding(.vertical, 10)
                    .accessibilityLabel("Training readiness, last \(readinessTrend.count) days")
                    Hairline()
                }
            }
        }
    }

    private var columnRule: some View {
        Rectangle()
            .fill(AppTheme.divider)
            .frame(width: 1, height: 34)
    }

    private func cell(label: String, value: String, detail: String?) -> some View {
        MetricCell(model: MetricCellModel(
            label: label,
            value: value,
            detail: detail,
            valueColor: value == "—" ? AppTheme.faint : AppTheme.text
        ))
        .padding(.vertical, 12)
    }

    // The Garmin sidecar zero-fills missing metrics, so zero means "no data".
    private func metricText(_ value: Int) -> String {
        value > 0 ? "\(value)" : "—"
    }

    /// The status word is the headline when Garmin provides one; the raw ms
    /// reading only surfaces when there is no status. Both never compete for
    /// the same cell width.
    private var hrvDisplayValue: String {
        let trimmed = snapshot.hrvStatus.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            return trimmed.replacingOccurrences(of: "_", with: " ").capitalized
        }
        return snapshot.hrvMs > 0 ? "\(snapshot.hrvMs)" : "—"
    }

    private var hrvDisplayDetail: String? {
        let trimmed = snapshot.hrvStatus.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return nil }
        return snapshot.hrvMs > 0 ? "ms" : nil
    }
}

// MARK: - Running

private struct RunningSection: View {
    var runLogs: [RunLog]
    var sessions: [WorkoutSession] = []

    private var calendar: Calendar { Calendar.current }

    // Garmin-completed runs count toward volume immediately; feedback can land later.
    private var confirmedLogs: [RunLog] {
        confirmedGarminRunLogs(from: runLogs)
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

    private struct WeekVolume: Identifiable {
        let weekStart: Date
        let km: Double
        let plannedKm: Double
        let isCurrent: Bool
        var id: Date { weekStart }
    }

    /// Eight calendar weeks ending in the current one — actual Garmin
    /// volume next to what the plan asked for.
    private var weeklyVolumes: [WeekVolume] {
        guard let thisWeek = thisWeekInterval else { return [] }
        return (0..<8).reversed().compactMap { offset in
            guard let start = calendar.date(byAdding: .weekOfYear, value: -offset, to: thisWeek.start) else { return nil }
            let end = calendar.date(byAdding: .weekOfYear, value: 1, to: start) ?? start
            let km = confirmedLogs
                .filter { start <= $0.completedAt && $0.completedAt < end }
                .reduce(0) { $0 + $1.distanceKm }
            let plannedKm = sessions
                .filter { $0.isRun && start <= $0.scheduledDate && $0.scheduledDate < end }
                .reduce(0) { $0 + $1.plannedDistanceKm }
            return WeekVolume(weekStart: start, km: km, plannedKm: plannedKm, isCurrent: offset == 0)
        }
    }

    private var hasChartData: Bool {
        weeklyVolumes.contains { $0.km > 0 || $0.plannedKm > 0 }
    }

    private var hasPlannedData: Bool {
        weeklyVolumes.contains { $0.plannedKm > 0 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            MicroLabel(text: "RUNNING")

            if hasChartData {
                Chart(weeklyVolumes) { week in
                    if hasPlannedData {
                        BarMark(
                            x: .value("Week", week.weekStart, unit: .weekOfYear),
                            y: .value("Planned", week.plannedKm),
                            width: .ratio(0.28)
                        )
                        .position(by: .value("Kind", "Planned"))
                        .foregroundStyle(AppTheme.faint.opacity(0.45))
                        .cornerRadius(1.5)
                    }
                    BarMark(
                        x: .value("Week", week.weekStart, unit: .weekOfYear),
                        y: .value("Actual", week.km),
                        width: .ratio(hasPlannedData ? 0.28 : 0.55)
                    )
                    .position(by: .value("Kind", "Actual"))
                    .foregroundStyle(week.isCurrent ? AppTheme.accent : AppTheme.accent.opacity(0.30))
                    .cornerRadius(1.5)
                }
                .chartXAxis(.hidden)
                .chartYAxis(.hidden)
                .chartLegend(.hidden)
                .frame(height: 56)
                .accessibilityLabel("Weekly running volume, planned and actual, last 8 weeks")

                if hasPlannedData {
                    HStack(spacing: 14) {
                        legendDot(color: AppTheme.faint.opacity(0.45), label: "Planned")
                        legendDot(color: AppTheme.accent, label: "Actual")
                    }
                }
            }

            VStack(spacing: 10) {
                InfoLine(title: "This week", value: volumeText(in: thisWeekInterval))
                InfoLine(title: "Last week", value: volumeText(in: lastWeekInterval))
                InfoLine(title: "Longest run (6 weeks)", value: longestRunText)
            }
        }
        .ruled(verticalPadding: 16)
    }

    private func volumeText(in interval: DateInterval?) -> String {
        guard let interval else { return "—" }
        let logs = confirmedLogs.filter { interval.start <= $0.completedAt && $0.completedAt < interval.end }
        let km = logs.reduce(0) { $0 + $1.distanceKm }
        let elevation = logs.reduce(0) { $0 + $1.elevationGainM }
        let descent = logs.reduce(0) { $0 + $1.elevationLossM }
        var text = "\(runDistanceText(km: km)) · \(elevation) m+"
        // Descent drives downhill conditioning for an ultra block; show it as
        // soon as the Garmin pipeline starts delivering it.
        if descent > 0 {
            text += " · \(descent) m−"
        }
        return text
    }

    private var longestRunText: String {
        longestRecentRunKm > 0 ? runDistanceText(km: longestRecentRunKm) : "—"
    }

    private func legendDot(color: Color, label: String) -> some View {
        HStack(spacing: 5) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(color)
                .frame(width: 8, height: 8)
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(AppTheme.faint)
        }
    }
}

// MARK: - Consistency

private struct ConsistencyLedger: View {
    var rank: RankState
    var missedTrainingCount: Int

    var body: some View {
        VStack(spacing: 0) {
            Hairline()
            HStack(spacing: 0) {
                MetricCell(model: MetricCellModel(label: "STREAK", value: "\(rank.streak)", detail: "sessions"))
                    .padding(.vertical, 8)
                Rectangle()
                    .fill(AppTheme.divider)
                    .frame(width: 1, height: 30)
                MetricCell(model: MetricCellModel(label: "BEST", value: "\(rank.displayedBestStreak)"))
                    .padding(.leading, 14)
                    .padding(.vertical, 8)
            }
            Hairline()
            HStack(alignment: .firstTextBaseline) {
                MicroLabel(text: "MISSED TRAININGS")
                Spacer()
                Text("\(missedTrainingCount)")
                    .font(.lockinNumeral(22))
                    .foregroundStyle(missedTrainingCount > 0 ? AppTheme.warning : AppTheme.text)
                    .contentTransition(.numericText())
            }
            .padding(.vertical, 8)
            .accessibilityElement(children: .combine)
            Hairline()
        }
    }
}
