import SwiftData
import SwiftUI

struct ProgressView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query(sort: \RunningWorkout.scheduledDate) private var runningWorkouts: [RunningWorkout]
    @Query(sort: \RunningLog.completedAt, order: .reverse) private var runningLogs: [RunningLog]
    @Query(sort: \RunningProfile.createdAt) private var runningProfiles: [RunningProfile]
    @Query private var ranks: [RankState]

    var profile: UserProfile
    @State private var selectedMode = "Strength"
    @State private var isShowingActions = false
    @State private var isShowingManualRun = false
    @State private var isShowingManualStrength = false

    private var rank: RankState { ranks.first ?? RankState() }
    private var runningProfile: RunningProfile { runningProfiles.first ?? fallbackRunningProfile }
    private var fallbackRunningProfile: RunningProfile {
        RunningProfile(
            targetRaceName: "Comrades Marathon",
            raceDate: Calendar.current.date(byAdding: .month, value: 10, to: Date()) ?? Date(),
            weeklyDistanceTargetKm: 42,
            longRunTargetKm: 28
        )
    }

    var body: some View {
        NavigationStack {
            ScreenBackground(
                title: "Progress",
                trailing: AnyView(Button { isShowingActions = true } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(AppTheme.textPrimary)
                        .frame(width: 44, height: 44)
                }.buttonStyle(.plain))
            ) {
                SegmentedFilter(options: ["Strength", "Running"], selection: $selectedMode)

                if selectedMode == "Strength" {
                    strengthContent
                } else {
                    runningContent
                }
            }
            .navigationDestination(for: ProgressDestination.self) { destination in
                switch destination {
                case .consistency:
                    ConsistencyView(rank: rank, sessions: [], logs: logs)
                case .running:
                    RunningOverviewView(profile: runningProfile, workouts: runningWorkouts, logs: runningLogs)
                }
            }
            .confirmationDialog("Add training", isPresented: $isShowingActions, titleVisibility: .visible) {
                Button("Log strength result") { isShowingManualStrength = true }
                Button("Log run") { isShowingManualRun = true }
                Button("Add planned workout") { addPlannedWorkout() }
            }
            .sheet(isPresented: $isShowingManualRun) {
                ManualRunLogView()
            }
            .sheet(isPresented: $isShowingManualStrength) {
                ManualStrengthLogView(profile: profile)
            }
            .onAppear(perform: ensureRunningProfile)
        }
    }

    private var strengthContent: some View {
        VStack(alignment: .leading, spacing: AppTheme.cardGap) {
            GoalMetricCard(
                title: "Pull-ups",
                goalLabel: "Goal: \(profile.goalPullUps)",
                current: "\(latestPullUps)",
                target: "\(profile.goalPullUps)",
                percentage: progress(current: latestPullUps, goal: profile.goalPullUps),
                sparkline: sparklineValues(\.pullUps, flag: \.loggedPullUps),
                dateLabel: latestMetricDate
            )
            GoalMetricCard(
                title: "Push-ups",
                goalLabel: "Goal: \(profile.goalPushUps)",
                current: "\(latestPushUps)",
                target: "\(profile.goalPushUps)",
                percentage: progress(current: latestPushUps, goal: profile.goalPushUps),
                sparkline: sparklineValues(\.pushUps, flag: \.loggedPushUps),
                dateLabel: latestMetricDate
            )
            GoalMetricCard(
                title: "Plank",
                goalLabel: "Goal: \(format(seconds: profile.goalPlankSeconds))",
                current: format(seconds: latestPlankSeconds),
                target: format(seconds: profile.goalPlankSeconds),
                percentage: progress(current: latestPlankSeconds, goal: profile.goalPlankSeconds),
                sparkline: sparklineValues(\.plankSeconds, flag: \.loggedPlankSeconds),
                dateLabel: latestMetricDate
            )

            NavigationLink(value: ProgressDestination.consistency) {
                ConsistencySummaryCard(rank: rank, logs: logs)
            }
            .buttonStyle(.plain)
        }
    }

    private var runningContent: some View {
        VStack(alignment: .leading, spacing: AppTheme.cardGap) {
            NavigationLink(value: ProgressDestination.running) {
                RunningRaceCard(profile: runningProfile)
            }
            .buttonStyle(.plain)

            HStack(spacing: 8) {
                MetricCard(title: "This Week", value: "\(format(kilometers: weeklyRunDistance)) km", subtitle: "Distance", color: AppTheme.blueRunning)
                MetricCard(title: "Time", value: durationText(seconds: weeklyRunSeconds), subtitle: "Time on feet", color: AppTheme.olive)
                MetricCard(title: "Elev Gain", value: "\(weeklyElevation) m", subtitle: "Elevation", color: AppTheme.forest)
            }

            LockinCard {
                VStack(alignment: .leading, spacing: 12) {
                    SectionLabel(text: "Weekly Volume")
                    RunningBarChart(values: weeklyVolumeValues)
                }
            }
        }
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

    private var latestMetricDate: String? {
        logs.first?.completedAt.formatted(date: .abbreviated, time: .omitted)
    }

    private var weeklyRunLogs: [RunningLog] {
        let start = currentWeekStart()
        let end = Calendar.current.date(byAdding: .day, value: 7, to: start) ?? start
        return runningLogs.filter { $0.completedAt >= start && $0.completedAt < end }
    }

    private var weeklyRunDistance: Double {
        weeklyRunLogs.reduce(0) { $0 + $1.distanceKm }
    }

    private var weeklyRunSeconds: Int {
        weeklyRunLogs.reduce(0) { $0 + $1.durationSeconds }
    }

    private var weeklyElevation: Int {
        weeklyRunLogs.reduce(0) { $0 + $1.elevationMeters }
    }

    private var weeklyVolumeValues: [Double] {
        let calendar = Calendar.current
        let start = currentWeekStart()
        return (0..<8).map { weekOffset in
            let weekStart = calendar.date(byAdding: .day, value: -7 * (7 - weekOffset), to: start) ?? start
            let weekEnd = calendar.date(byAdding: .day, value: 7, to: weekStart) ?? weekStart
            return runningLogs
                .filter { $0.completedAt >= weekStart && $0.completedAt < weekEnd }
                .reduce(0) { $0 + $1.distanceKm }
        }
    }

    private func sparklineValues(_ value: KeyPath<PerformanceLog, Int>, flag: KeyPath<PerformanceLog, Bool>) -> [Double] {
        let values = logs
            .filter { $0[keyPath: flag] }
            .sorted { $0.completedAt < $1.completedAt }
            .suffix(8)
            .map { Double($0[keyPath: value]) }
        return values.isEmpty ? [0, 0.2, 0.34, 0.48] : values
    }

    private func progress(current: Int, goal: Int) -> Double {
        min(1, max(0, Double(current) / Double(max(goal, 1))))
    }

    private func ensureRunningProfile() {
        guard runningProfiles.isEmpty else { return }
        modelContext.insert(fallbackRunningProfile)
        try? modelContext.save()
    }

    private func addPlannedWorkout() {
        let date = Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
        modelContext.insert(WorkoutSession(
            scheduledDate: date,
            title: "Pull Strength",
            weekIndex: 0,
            focus: .pull,
            summary: "Manual planned strength session."
        ))
        try? modelContext.save()
    }
}

private enum ProgressDestination: Hashable {
    case consistency
    case running
}

private struct ConsistencySummaryCard: View {
    var rank: RankState
    var logs: [PerformanceLog]

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Consistency")
                        .font(.system(size: 18, weight: .semibold))
                    Spacer()
                    Text("\(min(7, rank.streak)) of 7")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(AppTheme.forest)
                }
                ConsistencyStrip(statuses: weekStatuses(logs: logs))
                HStack {
                    MetricPill(title: "Current Streak", value: "\(rank.streak) days")
                    Divider()
                    MetricPill(title: "Best Streak", value: "\(rank.bestStreak) days")
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.textTertiary)
                }
            }
        }
    }
}

struct ConsistencyView: View {
    var rank: RankState
    var sessions: [WorkoutSession]
    var logs: [PerformanceLog]
    @State private var selectedRange = "Week"

    var body: some View {
        ScreenBackground(title: "Consistency") {
            SegmentedFilter(options: ["Week", "Month", "Year"], selection: $selectedRange)
            LockinCard {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Text("This \(selectedRange)")
                            .font(.system(size: 18, weight: .semibold))
                        Spacer()
                        Text("\(completedThisWeek) of 7")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(AppTheme.forest)
                    }
                    ConsistencyStrip(statuses: weekStatuses(logs: logs))
                    HStack {
                        MetricPill(title: "Current Streak", value: "\(rank.streak) days")
                        Divider()
                        MetricPill(title: "Best Streak", value: "\(rank.bestStreak) days")
                    }
                }
            }

            LockinCard {
                VStack(alignment: .leading, spacing: 12) {
                    SectionLabel(text: "Consistency Score")
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("\(strengthScore)")
                            .font(.system(size: 42, weight: .medium))
                        Text("/ 100")
                            .foregroundStyle(AppTheme.textSecondary)
                    }
                    SparklineView(values: scoreSparkline)
                    Text("+\(min(6, max(0, rank.consistencyScore / 10))) from last week")
                        .font(.system(size: 12))
                        .foregroundStyle(AppTheme.textSecondary)
                }
            }
        }
    }

    private var completedThisWeek: Int {
        weekStatuses(logs: logs).filter { $0 == .completed || $0 == .today }.count
    }

    private var strengthScore: Int {
        min(100, max(0, 50 + rank.consistencyScore - rank.penaltyPoints / 2))
    }

    private var scoreSparkline: [Double] {
        [48, 52, 54, 59, 61, Double(strengthScore)]
    }
}

struct RunningRaceCard: View {
    var profile: RunningProfile

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Target Race")
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(profile.targetRaceName)
                            .font(.system(size: 20, weight: .semibold))
                        Text(profile.raceDate.formatted(date: .abbreviated, time: .omitted))
                            .font(.system(size: 12))
                            .foregroundStyle(AppTheme.textSecondary)
                        Text("\(daysUntil(profile.raceDate)) days to race")
                            .font(.system(size: 30, weight: .medium))
                            .foregroundStyle(AppTheme.textPrimary)
                    }
                    Spacer()
                    Image(systemName: "mountain.2")
                        .font(.system(size: 44, weight: .light))
                        .foregroundStyle(AppTheme.olive)
                }
            }
        }
    }
}

struct RunningOverviewView: View {
    var profile: RunningProfile
    var workouts: [RunningWorkout]
    var logs: [RunningLog]
    @State private var selectedTab = "Overview"
    @State private var isShowingManualRun = false

    var body: some View {
        ScreenBackground(
            title: "Running",
            trailing: AnyView(Button { isShowingManualRun = true } label: {
                Image(systemName: "plus").frame(width: 44, height: 44)
            }.buttonStyle(.plain))
        ) {
            SegmentedFilter(options: ["Overview", "Plan", "Workouts"], selection: $selectedTab)
            switch selectedTab {
            case "Plan":
                runningPlan
            case "Workouts":
                runningHistory
            default:
                runningOverview
            }
        }
        .sheet(isPresented: $isShowingManualRun) {
            ManualRunLogView()
        }
    }

    private var runningOverview: some View {
        VStack(alignment: .leading, spacing: AppTheme.cardGap) {
            RunningRaceCard(profile: profile)
            HStack(spacing: 8) {
                MetricCard(title: "Distance", value: "\(format(kilometers: weeklyDistance)) km", subtitle: "This week", color: AppTheme.blueRunning)
                MetricCard(title: "Time", value: durationText(seconds: weeklySeconds), subtitle: "Time", color: AppTheme.olive)
                MetricCard(title: "Elev Gain", value: "\(weeklyElevation) m", subtitle: "This week", color: AppTheme.forest)
            }
            LockinCard {
                VStack(alignment: .leading, spacing: 12) {
                    SectionLabel(text: "Weekly Volume")
                    RunningBarChart(values: weeklyVolumeValues)
                }
            }
        }
    }

    private var runningPlan: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "Upcoming")
                let planned = workouts.filter { $0.status == .planned }.sorted { $0.scheduledDate < $1.scheduledDate }
                if planned.isEmpty {
                    Text("No running week planned yet. Generate one from Coach or log a run manually.")
                        .font(.system(size: 14))
                        .foregroundStyle(AppTheme.textSecondary)
                } else {
                    ForEach(planned) { workout in
                        WorkoutRowCard(
                            title: workout.title,
                            subtitle: "\(format(kilometers: workout.distanceKm)) km - \(workout.zone)",
                            status: workout.scheduledDate.formatted(date: .abbreviated, time: .omitted),
                            systemImage: "figure.run",
                            tint: AppTheme.blueRunning
                        )
                    }
                }
            }
        }
    }

    private var runningHistory: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "Completed runs")
                let completed = workouts.filter { $0.status == .completed }.sorted { $0.scheduledDate > $1.scheduledDate }
                if completed.isEmpty {
                    Text("No completed runs yet.")
                        .font(.system(size: 14))
                        .foregroundStyle(AppTheme.textSecondary)
                } else {
                    ForEach(completed) { workout in
                        NavigationLink {
                            RunDetailView(workout: workout, log: logs.first(where: { $0.workoutId == workout.id }))
                        } label: {
                            WorkoutRowCard(
                                title: workout.title,
                                subtitle: "\(format(kilometers: workout.distanceKm)) km - \(paceText(distanceKm: workout.distanceKm, durationSeconds: workout.durationSeconds))",
                                status: "Completed",
                                systemImage: "figure.run",
                                tint: AppTheme.blueRunning,
                                trailingSystemImage: "chevron.right"
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var weeklyLogs: [RunningLog] {
        let start = currentWeekStart()
        let end = Calendar.current.date(byAdding: .day, value: 7, to: start) ?? start
        return logs.filter { $0.completedAt >= start && $0.completedAt < end }
    }

    private var weeklyDistance: Double { weeklyLogs.reduce(0) { $0 + $1.distanceKm } }
    private var weeklySeconds: Int { weeklyLogs.reduce(0) { $0 + $1.durationSeconds } }
    private var weeklyElevation: Int { weeklyLogs.reduce(0) { $0 + $1.elevationMeters } }
    private var weeklyVolumeValues: [Double] { logs.suffix(8).map(\.distanceKm) }
}

struct RunDetailView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss
    var workout: RunningWorkout
    var log: RunningLog?
    @State private var selectedTab = "Summary"

    var body: some View {
        ScreenBackground(
            title: nil,
            trailing: AnyView(Menu {
                Button(role: .destructive) {
                    deleteRun()
                } label: {
                    Label("Delete run", systemImage: "trash")
                }
            } label: {
                Image(systemName: "ellipsis").frame(width: 44, height: 44)
            })
        ) {
            VStack(alignment: .leading, spacing: 8) {
                Text(workout.scheduledDate.formatted(date: .abbreviated, time: .omitted))
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(AppTheme.textSecondary)
                Text(workout.title)
                    .font(.system(size: 18, weight: .semibold))
                Text("\(format(kilometers: workout.distanceKm)) km")
                    .font(.system(size: 40, weight: .semibold))
            }

            HStack(spacing: 8) {
                MetricCard(title: "Moving Time", value: durationText(seconds: workout.durationSeconds), subtitle: "Duration")
                MetricCard(title: "Avg Pace", value: paceText(distanceKm: workout.distanceKm, durationSeconds: workout.durationSeconds), subtitle: "Per km")
                MetricCard(title: "Elev Gain", value: "\(workout.elevationMeters) m", subtitle: "Gain")
            }

            SegmentedFilter(options: ["Summary", "Splits", "Heart Rate", "Map"], selection: $selectedTab)
            detailTab
        }
    }

    @ViewBuilder
    private var detailTab: some View {
        switch selectedTab {
        case "Heart Rate":
            EmptyRunDataCard(title: "Heart rate", detail: log?.averageHeartRate ?? 0 > 0 ? "\(log?.averageHeartRate ?? 0) bpm average" : "No heart-rate source connected yet.")
        case "Splits":
            EmptyRunDataCard(title: "Splits", detail: "Manual-first run logging does not store split data yet.")
        case "Map":
            EmptyRunDataCard(title: "Map", detail: "GPS route tracking is intentionally out of scope for this version.")
        default:
            LockinCard {
                VStack(alignment: .leading, spacing: 12) {
                    SectionLabel(text: "Fuel & Hydration")
                    HStack {
                        MetricPill(title: "Carbs", value: "\(log?.carbsGrams ?? 0) g")
                        MetricPill(title: "Fluid", value: "\(log?.fluidMl ?? 0) ml")
                        MetricPill(title: "Sodium", value: "\(log?.sodiumMg ?? 0) mg")
                    }
                    Divider()
                    Text(log?.notes.isEmpty == false ? log?.notes ?? "" : "No notes logged.")
                        .font(.system(size: 14))
                        .foregroundStyle(AppTheme.textSecondary)
                }
            }
        }
    }

    private func deleteRun() {
        if let log {
            modelContext.delete(log)
        }
        modelContext.delete(workout)
        try? modelContext.save()
        dismiss()
    }
}

private struct EmptyRunDataCard: View {
    var title: String
    var detail: String

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: title)
                Text(detail)
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.textSecondary)
            }
        }
    }
}

struct RunningBarChart: View {
    var values: [Double]

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            let normalized = normalizedValues
            ForEach(Array(normalized.enumerated()), id: \.offset) { _, value in
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(AppTheme.olive)
                    .frame(maxWidth: .infinity)
                    .frame(height: max(8, 80 * value))
            }
        }
        .frame(height: 92)
    }

    private var normalizedValues: [Double] {
        let input = values.isEmpty ? [20, 32, 28, 46, 38, 54, 42, 64] : values
        let maxValue = max(1, input.max() ?? 1)
        return input.map { min(1, max(0.05, $0 / maxValue)) }
    }
}

struct ManualRunLogView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @State private var title = "Long Run"
    @State private var date = Date()
    @State private var distanceText = "10"
    @State private var durationMinutesText = "60"
    @State private var elevationText = "120"
    @State private var heartRateText = ""
    @State private var carbsText = ""
    @State private var fluidText = ""
    @State private var sodiumText = ""
    @State private var notes = ""

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "Log Run") {
                LockinCard {
                    VStack(alignment: .leading, spacing: 14) {
                        SectionLabel(text: "Run")
                        TextField("Title", text: $title)
                            .textFieldStyle(.roundedBorder)
                        DatePicker("Date", selection: $date)
                        LogTextField(title: "Distance", text: $distanceText, suffix: "km")
                        LogTextField(title: "Duration", text: $durationMinutesText, suffix: "min")
                        LogTextField(title: "Elevation", text: $elevationText, suffix: "m")
                    }
                }
                LockinCard {
                    VStack(alignment: .leading, spacing: 14) {
                        SectionLabel(text: "Fuel & Hydration")
                        LogTextField(title: "Avg HR", text: $heartRateText, suffix: "bpm")
                        LogTextField(title: "Carbs", text: $carbsText, suffix: "g")
                        LogTextField(title: "Fluid", text: $fluidText, suffix: "ml")
                        LogTextField(title: "Sodium", text: $sodiumText, suffix: "mg")
                        TextField("Notes", text: $notes, axis: .vertical)
                            .textFieldStyle(.roundedBorder)
                    }
                }
                PrimaryActionButton(title: "Save run", systemImage: "checkmark") {
                    save()
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func save() {
        let distance = Double(distanceText) ?? 0
        let duration = (Int(durationMinutesText) ?? 0) * 60
        let workout = RunningWorkout(
            scheduledDate: date,
            title: title.isEmpty ? "Run" : title,
            kind: title.localizedCaseInsensitiveContains("long") ? .long : .easy,
            status: .completed,
            distanceKm: distance,
            durationSeconds: duration,
            elevationMeters: Int(elevationText) ?? 0,
            zone: "Zone 2",
            notes: notes
        )
        modelContext.insert(workout)
        modelContext.insert(RunningLog(
            workoutId: workout.id,
            completedAt: date,
            distanceKm: distance,
            durationSeconds: duration,
            elevationMeters: Int(elevationText) ?? 0,
            averageHeartRate: Int(heartRateText) ?? 0,
            carbsGrams: Int(carbsText) ?? 0,
            fluidMl: Int(fluidText) ?? 0,
            sodiumMg: Int(sodiumText) ?? 0,
            notes: notes
        ))
        try? modelContext.save()
        dismiss()
    }
}

struct ManualStrengthLogView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Query private var ranks: [RankState]
    @Query private var achievements: [AchievementState]
    var profile: UserProfile
    @State private var pullUpsText = ""
    @State private var pushUpsText = ""
    @State private var plankSecondsText = ""
    @State private var notes = ""

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "Log Strength") {
                LockinCard {
                    VStack(alignment: .leading, spacing: 14) {
                        SectionLabel(text: "Strength result")
                        LogTextField(title: "Pull-ups", text: $pullUpsText, suffix: "reps")
                        LogTextField(title: "Push-ups", text: $pushUpsText, suffix: "reps")
                        LogTextField(title: "Plank", text: $plankSecondsText, suffix: "sec")
                        TextField("Notes", text: $notes, axis: .vertical)
                            .textFieldStyle(.roundedBorder)
                    }
                }
                PrimaryActionButton(title: "Save log", systemImage: "checkmark") {
                    save()
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func save() {
        let log = PerformanceLog(
            sessionId: UUID(),
            pullUps: Int(pullUpsText) ?? profile.baselinePullUps,
            pushUps: Int(pushUpsText) ?? profile.baselinePushUps,
            plankSeconds: Int(plankSecondsText) ?? profile.baselinePlankSeconds,
            loggedPullUps: !pullUpsText.isEmpty,
            loggedPushUps: !pushUpsText.isEmpty,
            loggedPlankSeconds: !plankSecondsText.isEmpty,
            rpe: 7,
            painLevel: 0,
            fatigueLevel: 5,
            notes: notes
        )
        modelContext.insert(log)
        let rank = ranks.first ?? RankState()
        if ranks.isEmpty { modelContext.insert(rank) }
        applyScoreOutcome(TrainingEngine().score(log: SessionLogInput(completed: true, pullUps: log.pullUps, pushUps: log.pushUps, plankSeconds: log.plankSeconds, loggedPullUps: log.loggedPullUps, loggedPushUps: log.loggedPushUps, loggedPlankSeconds: log.loggedPlankSeconds, rpe: 7, painLevel: 0, fatigueLevel: 5), plannedSession: nil), to: rank)
        updateAchievements(after: log, rank: rank, states: achievements, in: modelContext)
        try? modelContext.save()
        dismiss()
    }
}

private struct LogTextField: View {
    var title: String
    @Binding var text: String
    var suffix: String

    var body: some View {
        HStack {
            Text(title)
                .font(.system(size: 14, weight: .medium))
            Spacer()
            TextField("0", text: $text)
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.trailing)
                .frame(width: 86)
                .textFieldStyle(.roundedBorder)
            Text(suffix)
                .font(.system(size: 12))
                .foregroundStyle(AppTheme.textSecondary)
        }
    }
}

private func weekStatuses(logs: [PerformanceLog]) -> [ConsistencyDayStatus] {
    let calendar = Calendar.current
    let start = currentWeekStart()
    return (0..<7).map { offset in
        guard let day = calendar.date(byAdding: .day, value: offset, to: start) else { return .rest }
        if calendar.isDateInToday(day) {
            return logs.contains { calendar.isDate($0.completedAt, inSameDayAs: day) } ? .completed : .today
        }
        if day > Date() {
            return .rest
        }
        return logs.contains { calendar.isDate($0.completedAt, inSameDayAs: day) } ? .completed : .rest
    }
}

private func daysUntil(_ date: Date) -> Int {
    Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: Date()), to: Calendar.current.startOfDay(for: date)).day ?? 0
}
