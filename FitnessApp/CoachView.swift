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
    // Configuration, not state: fixed per build flavor (see LocalCoachClient).
    private let endpoint = LocalCoachClient.defaultEndpointString
    @AppStorage("coachModelID") private var selectedModelID = CoachModelCatalog.defaultModelID
    @State private var generationStatus: String?
    @State private var isGeneratingPlan = false
    @State private var isAdvancedExpanded = false

    var profile: UserProfile

    private var latestPlan: CoachPlan? {
        plans.first
    }

    private var latestVerdict: CoachVerdict? {
        verdicts.first
    }

    private var historyLogs: [PerformanceLog] {
        coachHistoryLogs(from: logs)
    }

    private var plannedContextSessions: [WorkoutSession] {
        coachPlannedSessions(from: sessions)
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
                    historyCount: historyLogs.count
                )

                PlanAutomationCard(
                    latestPlan: latestPlan,
                    isGenerating: isGeneratingPlan,
                    status: generationStatus,
                    onRegeneratePlan: generateAIWeek
                )

                AdvancedCoachControls(
                    endpoint: endpoint,
                    selectedModelID: $selectedModelID,
                    isExpanded: $isAdvancedExpanded,
                    profile: profile,
                    historyCount: historyLogs.count,
                    plannedCount: plannedContextSessions.count,
                    raceGoal: raceGoals.first,
                    isGeneratingPlan: isGeneratingPlan,
                    generationStatus: generationStatus,
                    onRegeneratePlan: generateAIWeek
                )
            }
            .navigationTitle("Coach")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func generateAIWeek() {
        // A replan while a push is in flight would delete sessions whose
        // garminWorkoutId has not landed yet, orphaning workouts on the watch.
        guard !GarminSyncCoordinator.isSyncing, !AutoPlanCoordinator.isTriggering else { return }
        Task { await requestPlan() }
    }

    private func requestPlan() async {
        isGeneratingPlan = true
        generationStatus = nil
        defer { isGeneratingPlan = false }

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
        let message = await AutoPlanCoordinator.trigger(
            endpoint: endpoint,
            source: .manual,
            reason: "Manual regenerate plan request.",
            force: true,
            request: request,
            profile: profile,
            in: modelContext
        )
        generationStatus = message ?? "I could not refresh the plan yet. Try again in a bit."
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

}

private struct CoachVerdictCard: View {
    var verdict: CoachVerdict?
    var latestPlan: CoachPlan?
    var profile: UserProfile
    var raceGoal: RaceGoal?
    var historyCount: Int

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

            if let verdict {
                Text("Coach read updated \(verdict.createdAt.formatted(date: .abbreviated, time: .shortened))")
                    .font(.footnote)
                    .foregroundStyle(AppTheme.muted)
                    .accessibilityIdentifier("coach-read-updated-at")
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

            VStack(alignment: .leading, spacing: 12) {
                DomainCoachReadSection(title: "Running", systemImage: "figure.run", bodyText: verdict.runningRead)
                Hairline()
                DomainCoachReadSection(title: "Strength", systemImage: "dumbbell.fill", bodyText: verdict.strengthRead)
                Hairline()
                DomainCoachReadSection(title: "Next step", systemImage: "arrow.forward.circle.fill", bodyText: verdict.nextStep)
            }

            if !verdict.watchItems.isEmpty {
                CoachReadSection(title: "Watch", bodyText: verdict.watchItems.joined(separator: "\n"), accent: true)
            }
        }
    }

    private var starterContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Ready for the first week")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(AppTheme.text)
                Text("I only know your starting numbers and goal for now: \(profile.goalPullUps) pull-ups, \(profile.goalPushUps) push-ups, and a \(format(seconds: profile.goalPlankSeconds)) plank.")
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
            CoachReadSection(title: "Next step", bodyText: "Log the sessions from Log. After you finish one, the coach read updates from what actually happened.")
        }
    }

    private var waitingContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Coach read needed")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(AppTheme.text)
            Text("The coach read updates automatically after your next completed training.")
                .font(.subheadline)
                .foregroundStyle(AppTheme.muted)
        }
    }

    private var pillText: String {
        if verdict?.shouldUpdatePlan == true { return "Plan update" }
        if verdict != nil { return "Updated" }
        return historyCount == 0 ? "Starter" : "Waiting"
    }

    private var pillColor: Color {
        if verdict?.shouldUpdatePlan == true { return AppTheme.warning }
        return AppTheme.accent
    }

    private var pillIcon: String {
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

/// Hybrid staleness: a newer strength log, a newer Garmin run, or a fresh
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

private struct DomainCoachReadSection: View {
    var title: String
    var systemImage: String
    var bodyText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                Image(systemName: systemImage)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(AppTheme.accent)
                    .frame(width: 16)
                MicroLabel(text: title.uppercased(), color: AppTheme.faint)
            }
            Text(bodyText)
                .font(.subheadline)
                .foregroundStyle(AppTheme.text.opacity(0.88))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct PlanAutomationCard: View {
    var latestPlan: CoachPlan?
    var isGenerating: Bool
    var status: String?
    var onRegeneratePlan: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Plan")
                    .font(.lockinSection)
                    .foregroundStyle(AppTheme.text)
                Spacer()
                StatusPill(
                    text: isGenerating ? "Updating" : "Automatic",
                    color: isGenerating ? AppTheme.muted : AppTheme.accent,
                    systemImage: isGenerating ? "hourglass" : "sparkles"
                )
            }

            VStack(spacing: 10) {
                InfoLine(title: "Mode", value: "Night + training")
                InfoLine(title: "Latest AI plan", value: latestPlanText)
            }

            Button(action: onRegeneratePlan) {
                Label(isGenerating ? "Creating schedule" : "Create week schedule", systemImage: "sparkles")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryActionButtonStyle())
            .disabled(isGenerating)
            .accessibilityIdentifier("plan-week-button")

            if isGenerating {
                SwiftUI.ProgressView("Updating plan")
                    .font(.footnote)
                    .tint(AppTheme.muted)
                    .foregroundStyle(AppTheme.muted)
            } else if let status {
                Text(status)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .ruled(verticalPadding: 16)
    }

    private var latestPlanText: String {
        guard let latestPlan else { return "Waiting" }
        return latestPlan.generatedAt.formatted(date: .abbreviated, time: .shortened)
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
                    InfoLine(title: "Available running days", value: runningDaysText)
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
    var isGeneratingPlan: Bool
    var generationStatus: String?
    var onRegeneratePlan: () -> Void

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
                PlanFallbackControls(
                    isGenerating: isGeneratingPlan,
                    status: generationStatus,
                    onRegeneratePlan: onRegeneratePlan
                )
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

private struct PlanFallbackControls: View {
    var isGenerating: Bool
    var status: String?
    var onRegeneratePlan: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: onRegeneratePlan) {
                Label(isGenerating ? "Regenerating" : "Regenerate plan", systemImage: "arrow.triangle.2.circlepath")
            }
            .buttonStyle(SecondaryActionButtonStyle())
            .disabled(isGenerating)
            .accessibilityIdentifier("regenerate-plan-button")

            if isGenerating {
                SwiftUI.ProgressView("Regenerating plan")
                    .font(.footnote)
                    .tint(AppTheme.muted)
                    .foregroundStyle(AppTheme.muted)
            } else if let status {
                Text(status)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
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
