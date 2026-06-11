import SwiftData
import SwiftUI

struct CoachView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \SetPrescription.orderIndex) private var prescriptions: [SetPrescription]
    @Query(sort: \CoachPlan.generatedAt, order: .reverse) private var plans: [CoachPlan]
    @Query(sort: \CoachVerdict.createdAt, order: .reverse) private var verdicts: [CoachVerdict]
    @Query(sort: \RaceGoal.createdAt) private var raceGoals: [RaceGoal]
    @Query(sort: \RunLog.completedAt, order: .reverse) private var runLogs: [RunLog]
    @Query(sort: \GarminDailySnapshot.date, order: .reverse) private var snapshots: [GarminDailySnapshot]
    // Configuration, not state: fixed per build flavor (see LocalCoachClient).
    private let endpoint = LocalCoachClient.defaultEndpointString
    @AppStorage("coachModelID") private var selectedModelID = CoachModelCatalog.defaultModelID
    @AppStorage(CoachVerdictRefreshFlag.needsRefreshKey) private var needsVerdictRefresh = false
    @State private var generationStatus: String?
    @State private var verdictStatus: String?
    @State private var isGeneratingPlan = false
    @State private var isRefreshingVerdict = false
    @State private var isAdvancedExpanded = false

    var profile: UserProfile

    private var latestPlan: CoachPlan? {
        plans.first
    }

    private var latestVerdict: CoachVerdict? {
        verdicts.first
    }

    private var latestLog: PerformanceLog? {
        logs.first
    }

    private var latestLogID: UUID? {
        latestLog?.id
    }

    private var historyLogs: [PerformanceLog] {
        coachHistoryLogs(from: logs)
    }

    private var plannedContextSessions: [WorkoutSession] {
        coachPlannedSessions(from: sessions)
    }

    private var latestConfirmedRun: RunLog? {
        runLogs.first { !$0.needsConfirmation }
    }

    private var latestConfirmedRunID: UUID? {
        latestConfirmedRun?.id
    }

    private var latestVerdictIsStale: Bool {
        coachVerdictNeedsRefresh(
            latestLog: latestLog,
            latestConfirmedRun: latestConfirmedRun,
            latestSnapshot: snapshots.first,
            latestVerdict: latestVerdict
        )
    }

    var body: some View {
        NavigationStack {
            // The inline navigation bar already says "Coach" — no second title.
            ScreenBackground {
                CoachVerdictCard(
                    verdict: latestVerdict,
                    latestPlan: latestPlan,
                    profile: profile,
                    raceGoal: raceGoals.first,
                    historyCount: historyLogs.count,
                    isRefreshing: isRefreshingVerdict,
                    needsRefresh: needsVerdictRefresh || latestVerdictIsStale,
                    status: verdictStatus,
                    onRefresh: refreshCoachVerdict
                )

                VStack(alignment: .leading, spacing: 10) {
                    Button(action: generateAIWeek) {
                        Label(isGeneratingPlan ? "Planning" : "Plan my week", systemImage: "sparkles")
                    }
                    .buttonStyle(PrimaryActionButtonStyle())
                    .accessibilityIdentifier("plan-week-button")
                    .disabled(isGeneratingPlan)

                    if isGeneratingPlan {
                        HStack(spacing: 10) {
                            SwiftUI.ProgressView()
                                .tint(AppTheme.muted)
                            Text("Planning your week — the running coach goes first, then strength. This takes a minute or two.")
                                .font(.footnote)
                                .foregroundStyle(AppTheme.muted)
                        }
                        .padding(.top, 2)
                    } else if let generationStatus {
                        Text(generationStatus)
                            .font(.footnote)
                            .foregroundStyle(AppTheme.muted)
                            .padding(.top, 2)
                    }
                }

                AdvancedCoachControls(
                    endpoint: endpoint,
                    selectedModelID: $selectedModelID,
                    isExpanded: $isAdvancedExpanded,
                    profile: profile,
                    historyCount: historyLogs.count,
                    plannedCount: plannedContextSessions.count,
                    raceGoal: raceGoals.first
                )
            }
            .navigationTitle("Coach")
            .navigationBarTitleDisplayMode(.inline)
        }
        .onAppear {
            refreshCoachVerdictIfNeeded()
        }
        .onChange(of: needsVerdictRefresh) { _, _ in
            refreshCoachVerdictIfNeeded()
        }
        .onChange(of: latestLogID) { _, _ in
            refreshCoachVerdictIfNeeded()
        }
        .onChange(of: latestConfirmedRunID) { _, _ in
            refreshCoachVerdictIfNeeded()
        }
    }

    private func generateAIWeek() {
        // A replan while a push is in flight would delete sessions whose
        // garminWorkoutId has not landed yet, orphaning workouts on the watch.
        guard !GarminPushCoordinator.isPushing else { return }
        Task { await requestPlan() }
    }

    private func refreshCoachVerdict() {
        Task { await requestVerdict(sourceLogID: latestLog?.id, showSuccess: true) }
    }

    private func refreshCoachVerdictIfNeeded() {
        guard !isRefreshingVerdict, latestLog != nil || latestConfirmedRun != nil else { return }
        guard needsVerdictRefresh || latestVerdictIsStale else { return }
        refreshCoachVerdict()
    }

    private func requestPlan() async {
        isGeneratingPlan = true
        generationStatus = nil
        defer { isGeneratingPlan = false }

        do {
            let baseline = Baseline(
                pullUps: profile.baselinePullUps,
                pushUps: profile.baselinePushUps,
                plankSeconds: profile.baselinePlankSeconds
            )
            let preferences = TrainingPreferences(
                weeklySessions: profile.trainingDays.count,
                trainingDays: profile.trainingDays,
                equipment: profile.equipment,
                targetDate: profile.targetDate
            )
            let request = makeCoachRequest(
                profile: profile,
                modelID: selectedModelID,
                logs: logs,
                sessions: sessions,
                prescriptions: prescriptions,
                raceGoal: raceGoals.first,
                runLogs: runLogs,
                weekStart: rollingPlanStart()
            )
            if raceGoals.first != nil {
                let response = try await LocalCoachClient(endpointString: endpoint).generateCombinedWeek(
                    request: request,
                    baseline: baseline,
                    preferences: preferences
                )
                var strengthPlan = response.strengthWeek.weeklyPlan(weekStart: request.weekStart)
                strengthPlan.summary = response.safetyFlags.isEmpty
                    ? response.summary
                    : response.summary + " Watch: " + response.safetyFlags.joined(separator: " ")
                var stalePushedIds: [String] = []
                try saveAtomically {
                    try persist(plan: strengthPlan, in: modelContext, source: .ai, replacingFuturePlannedSessions: true)
                    stalePushedIds = try persist(runningWeek: response.runningWeek, weekStart: request.weekStart, in: modelContext, replacingFuturePlannedSessions: true)
                }
                let strengthCount = strengthPlan.sessions.count
                let runCount = response.runningWeek.sessions.count
                generationStatus = runCount == 0
                    ? "Saved \(countText(strengthCount, "strength session")). The running week is already underway; no new runs were planned."
                    : "Saved \(countText(strengthCount, "strength session")) and \(countText(runCount, "run")). Today was left untouched."
                await rescheduleRemindersReportingFailure()
                if let watchNote = await GarminPushCoordinator.pushPlannedRuns(
                    endpoint: endpoint,
                    stalePushedIds: stalePushedIds,
                    in: modelContext
                ) {
                    generationStatus = [generationStatus, watchNote].compactMap { $0 }.joined(separator: " ")
                }
            } else {
                let response = try await LocalCoachClient(endpointString: endpoint).generatePlan(
                    request: request,
                    baseline: baseline,
                    preferences: preferences
                )
                let plan = response.weeklyPlan(weekStart: request.weekStart)
                try saveAtomically {
                    try persist(plan: plan, in: modelContext, source: .ai, replacingFuturePlannedSessions: true)
                }
                generationStatus = "Saved \(countText(plan.sessions.count, "future session")). Today was left untouched."
                await rescheduleRemindersReportingFailure()
            }
        } catch {
            generationStatus = error.localizedDescription
        }
    }

    // rollback() discards all unsaved mainContext changes; safe here because the app
    // saves immediately after every mutation.
    private func saveAtomically(_ mutate: () throws -> Void) throws {
        do {
            try mutate()
            try modelContext.save()
        } catch {
            modelContext.rollback()
            throw error
        }
    }

    private func rescheduleRemindersIfEnabled() async throws {
        guard profile.remindersEnabled else { return }
        let reminderSessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>(sortBy: [SortDescriptor(\.scheduledDate)]))
        await WorkoutNotificationScheduler().scheduleWorkoutReminders(for: reminderSessions, at: profile.reminderTime)
    }

    /// Reminder refresh failures must not mask a successful plan save: append a mild
    /// note to the existing status instead of replacing it.
    private func rescheduleRemindersReportingFailure() async {
        do {
            try await rescheduleRemindersIfEnabled()
        } catch {
            generationStatus = [generationStatus, "(Reminder refresh failed.)"]
                .compactMap { $0 }
                .joined(separator: " ")
        }
    }

    private func countText(_ count: Int, _ noun: String) -> String {
        "\(count) \(noun)\(count == 1 ? "" : "s")"
    }

    private func requestVerdict(sourceLogID: UUID?, showSuccess: Bool) async {
        guard latestLog != nil || latestConfirmedRun != nil else {
            verdictStatus = "Log a session first, then I can refresh the coach read."
            return
        }

        isRefreshingVerdict = true
        verdictStatus = nil
        defer { isRefreshingVerdict = false }

        do {
            // The read sees the same world as the planner: race goal, runs,
            // strength logs, and the wellness the proxy joins in.
            let request = makeCoachRequest(
                profile: profile,
                modelID: selectedModelID,
                logs: logs,
                sessions: sessions,
                prescriptions: prescriptions,
                raceGoal: raceGoals.first,
                runLogs: runLogs,
                weekStart: rollingPlanStart()
            )
            let response = try await LocalCoachClient(endpointString: endpoint).generateVerdict(request: request)
            modelContext.insert(CoachVerdict(response: response, sourceLogId: sourceLogID))
            try modelContext.save()
            needsVerdictRefresh = false
            verdictStatus = showSuccess ? "Coach read updated from your latest session." : nil
        } catch {
            needsVerdictRefresh = true
            verdictStatus = coachReadErrorMessage(error)
        }
    }

    private func coachReadErrorMessage(_ error: Error) -> String {
        let message = error.localizedDescription
        if message.contains("HTTP 404") || message.contains("Not found") {
            return "The coach read is not available on the server yet. Week generation can still work; the server needs the latest coach-read update."
        }
        if message.contains("OPENAI_API_KEY") {
            return "The coach server is online, but the AI key is missing on the server."
        }
        return "I could not refresh the coach read yet. Try again in a bit."
    }
}

private struct CoachVerdictCard: View {
    var verdict: CoachVerdict?
    var latestPlan: CoachPlan?
    var profile: UserProfile
    var raceGoal: RaceGoal?
    var historyCount: Int
    var isRefreshing: Bool
    var needsRefresh: Bool
    var status: String?
    var onRefresh: () -> Void

    /// "14 WEEKS TO EIGER ULTRA 51K" — the lens every read is written through.
    private var raceLensText: String? {
        guard let raceGoal else { return nil }
        let calendar = Calendar.current
        let days = max(0, calendar.dateComponents([.day], from: calendar.startOfDay(for: Date()), to: raceGoal.raceDate).day ?? 0)
        let weeks = (days + 6) / 7
        let trimmedName = raceGoal.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = (trimmedName.isEmpty ? "Race" : trimmedName).uppercased()
        if weeks == 0 { return "RACE WEEK — \(name)" }
        return "\(weeks) \(weeks == 1 ? "WEEK" : "WEEKS") TO \(name)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Coach read")
                        .font(.lockinSection)
                        .foregroundStyle(AppTheme.text)
                    Spacer()
                    StatusPill(text: pillText, color: pillColor, systemImage: pillIcon)
                }
                if let raceLensText {
                    MicroLabel(text: raceLensText, color: AppTheme.accent)
                }
            }

            if let verdict {
                verdictContent(verdict)
            } else if let latestPlan {
                planSummaryContent(latestPlan)
            } else if historyCount == 0 {
                starterContent
            } else {
                waitingContent
            }

            if isRefreshing {
                SwiftUI.ProgressView("Reading latest session")
                    .font(.footnote)
                    .tint(AppTheme.muted)
                    .foregroundStyle(AppTheme.muted)
            } else if needsRefresh {
                Button(action: onRefresh) {
                    Label("Read new session", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryActionButtonStyle())
            }

            if let status {
                Text(status)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.muted)
            }
        }
        .card()
    }

    private func verdictContent(_ verdict: CoachVerdict) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text(verdict.headline)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(AppTheme.text)
                Text(verdict.summary)
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.muted)
            }
            CoachReadSection(title: "This week", bodyText: verdict.latestChange)
            CoachReadSection(title: "One change", bodyText: verdict.recommendation)
            if verdict.shouldUpdatePlan {
                CoachReadSection(title: "Plan signal", bodyText: "Current read recommends adapting the plan. Generate an AI week when you want the next sessions updated.")
            }
            if !verdict.safetyFlags.isEmpty {
                CoachReadSection(title: "Watch", bodyText: verdict.safetyFlags.joined(separator: " "), accent: true)
            }
        }
    }

    private var starterContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Ready for the first week")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(AppTheme.text)
                Text("I only know your starting numbers and goal for now: \(profile.goalPullUps) pull-ups, \(profile.goalPushUps) push-ups, and a \(format(seconds: profile.goalPlankSeconds)) plank. Generate your first AI week, then I can react to real sessions.")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.muted)
            }
            CoachReadSection(
                title: "Starting point",
                bodyText: "I will keep the first week conservative and use your baseline, selected training days, equipment, target date, and any pain notes."
            )
        }
    }

    private func planSummaryContent(_ plan: CoachPlan) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(plan.summary)
                .font(.subheadline)
                .foregroundStyle(AppTheme.text)
            CoachReadSection(title: "Next step", bodyText: "Log the sessions from Log. After you finish one, I can refresh the coach read from what actually happened.")
        }
    }

    private var waitingContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Coach read needed")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(AppTheme.text)
            Text("You have logged training data, but I have not refreshed the coach read yet.")
                .font(.subheadline)
                .foregroundStyle(AppTheme.muted)
        }
    }

    private var pillText: String {
        if isRefreshing { return "Reading" }
        if needsRefresh { return "New data" }
        if verdict?.shouldUpdatePlan == true { return "Plan update" }
        return historyCount == 0 ? "Starter" : "Current"
    }

    private var pillColor: Color {
        if needsRefresh || verdict?.shouldUpdatePlan == true { return AppTheme.warning }
        return AppTheme.accent
    }

    private var pillIcon: String {
        if isRefreshing { return "hourglass" }
        if needsRefresh { return "arrow.triangle.2.circlepath" }
        if verdict?.shouldUpdatePlan == true { return "exclamationmark.triangle.fill" }
        return "checkmark.circle.fill"
    }
}

func coachVerdictNeedsRefresh(latestLog: PerformanceLog?, latestVerdict: CoachVerdict?) -> Bool {
    guard let latestLog else { return false }
    guard let latestVerdict else { return true }
    if let sourceLogId = latestVerdict.sourceLogId {
        return sourceLogId != latestLog.id
    }
    return latestLog.completedAt > latestVerdict.createdAt
}

/// Hybrid staleness: a newer strength log, a newer confirmed run, or a fresh
/// morning snapshot the current read predates all mark the verdict stale.
/// Without any training history the starter read stays — wellness alone is
/// nothing to coach on.
func coachVerdictNeedsRefresh(
    latestLog: PerformanceLog?,
    latestConfirmedRun: RunLog?,
    latestSnapshot: GarminDailySnapshot?,
    latestVerdict: CoachVerdict?
) -> Bool {
    guard latestLog != nil || latestConfirmedRun != nil else { return false }
    guard let latestVerdict else { return true }
    if latestLog != nil, coachVerdictNeedsRefresh(latestLog: latestLog, latestVerdict: latestVerdict) {
        return true
    }
    if let latestConfirmedRun, latestConfirmedRun.completedAt > latestVerdict.createdAt {
        return true
    }
    if let latestSnapshot {
        let calendar = Calendar.current
        if calendar.isDateInToday(latestSnapshot.date),
           latestVerdict.createdAt < calendar.startOfDay(for: Date()) {
            return true
        }
    }
    return false
}

private struct CoachReadSection: View {
    var title: String
    var bodyText: String
    var accent: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            MicroLabel(text: title.uppercased(), color: accent ? AppTheme.accent : AppTheme.faint)
            Text(bodyText)
                .font(.subheadline)
                .foregroundStyle(AppTheme.text.opacity(0.88))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct CoachInputsCard: View {
    var profile: UserProfile
    var historyCount: Int
    var plannedCount: Int
    var raceGoal: RaceGoal?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader("What I'll use")
            VStack(spacing: 10) {
                InfoLine(title: "Starting point", value: "\(profile.baselinePullUps) pull-ups, \(profile.baselinePushUps) push-ups, \(format(seconds: profile.baselinePlankSeconds)) plank")
                InfoLine(title: "Goal", value: "\(profile.goalPullUps) pull-ups, \(profile.goalPushUps) push-ups, \(format(seconds: profile.goalPlankSeconds)) plank")
                InfoLine(title: "Week shape", value: "\(profile.trainingDayLabels.joined(separator: ", ")) until \(profile.targetDate.formatted(date: .abbreviated, time: .omitted))")
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("coach-week-shape")
                if let raceGoal {
                    InfoLine(title: "Race goal", value: raceGoalSummary(raceGoal))
                    InfoLine(title: "Weeks to race", value: weeksToRaceText(raceGoal))
                    InfoLine(title: "Running days", value: runningDaysText)
                }
                InfoLine(title: "Recent training", value: historyCount == 0 ? "No logged sessions yet" : "\(historyCount) logged sessions with readiness and notes")
                InfoLine(title: "Log context", value: plannedCount == 0 ? "No sessions in Log yet" : "\(plannedCount) recent or upcoming sessions from Log")
            }
            if !profile.painNotes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                CoachReadSection(title: "Notes", bodyText: profile.painNotes)
            }
        }
        .ruled(verticalPadding: 16)
    }

    private func raceGoalSummary(_ goal: RaceGoal) -> String {
        let trimmedName = goal.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = trimmedName.isEmpty ? "Race" : trimmedName
        let distance = goal.distanceKm.formatted(.number.precision(.fractionLength(0...1)))
        let raceDate = goal.raceDate.formatted(date: .abbreviated, time: .omitted)
        return "\(name) \(distance) km / \(goal.elevationGainM) m+ on \(raceDate)"
    }

    private func weeksToRaceText(_ goal: RaceGoal) -> String {
        let calendar = Calendar.current
        let days = max(0, calendar.dateComponents([.day], from: calendar.startOfDay(for: Date()), to: goal.raceDate).day ?? 0)
        let weeks = (days + 6) / 7
        if weeks == 0 { return "Race week" }
        return weeks == 1 ? "1 week out" : "\(weeks) weeks out"
    }

    private var runningDaysText: String {
        let days = TrainingWeekday.allCases.filter { profile.runningDays.contains($0) }
        return days.isEmpty ? "No fixed days" : days.map(\.shortTitle).joined(separator: ", ")
    }
}

private struct AdvancedCoachControls: View {
    var endpoint: String
    @Binding var selectedModelID: String
    @Binding var isExpanded: Bool
    var profile: UserProfile
    var historyCount: Int
    var plannedCount: Int
    var raceGoal: RaceGoal?

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded.animation(.smooth(duration: 0.3))) {
            VStack(alignment: .leading, spacing: 18) {
                CoachInputsCard(
                    profile: profile,
                    historyCount: historyCount,
                    plannedCount: plannedCount,
                    raceGoal: raceGoal
                )
                CoachModelControls(endpoint: endpoint, selectedModelID: $selectedModelID)
            }
            .padding(.top, 12)
        } label: {
            Text("Advanced")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AppTheme.muted)
        }
        .tint(AppTheme.faint)
    }
}

private struct CoachModelControls: View {
    var endpoint: String
    @Binding var selectedModelID: String
    @State private var availableModelIDs = CoachModelCatalog.defaultModelIDs
    @State private var status: String?
    @State private var isRefreshing = false

    private var modelOptions: [String] {
        CoachModelCatalog.mergedOptions(selectedModelID: selectedModelID, fetchedModelIDs: availableModelIDs)
    }

    private var normalizedSelection: Binding<String> {
        Binding(
            get: { CoachModelCatalog.normalized(selectedModelID) },
            set: { selectedModelID = $0 }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Model")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppTheme.text)
                Spacer()
                Picker("Model", selection: normalizedSelection) {
                    ForEach(modelOptions, id: \.self) { modelID in
                        Text(modelID).tag(modelID)
                    }
                }
                .pickerStyle(.menu)
                .tint(AppTheme.accent)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if isRefreshing {
                SwiftUI.ProgressView("Loading OpenAI models")
                    .font(.footnote)
                    .tint(AppTheme.muted)
                    .foregroundStyle(AppTheme.muted)
            } else if let status {
                Text(status)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.muted)
            }
        }
        .task(id: endpoint) {
            await loadModels()
        }
    }

    private func loadModels() async {
        isRefreshing = true
        status = nil
        defer { isRefreshing = false }

        do {
            let response = try await LocalCoachClient(endpointString: endpoint).fetchAvailableModels()
            availableModelIDs = CoachModelCatalog.mergedOptions(
                selectedModelID: response.defaultModel,
                fetchedModelIDs: response.models
            )
            if selectedModelID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                selectedModelID = response.defaultModel
            }
            status = "Loaded \(availableModelIDs.count) models."
        } catch {
            status = error.localizedDescription
        }
    }
}

