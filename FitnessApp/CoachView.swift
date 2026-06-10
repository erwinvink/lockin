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
    @AppStorage("coachProxyEndpoint") private var endpoint = LocalCoachClient.defaultEndpointString
    @AppStorage("coachModelID") private var selectedModelID = CoachModelCatalog.defaultModelID
    @AppStorage(CoachVerdictRefreshFlag.needsRefreshKey) private var needsVerdictRefresh = false
    @State private var generationStatus: String?
    @State private var verdictStatus: String?
    @State private var isGeneratingPlan = false
    @State private var isRefreshingVerdict = false
    @State private var isAdvancedExpanded = false
    @State private var isPushingRunsToWatch = false
    @State private var garminPushStatus: String?
    /// JSON-encoded [String] of Garmin workout ids whose delete failed; the
    /// next push attempt retries them (the sidecar tolerates 404s, so retried
    /// deletes are idempotent).
    @AppStorage("garminPendingDeleteIds") private var garminPendingDeleteIdsJSON = ""

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

    private var latestVerdictIsStale: Bool {
        coachVerdictNeedsRefresh(latestLog: latestLog, latestVerdict: latestVerdict)
    }

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "AI Coach") {
                CoachVerdictCard(
                    verdict: latestVerdict,
                    latestPlan: latestPlan,
                    profile: profile,
                    historyCount: historyLogs.count,
                    isRefreshing: isRefreshingVerdict,
                    needsRefresh: needsVerdictRefresh || latestVerdictIsStale,
                    status: verdictStatus,
                    onRefresh: refreshCoachVerdict
                )

                Button(action: generateAIWeek) {
                    Label(isGeneratingPlan ? "Planning" : "Plan my week", systemImage: "sparkles")
                }
                .buttonStyle(PrimaryActionButtonStyle())
                .accessibilityIdentifier("plan-week-button")
                .disabled(isGeneratingPlan || isPushingRunsToWatch)
                .opacity(isGeneratingPlan || isPushingRunsToWatch ? 0.55 : 1)

                if let generationStatus {
                    Text(generationStatus)
                        .font(.caption)
                        .foregroundStyle(AppTheme.muted)
                        .card()
                }

                GarminSyncRow(
                    endpoint: endpoint,
                    isPushing: isPushingRunsToWatch || isGeneratingPlan,
                    pushStatus: garminPushStatus,
                    onPush: pushRunsToWatchManually
                )

                CoachInputsCard(
                    profile: profile,
                    historyCount: historyLogs.count,
                    plannedCount: plannedContextSessions.count,
                    raceGoal: raceGoals.first
                )

                AdvancedCoachControls(
                    endpoint: endpoint,
                    selectedModelID: $selectedModelID,
                    isExpanded: $isAdvancedExpanded
                )
            }
            .navigationTitle("Coach")
            .navigationBarTitleDisplayMode(.inline)
        }
        .onAppear {
            enforceHostedEndpoint()
            refreshCoachVerdictIfNeeded()
        }
        .onChange(of: needsVerdictRefresh) { _, _ in
            refreshCoachVerdictIfNeeded()
        }
        .onChange(of: latestLogID) { _, _ in
            refreshCoachVerdictIfNeeded()
        }
    }

    private func generateAIWeek() {
        // A replan while a push is in flight would delete sessions whose
        // garminWorkoutId has not landed yet, orphaning workouts on the watch.
        guard !isPushingRunsToWatch else { return }
        enforceHostedEndpoint()
        Task { await requestPlan() }
    }

    private func refreshCoachVerdict() {
        enforceHostedEndpoint()
        Task { await requestVerdict(sourceLogID: latestLog?.id, showSuccess: true) }
    }

    private func refreshCoachVerdictIfNeeded() {
        guard !isRefreshingVerdict, latestLog != nil else { return }
        guard needsVerdictRefresh || latestVerdictIsStale else { return }
        refreshCoachVerdict()
    }

    private func enforceHostedEndpoint() {
        if (try? LocalCoachClient(endpointString: endpoint)) == nil {
            endpoint = LocalCoachClient.defaultEndpointString
        }
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
                if let watchNote = await pushPlannedRunsToWatch(stalePushedIds: stalePushedIds) {
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

    private static let watchRetryNote = "Runs are planned but not all on your watch yet — retry from the Garmin row."

    /// Deletes stale Garmin workouts first (including ids stashed from earlier
    /// failed deletes), then pushes every future planned run that is not on
    /// the watch yet, and records the returned workout ids. All failures are
    /// non-fatal — the plan is already saved and the Garmin row offers a
    /// retry. Returns a short status note, or nil when there was nothing to do.
    private func pushPlannedRunsToWatch(stalePushedIds: [String]) async -> String? {
        guard let client = try? LocalCoachClient(endpointString: endpoint) else { return Self.watchRetryNote }

        isPushingRunsToWatch = true
        defer { isPushingRunsToWatch = false }

        var notes: [String] = []
        // Stash before deleting so the ids survive a failed call or an app
        // exit; the drain retries the whole stash and keeps only what failed.
        stashPendingDeletes(stalePushedIds)
        let staleCleared = await drainPendingDeletes(client: client)
        if !staleCleared {
            notes.append("Some replaced workouts may still sit on your watch.")
        }

        do {
            let workouts = garminPushWorkouts(from: try futurePlannedRunsAwaitingPush())
            guard !workouts.isEmpty else {
                return notes.isEmpty ? nil : notes.joined(separator: " ")
            }

            let response = try await client.pushWorkoutsToGarmin(workouts)
            // A workout that uploaded but failed to schedule sits invisibly in
            // the Garmin library; stash it for the best-effort delete below.
            let unscheduledIds = response.results
                .filter { !$0.scheduled }
                .compactMap(\.garminWorkoutId)
                .filter { !$0.isEmpty }
            stashPendingDeletes(unscheduledIds)

            // Re-fetch after the await: the pre-push session references may be
            // stale by the time the response lands (same rule as AppShellView).
            let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>())
            let scheduledCount = applyGarminPushResults(response.results, to: sessions)
            try modelContext.save()

            if !unscheduledIds.isEmpty {
                _ = await drainPendingDeletes(client: client)
            }

            if scheduledCount == workouts.count, response.error == nil {
                notes.append("\(countText(scheduledCount, "run")) on your watch.")
            } else {
                notes.append(Self.watchRetryNote)
            }
        } catch {
            notes.append(Self.watchRetryNote)
        }
        return notes.joined(separator: " ")
    }

    // MARK: Pending Garmin deletes

    private func loadPendingDeleteIds() -> [String] {
        (try? JSONDecoder().decode([String].self, from: Data(garminPendingDeleteIdsJSON.utf8))) ?? []
    }

    private func savePendingDeleteIds(_ ids: [String]) {
        garminPendingDeleteIdsJSON = (try? JSONEncoder().encode(ids))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
    }

    /// Merges the ids into the retention stash, preserving order and dropping
    /// duplicates.
    private func stashPendingDeletes(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        var merged = loadPendingDeleteIds()
        var seen = Set(merged)
        for id in ids where seen.insert(id).inserted {
            merged.append(id)
        }
        savePendingDeleteIds(merged)
    }

    /// Tries to delete every stashed workout id and keeps only the failures
    /// for the next push attempt. Returns true when the stash is empty
    /// afterwards.
    private func drainPendingDeletes(client: LocalCoachClient) async -> Bool {
        let ids = loadPendingDeleteIds()
        guard !ids.isEmpty else { return true }

        var remaining = ids
        if let response = try? await client.deleteGarminWorkouts(ids) {
            let deletedIds = Set(response.results.filter(\.deleted).map(\.workoutId))
            remaining = ids.filter { !deletedIds.contains($0) }
        }
        savePendingDeleteIds(remaining)
        return remaining.isEmpty
    }

    /// Future planned runs that never made it onto the watch. Today's run is
    /// excluded: it is locked during replans, so an existing watch workout
    /// stays valid, and pushing a new one mid-day would land too late anyway.
    private func futurePlannedRunsAwaitingPush() throws -> [WorkoutSession] {
        let endOfToday = Calendar.current.dateInterval(of: .day, for: Date())?.end ?? Date()
        let sessions = try modelContext.fetch(FetchDescriptor<WorkoutSession>(sortBy: [SortDescriptor(\.scheduledDate)]))
        return sessions.filter {
            $0.discipline == .running &&
            $0.status == .planned &&
            $0.garminWorkoutId.isEmpty &&
            $0.scheduledDate >= endOfToday
        }
    }

    private func pushRunsToWatchManually() {
        guard !isPushingRunsToWatch, !isGeneratingPlan else { return }
        enforceHostedEndpoint()
        garminPushStatus = nil
        Task {
            let note = await pushPlannedRunsToWatch(stalePushedIds: [])
            garminPushStatus = note ?? "All planned runs are already on your watch."
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
        guard latestLog != nil else {
            verdictStatus = "Log a session first, then I can refresh the coach read."
            return
        }

        isRefreshingVerdict = true
        verdictStatus = nil
        defer { isRefreshingVerdict = false }

        do {
            let request = makeCoachRequest(
                profile: profile,
                modelID: selectedModelID,
                logs: logs,
                sessions: sessions,
                prescriptions: prescriptions,
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
    var historyCount: Int
    var isRefreshing: Bool
    var needsRefresh: Bool
    var status: String?
    var onRefresh: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Label("Coach read", systemImage: "brain.head.profile")
                    .font(.headline)
                Spacer()
                StatusPill(text: pillText, color: pillColor, systemImage: pillIcon)
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
                    .font(.caption)
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
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            }
        }
        .card()
    }

    private func verdictContent(_ verdict: CoachVerdict) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verdict.headline)
                .font(.system(.title3, design: .rounded, weight: .bold))
            Text(verdict.summary)
                .font(.subheadline)
                .foregroundStyle(AppTheme.text)
            CoachReadSection(title: "Latest change", bodyText: verdict.latestChange)
            CoachReadSection(title: "Recommendation", bodyText: verdict.recommendation)
            if verdict.shouldUpdatePlan {
                CoachReadSection(title: "Plan signal", bodyText: "Current read recommends adapting the plan. Generate an AI week when you want the next sessions updated.")
            }
            if !verdict.safetyFlags.isEmpty {
                CoachReadSection(title: "Watch", bodyText: verdict.safetyFlags.joined(separator: " "))
            }
        }
    }

    private var starterContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Ready for the first week")
                .font(.system(.title3, design: .rounded, weight: .bold))
            Text("I only know your starting numbers and goal for now: \(profile.goalPullUps) pull-ups, \(profile.goalPushUps) push-ups, and a \(format(seconds: profile.goalPlankSeconds)) plank. Generate your first AI week, then I can react to real sessions.")
                .font(.subheadline)
                .foregroundStyle(AppTheme.text)
            CoachReadSection(
                title: "Starting point",
                bodyText: "I will keep the first week conservative and use your baseline, selected training days, equipment, target date, and any pain notes."
            )
        }
    }

    private func planSummaryContent(_ plan: CoachPlan) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(plan.summary)
                .font(.subheadline)
                .foregroundStyle(AppTheme.text)
            CoachReadSection(title: "Next step", bodyText: "Log the sessions from Log. After you finish one, I can refresh the coach read from what actually happened.")
        }
    }

    private var waitingContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Coach read needed")
                .font(.system(.title3, design: .rounded, weight: .bold))
            Text("You have logged training data, but I have not refreshed the coach read yet.")
                .font(.subheadline)
                .foregroundStyle(AppTheme.text)
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

private struct CoachReadSection: View {
    var title: String
    var bodyText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased())
                .font(.caption.weight(.bold))
                .foregroundStyle(AppTheme.muted)
            Text(bodyText)
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
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
            Label("What I'll use", systemImage: "list.clipboard")
                .font(.headline)
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
            if !profile.painNotes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                CoachReadSection(title: "Notes", bodyText: profile.painNotes)
            }
        }
        .card()
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

private struct GarminSyncRow: View {
    var endpoint: String
    var isPushing: Bool
    var pushStatus: String?
    var onPush: () -> Void

    @AppStorage("garminLastSyncAt") private var garminLastSyncAt: Double = 0
    @State private var status: GarminStatusResponse?
    @State private var statusFailed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Label("Garmin", systemImage: "applewatch")
                    .font(.headline)
                Spacer()
                StatusPill(text: pillText, color: pillColor, systemImage: pillIcon)
            }

            InfoLine(title: "Last sync attempt", value: lastSyncText)

            if let lastError = status?.lastError, !lastError.isEmpty {
                Text(lastError)
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            }

            Button(action: onPush) {
                Label(isPushing ? "Pushing runs" : "Push runs to watch", systemImage: "arrow.up.circle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(SecondaryActionButtonStyle())
            .accessibilityIdentifier("garmin-push-retry")
            .disabled(isPushing)
            .opacity(isPushing ? 0.55 : 1)

            if let pushStatus {
                Text(pushStatus)
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            }
        }
        .card()
        .task { await loadStatus() }
    }

    private var lastSyncText: String {
        relativeSyncText(epochSeconds: garminLastSyncAt)
    }

    private var pillText: String {
        guard let status else { return statusFailed ? "Unreachable" : "Checking" }
        if status.ok, status.loggedIn { return "Connected" }
        return status.loggedIn ? "Degraded" : "Not signed in"
    }

    private var pillColor: Color {
        guard let status else { return statusFailed ? AppTheme.warning : AppTheme.muted }
        return status.ok && status.loggedIn ? AppTheme.accent : AppTheme.warning
    }

    private var pillIcon: String {
        guard let status else { return statusFailed ? "exclamationmark.triangle.fill" : "hourglass" }
        return status.ok && status.loggedIn ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
    }

    private func loadStatus() async {
        do {
            status = try await LocalCoachClient(endpointString: endpoint).fetchGarminStatus()
            statusFailed = false
        } catch {
            status = nil
            statusFailed = true
        }
    }
}

private struct AdvancedCoachControls: View {
    var endpoint: String
    @Binding var selectedModelID: String
    @Binding var isExpanded: Bool

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 14) {
                Divider()
                CoachModelControls(endpoint: endpoint, selectedModelID: $selectedModelID)
                Divider()
                ProxyStatusControls(endpoint: endpoint)
            }
            .padding(.top, 8)
        } label: {
            Label("Advanced", systemImage: "slider.horizontal.3")
                .font(.headline)
                .foregroundStyle(AppTheme.text)
        }
        .card()
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
        VStack(alignment: .leading, spacing: 10) {
            Label("Model", systemImage: "cpu")
                .font(.subheadline.weight(.semibold))

            Picker("Model", selection: normalizedSelection) {
                ForEach(modelOptions, id: \.self) { modelID in
                    Text(modelID).tag(modelID)
                }
            }
            .pickerStyle(.menu)

            if isRefreshing {
                SwiftUI.ProgressView("Loading OpenAI models")
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            } else if let status {
                Text(status)
                    .font(.caption)
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

private struct ProxyStatusControls: View {
    var endpoint: String
    @State private var status = "Not checked"
    @State private var detail: String?
    @State private var isChecking = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Proxy status", systemImage: "network")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if isChecking {
                    SwiftUI.ProgressView()
                }
            }
            InfoLine(title: "Status", value: status, valueColor: statusColor)
            if let detail {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            }
            Button(action: checkProxy) {
                Label("Check proxy", systemImage: "arrow.clockwise")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(SecondaryActionButtonStyle())
            .disabled(isChecking)
        }
        .task(id: endpoint) {
            await loadHealth()
        }
    }

    private var statusColor: Color {
        status == "Connected" ? AppTheme.accent : AppTheme.warning
    }

    private func checkProxy() {
        Task { await loadHealth() }
    }

    private func loadHealth() async {
        isChecking = true
        detail = nil
        defer { isChecking = false }

        do {
            let response = try await LocalCoachClient(endpointString: endpoint).fetchProxyHealth()
            if response.ok, response.hasApiKey {
                status = "Connected"
                detail = "Default model: \(response.defaultModel)"
            } else if response.ok {
                status = "Missing API key"
                detail = "The proxy is online, but the server is missing OPENAI_API_KEY."
            } else {
                status = "Unavailable"
                detail = "The proxy answered, but did not report a healthy state."
            }
        } catch {
            status = "Unavailable"
            detail = error.localizedDescription
        }
    }
}
