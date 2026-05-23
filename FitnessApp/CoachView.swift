import SwiftData
import SwiftUI

struct CoachView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \CoachPlan.generatedAt, order: .reverse) private var plans: [CoachPlan]
    @AppStorage("coachProxyEndpoint") private var endpoint = "http://127.0.0.1:8787/generate-week-plan"
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
            ProxyEndpointCard(endpoint: $endpoint)
            DatabaseContextCard(
                profile: profile,
                historyCount: coachHistoryLogs.count,
                plannedCount: coachPlannedSessions.count
            )
            PrivacyBoundaryCard()
        }
    }

    private var rulesContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            CoachSkillCard()
            ValidationRulesCard()
        }
    }

    private func generateAIWeek() {
        Task { await requestPlan() }
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

private struct ProxyEndpointCard: View {
    @Binding var endpoint: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Proxy URL", systemImage: "link")
                .font(.headline)
            TextField("Proxy URL", text: $endpoint)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
        }
        .card()
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

private struct PrivacyBoundaryCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Privacy & architecture", systemImage: "lock.shield")
                .font(.headline)
            Text("API key stays behind your local proxy. The iOS app stores only the proxy URL.")
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
            HStack(spacing: 16) {
                BoundaryNode(title: "iPhone", icon: "iphone")
                Image(systemName: "arrow.right")
                    .foregroundStyle(AppTheme.muted)
                BoundaryNode(title: "Local Proxy", icon: "shield")
                Image(systemName: "arrow.right")
                    .foregroundStyle(AppTheme.muted)
                BoundaryNode(title: "AI Provider", icon: "cloud")
            }
        }
        .card()
    }
}

private struct BoundaryNode: View {
    var title: String
    var icon: String

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(AppTheme.text)
            Text(title)
                .font(.caption2)
                .foregroundStyle(AppTheme.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
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
