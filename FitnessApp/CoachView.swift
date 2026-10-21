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
    @State private var selectedSection: CoachSection = .read

    var profile: UserProfile

    private var latestPlan: CoachPlan? {
        latestAIPlan(from: plans)
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
            VStack(spacing: 0) {
                CoachSectionSwitcher(selection: $selectedSection)
                    .padding(.horizontal, AppTheme.screenMargin)
                    .padding(.top, 8)
                    .padding(.bottom, 10)
                    .background(AppTheme.background)

                if selectedSection == .read {
                    // The inline navigation bar already says "Coach" — no second title.
                    ScreenBackground(fadesUnderStatusBar: false) {
                        CoachReadSectionView(
                            verdict: latestVerdict,
                            latestPlan: latestPlan,
                            profile: profile,
                            raceGoal: raceGoals.first,
                            historyCount: historyLogs.count
                        )

                        PlanAutomationSection(
                            latestPlan: latestPlan,
                            isGenerating: isGeneratingPlan,
                            status: generationStatus,
                            onRegeneratePlan: generateAIWeek
                        )

                        AskCoachBar { selectedSection = .chat }

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
                } else {
                    CoachChatView(profile: profile)
                }
            }
            .background(AppTheme.background.ignoresSafeArea())
            .navigationTitle("Coach")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func generateAIWeek() {
        // A replan while a push is in flight would delete sessions whose
        // garminWorkoutId has not landed yet, orphaning workouts on the watch.
        guard !GarminSyncCoordinator.isSyncing, !AutoPlanCoordinator.isTriggering else {
            generationStatus = AutoPlanCoordinator.busyMessage
            return
        }
        Task { await requestPlan() }
    }

    private func requestPlan() async {
        isGeneratingPlan = true
        generationStatus = nil
        defer { isGeneratingPlan = false }

        let request: CoachPlanRequest
        do {
            request = try makeCoachRequestFromStore(profile: profile, modelID: selectedModelID, in: modelContext)
        } catch {
            generationStatus = error.localizedDescription
            return
        }
        let outcome = await AutoPlanCoordinator.trigger(
            endpoint: endpoint,
            source: .manual,
            reason: "Manual regenerate plan request.",
            force: true,
            request: request,
            profile: profile,
            in: modelContext
        )
        generationStatus = outcome.message
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

private enum CoachSection: String, CaseIterable, Identifiable {
    case read
    case chat

    var id: String { rawValue }

    var title: String {
        switch self {
        case .read: "Read"
        case .chat: "Chat"
        }
    }
}

/// Read / Chat as two granite-on-white tabs.
private struct CoachSectionSwitcher: View {
    @Binding var selection: CoachSection

    var body: some View {
        HStack(spacing: 4) {
            ForEach(CoachSection.allCases) { section in
                let isSelected = section == selection
                Button {
                    selection = section
                } label: {
                    Text(section.title)
                        .font(.trail(15, .semibold, relativeTo: .subheadline))
                        .foregroundStyle(isSelected ? Color.white : AppTheme.text)
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(isSelected ? AppTheme.text : Color.clear)
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(4)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(AppTheme.surface))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(AppTheme.divider, lineWidth: 1))
        .animation(.snappy(duration: 0.2), value: selection)
        .accessibilityIdentifier("coach-section-picker")
    }
}

/// A small capsule label. Attention turns it marker red.
struct CoachChip: View {
    var text: String
    var systemImage: String?
    var isAttention: Bool = false

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 10, weight: .bold))
            }
            Text(text)
                .font(.trail(12, .semibold, relativeTo: .caption1))
        }
        .foregroundStyle(isAttention ? AppTheme.markerRedText : AppTheme.text)
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .overlay(Capsule().strokeBorder(isAttention ? AppTheme.markerRed : AppTheme.divider, lineWidth: 1))
    }
}

// MARK: - Coach read

private struct CoachReadSectionView: View {
    var verdict: CoachVerdict?
    var latestPlan: CoachPlan?
    var profile: UserProfile
    var raceGoal: RaceGoal?
    var historyCount: Int

    /// "14 weeks to Eiger Ultra 51K": the lens every read is written through.
    private var raceLensText: String? {
        guard let raceGoal else { return nil }
        let calendar = Calendar.current
        let days = max(0, calendar.dateComponents([.day], from: calendar.startOfDay(for: Date()), to: raceGoal.raceDate).day ?? 0)
        let weeks = (days + 6) / 7
        let trimmedName = raceGoal.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = trimmedName.isEmpty ? "Race" : trimmedName
        if weeks == 0 { return "Race week: \(name)" }
        return "\(weeks) \(weeks == 1 ? "week" : "weeks") to \(name)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader("Coach read") {
                CoachChip(text: chipText, systemImage: chipIcon, isAttention: verdict?.shouldUpdatePlan == true)
            }

            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 8) {
                    if let raceLensText {
                        Text(raceLensText)
                            .font(.trail(13, .semibold, relativeTo: .footnote))
                            .foregroundStyle(AppTheme.text)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 3)
                            .background(RoundedRectangle(cornerRadius: 4).fill(AppTheme.sign))
                    }
                    headlineContent
                }
                .padding(16)

                if let verdict {
                    CoachJudgementScorecard(verdict: verdict)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .card(padding: 0)

            if let verdict {
                verdictDetails(verdict)
            } else if latestPlan != nil {
                CoachTextSection(
                    title: "Next step",
                    bodyText: "Log the sessions from Log. After you finish one, the coach read updates from what actually happened."
                )
            } else if historyCount == 0 {
                CoachTextSection(
                    title: "Starting point",
                    bodyText: "I will keep the first week conservative and use your baseline, selected training days, equipment, target date, and any pain notes."
                )
            }

            if let verdict {
                Text("Updated \(verdict.createdAt.formatted(date: .abbreviated, time: .shortened))")
                    .font(.lockinMeta)
                    .foregroundStyle(AppTheme.muted)
                    .accessibilityIdentifier("coach-read-updated-at")
            }
        }
    }

    @ViewBuilder
    private var headlineContent: some View {
        if let verdict {
            headline(verdict.headline, body: verdict.summary)
        } else if let latestPlan {
            Text(latestPlan.summary)
                .font(.trail(17, .regular, relativeTo: .body))
                .foregroundStyle(AppTheme.text)
                .fixedSize(horizontal: false, vertical: true)
        } else if historyCount == 0 {
            headline(
                "Ready for the first week",
                body: "I only know your starting numbers and goal for now: \(profile.goalPullUps) pull-ups, \(profile.goalPushUps) push-ups, and a \(format(seconds: profile.goalPlankSeconds)) plank."
            )
        } else {
            headline("Coach read needed", body: "The coach read updates automatically after your next completed training.")
        }
    }

    private func headline(_ title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.trail(28, .bold, relativeTo: .title1))
                .foregroundStyle(AppTheme.text)
                .fixedSize(horizontal: false, vertical: true)
            Text(body)
                .font(.lockinBody)
                .foregroundStyle(AppTheme.bodyText)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func verdictDetails(_ verdict: CoachVerdict) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(spacing: 0) {
                DomainReadRow(title: "Running", systemImage: "figure.run", bodyText: verdict.runningRead)
                Hairline()
                DomainReadRow(title: "Strength", systemImage: "dumbbell.fill", bodyText: verdict.strengthRead)
                Hairline()
                DomainReadRow(title: "Next step", systemImage: "arrow.turn.up.right", bodyText: verdict.nextStep)
            }
            .padding(.horizontal, 14)
            .card(padding: 0)

            if !verdict.coachEvaluationReasons.isEmpty {
                CoachTextSection(title: "Why", bodyText: verdict.coachEvaluationReasons.prefix(3).joined(separator: "\n"))
            }

            if !verdict.watchItems.isEmpty {
                WatchBox(items: verdict.watchItems)
            }
        }
    }

    private var chipText: String {
        if verdict?.shouldUpdatePlan == true { return "Plan update" }
        if verdict != nil { return "Up to date" }
        return historyCount == 0 ? "Starter" : "Waiting"
    }

    private var chipIcon: String {
        if verdict?.shouldUpdatePlan == true { return "exclamationmark.triangle.fill" }
        return verdict != nil ? "checkmark" : "hourglass"
    }
}

private struct CoachJudgementScorecard: View {
    var verdict: CoachVerdict

    var body: some View {
        VStack(spacing: 0) {
            Hairline()
            HStack(alignment: .top, spacing: 0) {
                CoachJudgementCell(
                    title: "State",
                    value: verdict.evaluationStatusLabel,
                    detail: nil,
                    isAttention: statusNeedsAttention
                )
                verticalRule
                CoachJudgementCell(
                    title: "Adherence",
                    value: verdict.adherenceLabel,
                    detail: verdict.adherenceDetail,
                    isAttention: (verdict.adherencePct ?? 100) < 80
                )
                verticalRule
                CoachJudgementCell(
                    title: "Plan",
                    value: verdict.planDecisionLabel,
                    detail: verdict.shouldUpdatePlan ? "Auto update" : "Hold",
                    isAttention: planNeedsAttention
                )
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 16)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("coach-evaluation-scorecard")
    }

    private var verticalRule: some View {
        Rectangle()
            .fill(AppTheme.dividerSoft)
            .frame(width: 1)
            .padding(.horizontal, 10)
    }

    private var statusNeedsAttention: Bool {
        ["watch", "behind", "needs_recovery", "recovery_needed", "overreaching"].contains(verdict.evaluationStatus)
    }

    private var planNeedsAttention: Bool {
        switch verdict.planDecisionActionRaw {
        case "keep_plan": false
        case "gate_intensity", "update_plan", "recovery_first": true
        default: verdict.shouldUpdatePlan
        }
    }
}

private struct CoachJudgementCell: View {
    var title: String
    var value: String
    var detail: String?
    var isAttention: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.trail(12, .regular, relativeTo: .caption1))
                .foregroundStyle(AppTheme.muted)
            Text(value)
                .font(.trail(16, .semibold, relativeTo: .headline))
                .foregroundStyle(isAttention ? AppTheme.markerRedText : AppTheme.text)
                .lineLimit(2)
                .minimumScaleFactor(0.72)
                .fixedSize(horizontal: false, vertical: true)
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(.trail(12, .regular, relativeTo: .caption1))
                    .foregroundStyle(AppTheme.muted)
                    .lineLimit(2)
                    .minimumScaleFactor(0.75)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One domain of the read (running, strength, next step) as a row with its
/// icon in a small white disc.
private struct DomainReadRow: View {
    var title: String
    var systemImage: String
    var bodyText: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(AppTheme.text)
                .frame(width: 32, height: 32)
                .background(Circle().fill(AppTheme.background))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.trail(15, .semibold, relativeTo: .subheadline))
                    .foregroundStyle(AppTheme.text)
                Text(bodyText)
                    .font(.trail(15, .regular, relativeTo: .subheadline))
                    .foregroundStyle(AppTheme.bodyText)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 12)
    }
}

private struct CoachTextSection: View {
    var title: String
    var bodyText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.trail(15, .semibold, relativeTo: .subheadline))
                .foregroundStyle(AppTheme.text)
            Text(bodyText)
                .font(.trail(15, .regular, relativeTo: .subheadline))
                .foregroundStyle(AppTheme.bodyText)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 2)
    }
}

/// Things to keep an eye on, framed in marker red with the mountain-trail
/// mark: caution, not alarm.
private struct WatchBox: View {
    var items: [String]

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            TrailMark(grade: .mountain, width: 30, height: 21)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text("Watch")
                    .font(.trail(13, .semibold, relativeTo: .footnote))
                    .foregroundStyle(AppTheme.markerRedText)
                ForEach(items, id: \.self) { item in
                    Text(item)
                        .font(.trail(16, .semibold, relativeTo: .body))
                        .foregroundStyle(AppTheme.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(AppTheme.surface))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(AppTheme.markerRed, lineWidth: 2))
        .accessibilityElement(children: .combine)
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

// MARK: - Plan

private struct PlanAutomationSection: View {
    var latestPlan: CoachPlan?
    var isGenerating: Bool
    var status: String?
    var onRegeneratePlan: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader("Plan") {
                CoachChip(
                    text: isGenerating ? "Updating" : "Automatic",
                    systemImage: isGenerating ? "hourglass" : "arrow.triangle.2.circlepath"
                )
            }

            VStack(spacing: 0) {
                InfoLine(title: "Updates", value: "Every night and after training")
                    .padding(.vertical, 14)
                Hairline()
                InfoLine(title: "Latest plan", value: latestPlanText)
                    .padding(.vertical, 14)
            }
            .padding(.horizontal, 16)
            .card(padding: 0)

            Button(isGenerating ? "Creating schedule" : "Create week schedule", action: onRegeneratePlan)
                .buttonStyle(PrimaryActionButtonStyle())
                .disabled(isGenerating)
                .accessibilityIdentifier("plan-week-button")

            if isGenerating {
                HStack(spacing: 8) {
                    SwiftUI.ProgressView()
                        .tint(AppTheme.muted)
                    Text("Updating your plan…")
                }
                .font(.lockinMeta)
                .foregroundStyle(AppTheme.muted)
            } else if let status {
                Text(status)
                    .font(.lockinMeta)
                    .foregroundStyle(AppTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var latestPlanText: String {
        guard let latestPlan else { return "Waiting" }
        return latestPlan.generatedAt.formatted(date: .abbreviated, time: .shortened)
    }
}

/// Looks like the chat field; tapping it switches to Chat.
private struct AskCoachBar: View {
    var onOpenChat: () -> Void

    var body: some View {
        Button(action: onOpenChat) {
            HStack(spacing: 8) {
                Text("Ask the coach anything")
                    .font(.lockinBody)
                    .foregroundStyle(AppTheme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .frame(height: 46)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(AppTheme.surface))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(AppTheme.post.opacity(0.6), lineWidth: 1)
                    )
                Image(systemName: "arrow.up")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(AppTheme.text)
                    .frame(width: 46, height: 46)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(AppTheme.sign))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Ask the coach")
        .accessibilityHint("Opens coach chat")
    }
}

// MARK: - Advanced

private struct CoachInputsCard: View {
    var profile: UserProfile
    var historyCount: Int
    var plannedCount: Int
    var raceGoal: RaceGoal?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("What I'll use")
                .font(.trail(17, .semibold, relativeTo: .headline))
                .foregroundStyle(AppTheme.text)
            VStack(spacing: 12) {
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
            .card(padding: 16)
            if !profile.painNotes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                CoachTextSection(title: "Notes", bodyText: profile.painNotes)
            }
        }
    }

    private func raceGoalSummary(_ goal: RaceGoal) -> String {
        let trimmedName = goal.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = trimmedName.isEmpty ? "Race" : trimmedName
        let distance = goal.distanceKm.formatted(.number.precision(.fractionLength(0...1)))
        let raceDate = goal.raceDate.formatted(date: .abbreviated, time: .omitted)
        return "\(name), \(distance) km, \(goal.elevationGainM) m climb, \(raceDate)"
    }

    private func weeksToRaceText(_ goal: RaceGoal) -> String {
        let calendar = Calendar.current
        let days = max(0, calendar.dateComponents([.day], from: calendar.startOfDay(for: Date()), to: goal.raceDate).day ?? 0)
        let weeks = (days + 6) / 7
        if weeks == 0 { return "Race week" }
        return weeks == 1 ? "1 week" : "\(weeks) weeks"
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
        VStack(alignment: .leading, spacing: 0) {
            Hairline()
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
                .padding(.top, 8)
                .padding(.bottom, 12)
            } label: {
                Text("Advanced")
                    .font(.trail(15, .semibold, relativeTo: .subheadline))
                    .foregroundStyle(AppTheme.muted)
                    .frame(minHeight: 44)
            }
            .tint(AppTheme.muted)
        }
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
                HStack(spacing: 8) {
                    SwiftUI.ProgressView()
                        .tint(AppTheme.muted)
                    Text("Regenerating plan…")
                }
                .font(.lockinMeta)
                .foregroundStyle(AppTheme.muted)
            } else if let status {
                Text(status)
                    .font(.lockinMeta)
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
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Model")
                    .font(.trail(15, .regular, relativeTo: .subheadline))
                    .foregroundStyle(AppTheme.muted)
                Spacer()
                Picker("Model", selection: normalizedSelection) {
                    ForEach(modelOptions, id: \.self) { modelID in
                        Text(modelID).tag(modelID)
                    }
                }
                .pickerStyle(.menu)
                .tint(AppTheme.text)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if isRefreshing {
                HStack(spacing: 8) {
                    SwiftUI.ProgressView()
                        .tint(AppTheme.muted)
                    Text("Loading models…")
                }
                .font(.lockinMeta)
                .foregroundStyle(AppTheme.muted)
            } else if let status {
                Text(status)
                    .font(.lockinMeta)
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
