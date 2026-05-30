import SwiftData
import SwiftUI

private enum CoachTab: String, CaseIterable, Identifiable {
    case strength
    case ultra

    var id: String { rawValue }

    var title: String {
        switch self {
        case .strength: "Strength"
        case .ultra: "Ultra"
        }
    }
}

struct CoachView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query(sort: \RunningLog.completedAt, order: .reverse) private var runLogs: [RunningLog]
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \RunningTrainingProfile.createdAt) private var runningProfiles: [RunningTrainingProfile]
    @Query(sort: \CoachPlan.generatedAt, order: .reverse) private var plans: [CoachPlan]
    @Query(sort: \CoachVerdict.createdAt, order: .reverse) private var verdicts: [CoachVerdict]
    @AppStorage("coachProxyEndpoint") private var endpoint = LocalCoachClient.defaultEndpointString
    @AppStorage("coachModelID") private var selectedModelID = CoachModelCatalog.defaultModelID
    @AppStorage(CoachVerdictRefreshFlag.needsRefreshKey) private var needsVerdictRefresh = false
    @State private var generationStatus: String?
    @State private var ultraGenerationStatus: String?
    @State private var verdictStatus: String?
    @State private var isGeneratingPlan = false
    @State private var isRefreshingVerdict = false
    @State private var isAdvancedExpanded = false
    @State private var selectedCoach: CoachTab = .strength

    var profile: UserProfile

    private var latestPlan: CoachPlan? {
        plans.first { $0.domain == .strength }
    }

    private var latestUltraPlan: CoachPlan? {
        plans.first { $0.domain == .ultraRunning }
    }

    private var latestVerdict: CoachVerdict? {
        verdicts.first { $0.domain == .strength }
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
        coachPlannedSessions(from: sessions, domain: .strength)
    }

    private var plannedRunSessions: [WorkoutSession] {
        coachPlannedSessions(from: sessions, domain: .ultraRunning)
    }

    private var runningProfile: RunningTrainingProfile {
        displayRunningProfile(for: profile, from: runningProfiles)
    }

    private var latestVerdictIsStale: Bool {
        coachVerdictNeedsRefresh(latestLog: latestLog, latestVerdict: latestVerdict)
    }

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "Coach") {
                Picker("Coach", selection: $selectedCoach) {
                    ForEach(CoachTab.allCases) { tab in
                        Text(tab.title).tag(tab)
                    }
                }
                .pickerStyle(.segmented)

                SharedAthleteContextCard(
                    strengthCount: plannedContextSessions.count,
                    runContext: runningContextSummary(from: runLogs, sessions: plannedRunSessions),
                    runningProfile: runningProfile
                )

                switch selectedCoach {
                case .strength:
                    strengthCoachContent
                case .ultra:
                    ultraCoachContent
                }
            }
            .navigationTitle("Coach")
            .navigationBarTitleDisplayMode(.inline)
        }
        .onAppear {
            _ = try? ensureRunningProfile(for: profile, from: runningProfiles, in: modelContext)
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

    private var strengthCoachContent: some View {
        VStack(alignment: .leading, spacing: 14) {
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
                Label(isGeneratingPlan ? "Generating" : "Generate strength week", systemImage: "sparkles")
            }
            .buttonStyle(PrimaryActionButtonStyle())
            .disabled(isGeneratingPlan)
            .opacity(isGeneratingPlan ? 0.55 : 1)

            if let generationStatus {
                Text(generationStatus)
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
                    .card()
            }

            CoachInputsCard(
                profile: profile,
                historyCount: historyLogs.count,
                plannedCount: plannedContextSessions.count,
                runContext: runningContextSummary(from: runLogs, sessions: plannedRunSessions)
            )

            AdvancedCoachControls(
                endpoint: endpoint,
                selectedModelID: $selectedModelID,
                isExpanded: $isAdvancedExpanded
            )
        }
    }

    private var ultraCoachContent: some View {
        UltraRunnerCoachCard(
            runningProfile: runningProfile,
            latestPlan: latestUltraPlan,
            runLogCount: runLogs.count,
            plannedRunCount: plannedRunSessions.count,
            strengthLoadCount: plannedContextSessions.count,
            status: ultraGenerationStatus,
            onGenerate: generateUltraWeek
        )
    }

    private func generateAIWeek() {
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
                weeklySessions: profile.weeklySessions,
                equipment: profile.equipment,
                targetDate: profile.targetDate
            )
            let request = makeCoachRequest(
                profile: profile,
                modelID: selectedModelID,
                logs: logs,
                sessions: sessions,
                runningLogs: runLogs,
                runningSessions: plannedRunSessions,
                weekStart: rollingPlanStart()
            )
            let response = try await LocalCoachClient(endpointString: endpoint).generatePlan(
                request: request,
                baseline: baseline,
                preferences: preferences
            )
            let plan = response.weeklyPlan(weekStart: request.weekStart)
            try persist(plan: plan, in: modelContext, source: .ai, replacingFuturePlannedSessions: true)
            try modelContext.save()
            generationStatus = "Saved \(plan.sessions.count) sessions for the next 7 days. Open Log to view them."
        } catch {
            generationStatus = error.localizedDescription
        }
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
                runningLogs: runLogs,
                runningSessions: plannedRunSessions,
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

    private func generateUltraWeek() {
        do {
            let storedProfile = try ensureRunningProfile(for: profile, from: runningProfiles, in: modelContext)
            let weekStart = rollingPlanStart()
            let weekIndex = plans.filter { $0.domain == .ultraRunning }.count + 1
            let plan = UltraRunningEngine().generateWeek(
                start: weekStart,
                weekIndex: weekIndex,
                profile: storedProfile,
                recentRunLogs: runLogs,
                strengthSessions: sessions
            )
            try persist(ultraPlan: plan, in: modelContext, replacingFuturePlannedRuns: true)
            try modelContext.save()
            ultraGenerationStatus = "Saved \(plan.sessions.count) ultra sessions. \(plan.readiness): \(plan.summary)"
        } catch {
            ultraGenerationStatus = error.localizedDescription
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
                bodyText: "I will keep the first week conservative and use your baseline, available sessions, equipment, target date, and any pain notes."
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
    var runContext: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("What I'll use", systemImage: "list.clipboard")
                .font(.headline)
            InfoLine(title: "Starting point", value: "\(profile.baselinePullUps) pull-ups, \(profile.baselinePushUps) push-ups, \(format(seconds: profile.baselinePlankSeconds)) plank")
            InfoLine(title: "Goal", value: "\(profile.goalPullUps) pull-ups, \(profile.goalPushUps) push-ups, \(format(seconds: profile.goalPlankSeconds)) plank")
            InfoLine(title: "Week shape", value: "\(profile.weeklySessions) sessions per week until \(profile.targetDate.formatted(date: .abbreviated, time: .omitted))")
            InfoLine(title: "Recent training", value: historyCount == 0 ? "No logged sessions yet" : "\(historyCount) logged sessions with readiness and notes")
            InfoLine(title: "Log context", value: plannedCount == 0 ? "No sessions in Log yet" : "\(plannedCount) recent or upcoming sessions from Log")
            InfoLine(title: "Ultra context", value: runContext)
            if !profile.painNotes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                CoachReadSection(title: "Notes", bodyText: profile.painNotes)
            }
        }
        .card()
    }
}

private struct SharedAthleteContextCard: View {
    var strengthCount: Int
    var runContext: String
    var runningProfile: RunningTrainingProfile

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Shared athlete context", systemImage: "arrow.triangle.2.circlepath")
                    .font(.headline)
                Spacer()
                StatusPill(text: "Synced", systemImage: "checkmark.circle.fill")
            }
            InfoLine(title: "Strength load", value: strengthCount == 0 ? "No planned sessions" : "\(strengthCount) planned sessions")
            InfoLine(title: "Running load", value: runContext)
            InfoLine(title: "Run profile", value: "\(runningProfile.background.title) · \(runningProfile.durability.title)")
            Text("Strength planning sees running load. Ultra planning sees strength load. Journal signals can plug into this same shared context later.")
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
        }
        .card()
    }
}

private struct UltraRunnerCoachCard: View {
    var runningProfile: RunningTrainingProfile
    var latestPlan: CoachPlan?
    var runLogCount: Int
    var plannedRunCount: Int
    var strengthLoadCount: Int
    var status: String?
    var onGenerate: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Label("Ultra Runner", systemImage: "figure.run")
                    .font(.headline)
                Spacer()
                StatusPill(text: "\(runningProfile.targetRaceKm) km", color: AppTheme.gold, systemImage: "mountain.2.fill")
            }

            Text("Manual-first coach for \(runningProfile.targetRaceKm) km durability: easy volume, HR discipline, walk strategy, hills, long time-on-feet, and fueling practice.")
                .font(.subheadline)
                .foregroundStyle(AppTheme.text)

            VStack(spacing: 8) {
                InfoLine(title: "Current load", value: "\(runningProfile.currentWeeklyDistanceKm) km/week · long \(runningProfile.currentLongRunKm) km")
                InfoLine(title: "Background", value: runningProfile.background.title)
                InfoLine(title: "Durability", value: runningProfile.durability.title)
                InfoLine(title: "Easy target", value: "\(paceText(secondsPerKm: runningProfile.easyPaceSecondsPerKm)) · HR \(runningProfile.easyHeartRate)")
                InfoLine(title: "Terrain", value: "\(runningProfile.terrain.title) · target \(runningProfile.targetElevationMeters)m")
                InfoLine(title: "Strength context", value: strengthLoadCount == 0 ? "No planned strength load" : "\(strengthLoadCount) planned strength sessions")
                InfoLine(title: "Run history", value: runLogCount == 0 ? "No run logs yet" : "\(runLogCount) logged runs")
                InfoLine(title: "Planned runs", value: plannedRunCount == 0 ? "No planned runs" : "\(plannedRunCount) run sessions in Log")
            }

            if let latestPlan {
                CoachReadSection(title: "Latest ultra plan", bodyText: latestPlan.summary)
            }

            Button(action: onGenerate) {
                Label("Generate ultra week", systemImage: "point.3.connected.trianglepath.dotted")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryActionButtonStyle())

            if let status {
                Text(status)
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            }
        }
        .card()
    }
}

func runningContextSummary(from logs: [RunningLog], sessions: [WorkoutSession]) -> String {
    let recentKm = logs.prefix(7).map(\.distanceKm).reduce(0, +)
    let flags = logs.prefix(5).filter { $0.painLevel >= 4 || $0.fatigueLevel >= 9 || $0.hadGIIssues }.count
    if logs.isEmpty && sessions.isEmpty {
        return "No running data yet"
    }
    var parts: [String] = []
    if recentKm > 0 {
        parts.append("\(distanceText(km: recentKm)) recent")
    }
    if !sessions.isEmpty {
        parts.append("\(sessions.count) planned runs")
    }
    if flags > 0 {
        parts.append("\(flags) run flags")
    }
    return parts.isEmpty ? "\(logs.count) run logs" : parts.joined(separator: " · ")
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
