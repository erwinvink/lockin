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

    private var streakSnapshot: TrainingStreakSnapshot {
        let computed = trainingStreakSnapshot(from: sessions)
        if computed.best > 0 { return computed }
        return TrainingStreakSnapshot(current: rank.streak, best: rank.displayedBestStreak)
    }

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "Progress") {
                if let raceGoal = raceGoals.first {
                    RaceHeader(raceGoal: raceGoal)
                }
                if raceGoals.first != nil || !runLogs.isEmpty {
                    WeeklyDistanceCard(runLogs: runLogs, sessions: sessions, raceGoal: raceGoals.first)
                }
                strengthGoals
                // Only today's or yesterday's wellness reads as current
                // readiness; older snapshots would mislead.
                if let snapshot = freshReadinessSnapshot(from: snapshots) {
                    ReadinessCard(snapshot: snapshot, history: Array(snapshots.prefix(14)))
                }
                ConsistencyRow(streak: streakSnapshot, missedTrainingCount: missedTrainingCount)
            }
        }
    }

    private var strengthGoals: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader("Strength goals")
            VStack(spacing: 0) {
                SummitGoalRow(
                    title: "Pull-ups",
                    current: latestPullUps,
                    goal: profile.goalPullUps,
                    start: profile.baselinePullUps,
                    benchmark: "20"
                )
                Hairline()
                SummitGoalRow(
                    title: "Push-ups",
                    current: latestPushUps,
                    goal: profile.goalPushUps,
                    start: profile.baselinePushUps,
                    benchmark: "50"
                )
                Hairline()
                SummitGoalRow(
                    title: "Plank",
                    current: latestPlankSeconds,
                    goal: profile.goalPlankSeconds,
                    start: profile.baselinePlankSeconds,
                    seconds: true,
                    benchmark: "2:00"
                )
            }
            .padding(.horizontal, 14)
            .card(padding: 0)
        }
    }
}

// MARK: - Race header

/// The route's destination: race name, what it asks, and the weeks left on
/// a yellow plate.
private struct RaceHeader: View {
    var raceGoal: RaceGoal

    private var calendar: Calendar { Calendar.current }

    /// Whole days to race day; negative once it has passed.
    private var daysToRace: Int {
        calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: Date()),
            to: calendar.startOfDay(for: raceGoal.raceDate)
        ).day ?? 0
    }

    // Same weeks math as CoachView's weeksToRaceText: ceil of remaining days / 7.
    private var weeksOut: Int {
        (max(0, daysToRace) + 6) / 7
    }

    private var countdown: (value: String, unit: String) {
        if daysToRace < 0 { return ("Done", "race day passed") }
        if weeksOut == 0 { return ("This", "is race week") }
        return ("\(weeksOut)", weeksOut == 1 ? "week left" : "weeks left")
    }

    private var raceName: String {
        let trimmed = raceGoal.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Race" : trimmed
    }

    private var metaText: String {
        var parts = [raceGoal.raceDate.formatted(.dateTime.day().month(.wide))]
        if raceGoal.distanceKm > 0 {
            parts.append("\(raceGoal.distanceKm.formatted(.number.precision(.fractionLength(0...1)))) km")
        }
        if raceGoal.elevationGainM > 0 {
            parts.append("\(raceGoal.elevationGainM) m climb")
        }
        return parts.joined(separator: ", ")
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Route to race day")
                    .font(.trail(15, .medium, relativeTo: .subheadline))
                    .foregroundStyle(AppTheme.muted)
                Text(raceName)
                    .font(.trail(28, .bold, relativeTo: .title1))
                    .foregroundStyle(AppTheme.text)
                    .fixedSize(horizontal: false, vertical: true)
                Text(metaText)
                    .font(.trail(15, .regular, relativeTo: .subheadline).monospacedDigit())
                    .foregroundStyle(AppTheme.muted)
            }
            Spacer(minLength: 8)
            VStack(spacing: 0) {
                Text(countdown.value)
                    .font(.lockinNumeral(32))
                    .contentTransition(.numericText())
                Text(countdown.unit)
                    .font(.trail(12, .semibold, relativeTo: .caption1))
            }
            .foregroundStyle(AppTheme.text)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(AppTheme.sign))
            .accessibilityElement(children: .combine)
        }
    }
}

// MARK: - Weekly distance

/// Eight calendar weeks of running drawn like an elevation profile, with
/// you marked on the current week and the trail running on to race day.
private struct WeeklyDistanceCard: View {
    var runLogs: [RunLog]
    var sessions: [WorkoutSession] = []
    var raceGoal: RaceGoal?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var calendar: Calendar { Calendar.current }

    // Garmin-completed runs count toward volume immediately; feedback can land later.
    private var confirmedLogs: [RunLog] {
        confirmedRunLogs(from: runLogs)
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

    private var raceIsAhead: Bool {
        guard let raceGoal else { return false }
        return calendar.startOfDay(for: raceGoal.raceDate) >= calendar.startOfDay(for: Date())
    }

    private var yMax: Double {
        let peak = weeklyVolumes.map { max($0.km, $0.plannedKm) }.max() ?? 0
        return max(10, peak * 1.35)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Weekly distance")
                    .font(.trail(17, .semibold, relativeTo: .headline))
                    .foregroundStyle(AppTheme.text)
                Spacer()
                Text("Last 8 weeks")
                    .font(.lockinMeta)
                    .foregroundStyle(AppTheme.muted)
            }

            if hasChartData {
                HStack(alignment: .bottom, spacing: 0) {
                    profileChart
                    if raceIsAhead {
                        RaceFlagTail()
                            .frame(width: 64, height: 120, alignment: .bottom)
                    }
                }

                HStack {
                    Text("8 weeks ago")
                    Spacer()
                    Text(raceIsAhead ? "Race day" : "This week")
                }
                .font(.trail(12, .regular, relativeTo: .caption1))
                .foregroundStyle(AppTheme.muted)

                if hasPlannedData {
                    HStack(spacing: 14) {
                        legendLine(dashed: false, label: "Run")
                        legendLine(dashed: true, label: "Planned")
                    }
                }
            } else {
                Text("No runs yet. Garmin runs show up here once they sync.")
                    .font(.lockinBody)
                    .foregroundStyle(AppTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Hairline()

            HStack(alignment: .top, spacing: 8) {
                statColumn(value: distanceText(in: thisWeekInterval), caption: climbCaption("This week", in: thisWeekInterval))
                statColumn(value: distanceText(in: lastWeekInterval), caption: climbCaption("Last week", in: lastWeekInterval))
                statColumn(value: longestRunText, caption: "Longest run")
            }
        }
        .card(padding: 14)
    }

    private var profileChart: some View {
        Chart {
            ForEach(weeklyVolumes) { week in
                AreaMark(
                    x: .value("Week", week.weekStart, unit: .weekOfYear),
                    y: .value("Kilometres", week.km)
                )
                .foregroundStyle(AppTheme.post.opacity(0.35))
                .interpolationMethod(.linear)

                LineMark(
                    x: .value("Week", week.weekStart, unit: .weekOfYear),
                    y: .value("Kilometres", week.km),
                    series: .value("Kind", "Run")
                )
                .foregroundStyle(AppTheme.text)
                .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
                .interpolationMethod(.linear)

                if hasPlannedData {
                    LineMark(
                        x: .value("Week", week.weekStart, unit: .weekOfYear),
                        y: .value("Kilometres", week.plannedKm),
                        series: .value("Kind", "Planned")
                    )
                    .foregroundStyle(AppTheme.post)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, dash: [3, 5]))
                    .interpolationMethod(.linear)
                }
            }

            if let current = weeklyVolumes.last {
                PointMark(
                    x: .value("Week", current.weekStart, unit: .weekOfYear),
                    y: .value("Kilometres", current.km)
                )
                .symbol {
                    Circle()
                        .fill(AppTheme.sign)
                        .overlay(Circle().strokeBorder(AppTheme.text, lineWidth: 2.5))
                        .frame(width: 16, height: 16)
                }
                .annotation(position: .top, alignment: .trailing, spacing: 6) {
                    Text("You, \(runDistanceText(km: current.km))")
                        .font(.trail(13, .semibold, relativeTo: .footnote).monospacedDigit())
                        .foregroundStyle(AppTheme.text)
                        .fixedSize()
                }
            }
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
        .chartYScale(domain: 0...yMax)
        .frame(height: 120)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Weekly running distance, last 8 weeks")
        .accessibilityValue(weeklyVolumes.map { runDistanceText(km: $0.km) }.joined(separator: ", "))
    }

    private func statColumn(value: String, caption: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value)
                .font(.trail(19, .bold, relativeTo: .headline).monospacedDigit())
                .foregroundStyle(AppTheme.text)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
            Text(caption)
                .font(.trail(12, .regular, relativeTo: .caption1).monospacedDigit())
                .foregroundStyle(AppTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func logs(in interval: DateInterval?) -> [RunLog] {
        guard let interval else { return [] }
        return confirmedLogs.filter { interval.start <= $0.completedAt && $0.completedAt < interval.end }
    }

    private func distanceText(in interval: DateInterval?) -> String {
        runDistanceText(km: logs(in: interval).reduce(0) { $0 + $1.distanceKm })
    }

    /// "This week, +420 m": the climb, and the descent once Garmin delivers
    /// it, since downhill conditioning matters in an ultra block.
    private func climbCaption(_ label: String, in interval: DateInterval?) -> String {
        let weekLogs = logs(in: interval)
        let climb = weekLogs.reduce(0) { $0 + $1.elevationGainM }
        let descent = weekLogs.reduce(0) { $0 + $1.elevationLossM }
        guard climb > 0 || descent > 0 else { return label }
        var text = "\(label), +\(climb)"
        if descent > 0 {
            text += " \u{2212}\(descent)"
        }
        return text + " m"
    }

    private var longestRunText: String {
        longestRecentRunKm > 0 ? runDistanceText(km: longestRecentRunKm) : "—"
    }

    private func legendLine(dashed: Bool, label: String) -> some View {
        HStack(spacing: 6) {
            TrailLine(axis: .horizontal)
                .stroke(
                    dashed ? AppTheme.post : AppTheme.text,
                    style: StrokeStyle(lineWidth: 2.5, lineCap: .round, dash: dashed ? [3, 4] : [])
                )
                .frame(width: 18, height: 3)
            Text(label)
                .font(.trail(12, .regular, relativeTo: .caption1))
                .foregroundStyle(AppTheme.muted)
        }
        .accessibilityHidden(true)
    }
}

/// The dashed trail on to race day, ending at a mountain-trail flag.
private struct RaceFlagTail: View {
    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            TrailLine(axis: .horizontal)
                .stroke(AppTheme.post, style: StrokeStyle(lineWidth: 2.5, lineCap: .round, dash: [2, 6]))
                .frame(height: 3)
                .padding(.trailing, 6)
            VStack(alignment: .leading, spacing: 0) {
                VStack(spacing: 0) {
                    Color.white
                    AppTheme.markerRed
                    Color.white
                }
                .frame(width: 22, height: 18)
                .overlay(Rectangle().strokeBorder(AppTheme.text.opacity(0.4), lineWidth: 1))
                .offset(x: 2.5)
                Spacer(minLength: 0)
            }
            .frame(height: 90, alignment: .top)
            .background(alignment: .leading) {
                Rectangle()
                    .fill(AppTheme.text)
                    .frame(width: 2.5)
            }
            .padding(.trailing, 20)
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Strength goals

/// One strength goal as a climb: where you are, the summit, where you began.
private struct SummitGoalRow: View {
    var title: String
    var current: Int
    var goal: Int
    var start: Int
    var seconds: Bool = false
    var benchmark: String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drawn = false

    private var progress: Double {
        min(1, max(0, Double(current) / Double(max(goal, 1))))
    }

    private func text(_ value: Int) -> String {
        seconds ? format(seconds: value) : "\(value)"
    }

    private var startCaption: String {
        let gain = current - start
        var caption = "Started at \(text(start))"
        if gain > 0 {
            caption += ", up \(text(gain))"
        }
        return caption + ". Benchmark \(benchmark)."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.lockinRowTitle)
                    .foregroundStyle(AppTheme.text)
                Spacer()
                Text(text(current))
                    .font(.trail(22, .bold, relativeTo: .title3).monospacedDigit())
                    .foregroundStyle(AppTheme.text)
                    .contentTransition(.numericText())
                Text("of \(text(goal))")
                    .font(.trail(15, .regular, relativeTo: .subheadline).monospacedDigit())
                    .foregroundStyle(AppTheme.muted)
            }

            HStack(spacing: 8) {
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Capsule().fill(AppTheme.surfaceRaised)
                        Capsule()
                            .fill(AppTheme.text)
                            .frame(width: max(8, proxy.size.width * (drawn ? progress : 0)))
                    }
                }
                .frame(height: 8)
                .accessibilityElement()
                .accessibilityLabel("\(title) goal")
                .accessibilityValue("\(Int(progress * 100)) percent")

                Image(systemName: "mountain.2")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(AppTheme.text)
                    .accessibilityHidden(true)
            }

            Text(startCaption)
                .font(.lockinMeta.monospacedDigit())
                .foregroundStyle(AppTheme.muted)
        }
        .padding(.vertical, 12)
        .onAppear {
            if reduceMotion {
                drawn = true
            } else {
                withAnimation(.smooth(duration: 0.7).delay(0.1)) { drawn = true }
            }
        }
    }
}

// MARK: - Readiness

private struct ReadinessCard: View {
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
        case ...0: return "Garmin, today"
        case 1: return "Garmin, last night"
        default: return "Garmin, \(snapshotAgeDays) days ago"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader("Readiness") {
                Text(snapshotAgeText)
                    .font(.lockinMeta)
                    .foregroundStyle(snapshotAgeDays > 1 ? AppTheme.markerRedText : AppTheme.muted)
            }

            VStack(spacing: 0) {
                Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                    GridRow {
                        cell(label: "Readiness", value: metricText(snapshot.trainingReadiness))
                        cell(label: "Sleep", value: metricText(snapshot.sleepScore))
                        cell(label: "Body battery", value: metricText(snapshot.bodyBattery))
                    }
                    GridRow {
                        Hairline()
                            .gridCellColumns(3)
                    }
                    GridRow {
                        cell(label: "HRV", value: hrvDisplayValue)
                            .gridCellColumns(2)
                        cell(label: "Resting HR", value: snapshot.restingHr > 0 ? "\(snapshot.restingHr) bpm" : "—")
                    }
                }
                // Two weeks of readiness as a quiet line: a snapshot alone
                // can't say whether you're trending up or digging a hole.
                if readinessTrend.count >= 3 {
                    Hairline()
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Readiness, last \(readinessTrend.count) days")
                            .font(.trail(12, .regular, relativeTo: .caption1))
                            .foregroundStyle(AppTheme.muted)
                        Chart(readinessTrend, id: \.date) { day in
                            LineMark(
                                x: .value("Day", day.date, unit: .day),
                                y: .value("Readiness", day.trainingReadiness)
                            )
                            .interpolationMethod(.catmullRom)
                            .foregroundStyle(AppTheme.text)
                            .lineStyle(StrokeStyle(lineWidth: 2))
                        }
                        .chartXAxis(.hidden)
                        .chartYAxis(.hidden)
                        .chartYScale(domain: 0...100)
                        .frame(height: 36)
                        .accessibilityLabel("Training readiness, last \(readinessTrend.count) days")
                    }
                    .padding(14)
                }
            }
            .card(padding: 0)
        }
    }

    private func cell(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.trail(12, .regular, relativeTo: .caption1))
                .foregroundStyle(AppTheme.muted)
            Text(value)
                .font(.trail(22, .bold, relativeTo: .title3).monospacedDigit())
                .foregroundStyle(value == "—" ? AppTheme.faint : AppTheme.text)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }

    // The Garmin sidecar zero-fills missing metrics, so zero means "no data".
    private func metricText(_ value: Int) -> String {
        value > 0 ? "\(value)" : "—"
    }

    /// The status word is the headline when Garmin provides one; the raw ms
    /// reading only surfaces when there is no status.
    private var hrvDisplayValue: String {
        let trimmed = snapshot.hrvStatus.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            return trimmed.replacingOccurrences(of: "_", with: " ").capitalized
        }
        return snapshot.hrvMs > 0 ? "\(snapshot.hrvMs) ms" : "—"
    }
}

// MARK: - Consistency

private struct ConsistencyRow: View {
    var streak: TrainingStreakSnapshot
    var missedTrainingCount: Int

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            stat(value: "\(streak.current)", label: "Sessions in a row")
            stat(value: "\(streak.best)", label: "Best streak")
            stat(
                value: "\(missedTrainingCount)",
                label: "Missed",
                valueColor: missedTrainingCount > 0 ? AppTheme.markerRedText : AppTheme.text
            )
        }
        .padding(.horizontal, 2)
    }

    private func stat(value: String, label: String, valueColor: Color = AppTheme.text) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value)
                .font(.lockinNumeral(28))
                .foregroundStyle(valueColor)
                .contentTransition(.numericText())
            Text(label)
                .font(.lockinMeta)
                .foregroundStyle(AppTheme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
