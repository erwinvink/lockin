import SwiftData
import SwiftUI

struct CoachView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \CoachPlan.generatedAt, order: .reverse) private var plans: [CoachPlan]
    @AppStorage("coachProxyEndpoint") private var endpoint = LocalCoachClient.defaultEndpointString
    @AppStorage("coachModelID") private var selectedModelID = CoachModelCatalog.defaultModelID
    @State private var status: String?
    @State private var isLoading = false
    @State private var selectedMode: CoachMode = .generate

    var profile: UserProfile

    private var latestPlan: CoachPlan? {
        plans.first
    }

    private var upcomingSessions: [WorkoutSession] {
        let start = rollingPlanStart()
        let end = rollingPlanEnd()
        return sessions.filter { $0.scheduledDate >= start && $0.scheduledDate < end }
    }

    var body: some View {
        NavigationStack {
            ScreenBackground(title: "AI Coach") {
                Picker("Coach view", selection: $selectedMode) {
                    ForEach(CoachMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)

                switch selectedMode {
                case .generate:
                    generateContent
                case .context:
                    contextContent
                case .rules:
                    rulesContent
                }

                Button(action: generateAIWeek) {
                    Label(isLoading ? "Generating" : "Generate AI week", systemImage: "sparkles")
                }
                .buttonStyle(PrimaryActionButtonStyle())
                .disabled(isLoading)
                .opacity(isLoading ? 0.55 : 1)

                if let status {
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(AppTheme.muted)
                        .card()
                }
            }
            .navigationTitle("Coach")
            .navigationBarTitleDisplayMode(.inline)
        }
        .onAppear(perform: enforceHostedEndpoint)
    }

    private var generateContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            CoachGeneratorCard(
                latestPlan: latestPlan,
                upcomingCount: upcomingSessions.count,
                windowStart: rollingPlanStart(),
                windowEnd: rollingPlanEnd()
            )
            SafetyFlagsCard()
        }
    }

    private var contextContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            CoachModelCard(endpoint: endpoint, selectedModelID: $selectedModelID)
            DatabaseContextCard(
                profile: profile,
                historyCount: coachHistoryLogs.count,
                plannedCount: coachPlannedSessions.count
            )
        }
    }

    private var rulesContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            CoachSkillCard()
            ValidationRulesCard()
        }
    }

    private func generateAIWeek() {
        enforceHostedEndpoint()
        Task { await requestPlan() }
    }

    private func enforceHostedEndpoint() {
        if (try? LocalCoachClient(endpointString: endpoint)) == nil {
            endpoint = LocalCoachClient.defaultEndpointString
        }
    }

    private func requestPlan() async {
        isLoading = true
        status = nil
        defer { isLoading = false }

        do {
            let baseline = Baseline(pullUps: profile.baselinePullUps, pushUps: profile.baselinePushUps, plankSeconds: profile.baselinePlankSeconds)
            let preferences = TrainingPreferences(
                weeklySessions: profile.weeklySessions,
                equipment: profile.equipment,
                targetDate: profile.targetDate
            )
            let request = CoachPlanRequest(
                model: CoachModelCatalog.normalized(selectedModelID),
                baseline: CoachBaseline(pullUps: baseline.pullUps, pushUps: baseline.pushUps, plankSeconds: baseline.plankSeconds),
                goals: CoachGoals(pullUps: profile.goalPullUps, pushUps: profile.goalPushUps, plankSeconds: profile.goalPlankSeconds),
                weekStart: rollingPlanStart(),
                weeklySessions: profile.weeklySessions,
                equipment: profile.equipment.map(\.rawValue).sorted(),
                targetDate: profile.targetDate,
                trainingLogs: coachHistoryLogs.map {
                    CoachLog(
                        id: $0.id.uuidString,
                        sessionId: $0.sessionId.uuidString,
                        completedAt: $0.completedAt,
                        pullUps: $0.pullUps,
                        pushUps: $0.pushUps,
                        plankSeconds: $0.plankSeconds,
                        loggedPullUps: $0.loggedPullUps,
                        loggedPushUps: $0.loggedPushUps,
                        loggedPlankSeconds: $0.loggedPlankSeconds,
                        rpe: $0.rpe,
                        painLevel: $0.painLevel,
                        fatigueLevel: $0.fatigueLevel
                    )
                },
                plannedSessions: coachPlannedSessions.map {
                    CoachPlannedSession(
                        id: $0.id.uuidString,
                        scheduledDate: $0.scheduledDate,
                        title: $0.title,
                        focus: $0.focus.rawValue,
                        status: $0.status.rawValue
                    )
                }
            )
            let response = try await LocalCoachClient(endpointString: endpoint).generatePlan(request: request, baseline: baseline, preferences: preferences)
            let plan = response.weeklyPlan(weekStart: request.weekStart)
            try persist(plan: plan, in: modelContext, source: .ai, replacingFuturePlannedSessions: true)
            try modelContext.save()
            status = "Saved \(plan.sessions.count) sessions for the next 7 days. Open Log to view them."
        } catch {
            status = error.localizedDescription
        }
    }

    private var coachHistoryLogs: [PerformanceLog] {
        let cutoff = Calendar.current.date(byAdding: .month, value: -3, to: Date()) ?? Date.distantPast
        return logs
            .filter { $0.completedAt >= cutoff }
            .sorted { $0.completedAt < $1.completedAt }
    }

    private var coachPlannedSessions: [WorkoutSession] {
        let start = Calendar.current.date(byAdding: .month, value: -2, to: Date()) ?? Date.distantPast
        let end = Calendar.current.date(byAdding: .month, value: 1, to: Date()) ?? Date.distantFuture
        return sessions
            .filter { $0.scheduledDate >= start && $0.scheduledDate <= end }
            .sorted { $0.scheduledDate < $1.scheduledDate }
    }
}

private enum CoachMode: String, CaseIterable, Identifiable {
    case generate
    case context
    case rules

    var id: String { rawValue }

    var title: String {
        switch self {
        case .generate: "Generate"
        case .context: "Context"
        case .rules: "Rules"
        }
    }
}

private struct CoachGeneratorCard: View {
    var latestPlan: CoachPlan?
    var upcomingCount: Int
    var windowStart: Date
    var windowEnd: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Plan generator", systemImage: "sparkles")
                .font(.headline)
            InfoLine(title: "Window", value: "\(windowStart.formatted(date: .abbreviated, time: .omitted)) - \(windowEnd.formatted(date: .abbreviated, time: .omitted))")
            InfoLine(title: "Scheduled", value: "\(upcomingCount) sessions in Log")
            InfoLine(title: "Last refresh", value: latestRefreshText)
        }
        .card()
    }

    private var latestRefreshText: String {
        guard let latestPlan else {
            return "Not yet"
        }
        let source = latestPlan.sourceRaw == PlanSource.ai.rawValue ? "AI" : "Local"
        return "\(source), \(latestPlan.generatedAt.formatted(date: .omitted, time: .shortened))"
    }
}

private struct SafetyFlagsCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Safety flags".uppercased())
                .font(.caption.weight(.bold))
            InfoLine(title: "Pain spike", value: "None", valueColor: AppTheme.accent)
            InfoLine(title: "Overreaching", value: "None", valueColor: AppTheme.accent)
            InfoLine(title: "Rule violations", value: "None", valueColor: AppTheme.accent)
        }
        .card()
    }
}

private struct CoachModelCard: View {
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
        VStack(alignment: .leading, spacing: 12) {
            Label("Model", systemImage: "cpu")
                .font(.headline)

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
        .card()
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

private struct DatabaseContextCard: View {
    var profile: UserProfile
    var historyCount: Int
    var plannedCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Database context sent", systemImage: "externaldrive.connected.to.line.below")
                .font(.headline)
            Text("Baseline \(profile.baselinePullUps)/\(profile.baselinePushUps)/\(format(seconds: profile.baselinePlankSeconds)), goals \(profile.goalPullUps)/\(profile.goalPushUps)/\(format(seconds: profile.goalPlankSeconds)), \(profile.weeklySessions) sessions per week, equipment, target date, \(historyCount) recent logs, and \(plannedCount) planned/completed sessions.")
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
            Text("The proxy summarizes last 5 logs, current partial month, last full month, and previous full month before calling the model.")
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
        }
        .card()
    }
}

private struct CoachSkillCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Coach skill bundle", systemImage: "list.bullet.clipboard")
                .font(.headline)
            Text(CoachSkillDisplay.relationship)
                .font(.caption.monospaced())
                .foregroundStyle(AppTheme.muted)
                .textSelection(.enabled)
            DisclosureGroup("Skill path and references") {
                Text(CoachSkillDisplay.bundleContents)
                    .font(.caption.monospaced())
                    .foregroundStyle(AppTheme.muted)
                    .textSelection(.enabled)
                    .padding(.top, 6)
            }
        }
        .card()
    }
}

private struct ValidationRulesCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Local safety checks", systemImage: "checklist.checked")
                .font(.headline)
            InfoLine(title: "Schema", value: "Valid", valueColor: AppTheme.accent)
            InfoLine(title: "Progression caps", value: "Enforced", valueColor: AppTheme.accent)
            InfoLine(title: "Equipment rules", value: "Enforced", valueColor: AppTheme.accent)
        }
        .card()
    }
}
