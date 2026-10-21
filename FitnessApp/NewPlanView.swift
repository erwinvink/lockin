import SwiftData
import SwiftUI

/// What "Start a new plan" opens with: the inputs pre-filled from the
/// profile, and the current numbers they were filled from.
struct NewPlanDraft: Identifiable {
    let id = UUID()
    var inputs: PlanInputs
    var current: StrengthNumbers

    @MainActor
    static func make(profile: UserProfile, raceGoal: RaceGoal?, in modelContext: ModelContext) -> NewPlanDraft {
        let logs = (try? modelContext.fetch(FetchDescriptor<PerformanceLog>())) ?? []
        let current = currentStrengthNumbers(profile: profile, logs: logs)
        return NewPlanDraft(inputs: PlanInputs(profile: profile, raceGoal: raceGoal, current: current), current: current)
    }
}

/// "Start a new plan" from Profile. The athlete redoes the plan inputs with
/// Onboarding's sections, pre-filled; confirming keeps all history, replaces
/// the open plan (see `startNewPlan`) and asks the coach for a fresh week
/// right away.
struct NewPlanView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    // Configuration, not state: fixed per build flavor (see LocalCoachClient).
    private let endpoint = LocalCoachClient.defaultEndpointString
    @AppStorage(CoachModelCatalog.selectedModelKey) private var selectedModelID = CoachModelCatalog.defaultModelID

    var profile: UserProfile
    /// Called from "Done"; true when the new week landed.
    var onFinish: (_ planReady: Bool) -> Void

    private let current: StrengthNumbers
    @State private var inputs: PlanInputs
    @State private var baselineChoice: BaselineChoice = .keepCurrent
    @State private var isConfirming = false
    @State private var commitError: String?
    @State private var phase: Phase = .editing

    enum Phase: Equatable {
        case editing
        case planning
        case ready(summary: String)
        case offline
        case failed(message: String)
    }

    init(profile: UserProfile, draft: NewPlanDraft, onFinish: @escaping (_ planReady: Bool) -> Void) {
        self.profile = profile
        self.onFinish = onFinish
        self.current = draft.current
        _inputs = State(initialValue: draft.inputs)
    }

    /// The inputs as they will be saved: kept numbers replace any edits.
    private var finalInputs: PlanInputs {
        baselineChoice == .keepCurrent ? inputs.applyingStrengthNumbers(current) : inputs
    }

    private var blockingReason: String? {
        let today = Calendar.current.startOfDay(for: Date())
        if Calendar.current.startOfDay(for: inputs.targetDate) <= today { return "Pick a target date that is still ahead." }
        if let reason = inputs.blockingReason { return reason }
        if inputs.isTrainingForRace && Calendar.current.startOfDay(for: inputs.raceDate) < today {
            return "Pick a race date that is still ahead."
        }
        return nil
    }

    var body: some View {
        NavigationStack {
            Group {
                if phase == .editing {
                    form
                } else {
                    outcome
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    // Results end with their own buttons.
                    if phase == .editing {
                        Button("Cancel") { dismiss() }
                            .foregroundStyle(AppTheme.muted)
                    } else if phase == .planning {
                        Button("Close") { dismiss() }
                            .foregroundStyle(AppTheme.muted)
                    }
                }
            }
        }
        .presentationBackground(AppTheme.background)
    }

    // MARK: Form

    private var form: some View {
        ScreenBackground {
            SignpostStack {
                Signpost(eyebrow: "Start over", title: "New plan", trailing: "2 min")
            }
            .padding(.top, 6)

            Text("Change what is different now. The coach plans a fresh week from here and keeps learning from your history.")
                .font(.trail(17, .regular, relativeTo: .body))
                .foregroundStyle(AppTheme.text)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, -14)

            RaceSection(
                isTrainingForRace: $inputs.isTrainingForRace,
                raceName: $inputs.raceName,
                raceDate: $inputs.raceDate,
                raceDistanceKm: $inputs.raceDistanceKm,
                raceElevationGainM: $inputs.raceElevationGainM,
                runningDays: $inputs.runningDays,
                longRunDay: $inputs.longRunDay
            )

            NowAndGoalSection(
                pullUps: $inputs.pullUps,
                pushUps: $inputs.pushUps,
                plankSeconds: $inputs.plankSeconds,
                goalPullUps: $inputs.goalPullUps,
                goalPushUps: $inputs.goalPushUps,
                goalPlankSeconds: $inputs.goalPlankSeconds,
                targetDate: $inputs.targetDate,
                baselineChoice: $baselineChoice
            )

            TrainingDaysPicker(
                selectedDays: $inputs.trainingDays,
                title: "Strength days",
                caption: "Pick 2 to 6 days. The coach only plans on these days."
            )

            SessionLengthSection(minutes: $inputs.sessionMinutes)

            EquipmentSection(selectedEquipment: $inputs.equipment)

            GuardrailsSection(
                strictForm: $inputs.strictForm,
                painNotes: $inputs.painNotes
            )

            WhatHappensSection()

            VStack(alignment: .leading, spacing: 8) {
                Button("Start new plan") {
                    commitError = nil
                    isConfirming = true
                }
                .buttonStyle(PrimaryActionButtonStyle())
                .disabled(blockingReason != nil)
                .accessibilityIdentifier("new-plan-start-button")
                if let reason = blockingReason ?? commitError {
                    Text(reason)
                        .font(.trail(14, .semibold, relativeTo: .subheadline))
                        .foregroundStyle(AppTheme.markerRedText)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.updatesFrequently)
                }
            }
            .padding(.top, 4)
        }
        .scrollDismissesKeyboard(.interactively)
        .alert("Start a new plan?", isPresented: $isConfirming) {
            Button("Cancel", role: .cancel) {}
            Button("Start new plan", action: commit)
        } message: {
            Text("Open sessions from today on are removed, also from your watch. Your logs, runs, readiness, streaks and coach chat stay.")
        }
    }

    // MARK: Outcome

    private var outcome: some View {
        // No toolbar row above the sign here, so the status-bar fade would
        // wash out its top edge.
        ScreenBackground(fadesUnderStatusBar: false) {
            SignpostStack {
                Signpost(
                    eyebrow: "New plan",
                    title: outcomeTitle,
                    trailing: "",
                    style: isReady ? .yellow : .plain
                )
            }
            .padding(.top, 6)

            VStack(alignment: .leading, spacing: 12) {
                if phase == .planning {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        SwiftUI.ProgressView()
                            .tint(AppTheme.text)
                            .accessibilityLabel("Planning")
                        bodyText("The coach is building the next 7 days from your new goals and your history.")
                    }
                    NoteText("You can close this. The plan shows up on Today when it lands.")
                } else {
                    bodyText(outcomeBody)
                    if case .failed(let message) = phase, !message.isEmpty {
                        NoteText(message, isError: true)
                    }
                }
            }
            .padding(.top, -14)

            if phase != .planning {
                VStack(spacing: 10) {
                    if isReady {
                        Button("Done") { finish(planReady: true) }
                            .buttonStyle(PrimaryActionButtonStyle())
                    } else {
                        Button("Try again") { Task { await requestPlan() } }
                            .buttonStyle(PrimaryActionButtonStyle())
                        Button("Done") { finish(planReady: false) }
                            .buttonStyle(SecondaryActionButtonStyle())
                    }
                }
                .padding(.top, 4)
            }
        }
    }

    private var isReady: Bool {
        if case .ready = phase { return true }
        return false
    }

    private var outcomeTitle: String {
        switch phase {
        case .editing, .planning: "Planning your week"
        case .ready: "Your week is ready"
        case .offline: "Waiting for the coach"
        case .failed: "No plan yet"
        }
    }

    private var outcomeBody: String {
        switch phase {
        case .editing, .planning: ""
        case .ready(let summary): summary
        case .offline:
            "Your new goals are saved and the old open sessions are gone. lockin can't reach the coach right now, so it asks again the next time you open the app. You can also plan the week from Coach."
        case .failed:
            "Your new goals are saved and the old open sessions are gone, but the coach didn't send a plan. Try again, or plan the week from Coach later."
        }
    }

    private func bodyText(_ text: String) -> some View {
        Text(text)
            .font(.trail(17, .regular, relativeTo: .body))
            .foregroundStyle(AppTheme.text)
            .lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: Actions

    private func commit() {
        // Removing sessions while a watch push is in flight would orphan
        // workouts whose Garmin id has not landed yet.
        guard !GarminSyncCoordinator.isSyncing, !AutoPlanCoordinator.isTriggering else {
            commitError = AutoPlanCoordinator.busyMessage
            return
        }
        do {
            try startNewPlan(with: finalInputs, profile: profile, in: modelContext)
        } catch {
            commitError = "Could not start the new plan: \(error.localizedDescription)"
            return
        }
        phase = .planning
        Task {
            // The removed sessions must not keep their reminders.
            await refreshWorkoutReminders(in: modelContext)
            await requestPlan()
        }
    }

    private func requestPlan() async {
        guard !GarminSyncCoordinator.isSyncing, !AutoPlanCoordinator.isTriggering else {
            // Another plan or watch sync is running; the next open retries.
            PlanRefreshRequest.mark()
            phase = .failed(message: AutoPlanCoordinator.busyMessage)
            return
        }
        phase = .planning
        // This forced plan covers any replan Profile edits asked for.
        _ = PlanRefreshRequest.consume()
        let result = await planOutcome()
        if PlanRefreshRequest.shouldRetry(after: result) {
            // Offline or busy: the next app open asks again.
            PlanRefreshRequest.mark()
        }
        if result.appliedNewPlan {
            phase = .ready(summary: readySummary())
        } else if !result.reachedProxy {
            phase = .offline
        } else {
            phase = .failed(message: result.message)
        }
    }

    private func planOutcome() async -> AutoPlanTriggerOutcome {
        // UI tests stay hermetic, like the app shell's refresh: no proxy
        // call, so the flow takes the offline path.
        if ProcessInfo.processInfo.arguments.contains("UITesting") {
            return AutoPlanTriggerOutcome(message: "", appliedNewPlan: false, reachedProxy: false)
        }
        let request: CoachPlanRequest
        do {
            request = try makeCoachRequestFromStore(profile: profile, modelID: selectedModelID, in: modelContext)
        } catch {
            return AutoPlanTriggerOutcome(message: error.localizedDescription, appliedNewPlan: false, reachedProxy: true)
        }
        return await AutoPlanCoordinator.trigger(
            endpoint: endpoint,
            source: .manual,
            reason: "Athlete started a new plan.",
            force: true,
            request: request,
            profile: profile,
            in: modelContext
        )
    }

    /// "5 sessions planned for the next 7 days. First up: Pull Capacity on
    /// Thursday."
    private func readySummary() -> String {
        let startOfToday = Calendar.current.startOfDay(for: Date())
        let upcoming = ((try? modelContext.fetch(FetchDescriptor<WorkoutSession>(sortBy: [SortDescriptor(\.scheduledDate)]))) ?? [])
            .filter { $0.status == .planned && $0.scheduledDate >= startOfToday }
        guard let first = upcoming.first else { return "The coach sent the new plan." }
        let count = upcoming.count
        let day = first.scheduledDate.formatted(.dateTime.weekday(.wide))
        return "\(count) \(count == 1 ? "session" : "sessions") planned for the next 7 days. First up: \(first.title) on \(day)."
    }

    private func finish(planReady: Bool) {
        onFinish(planReady)
        dismiss()
    }
}

// MARK: - Sections

/// The longest a strength session may take, or leave it to the coach.
private struct SessionLengthSection: View {
    @Binding var minutes: Int

    private static let options = [0, 30, 45, 60, 75, 90]

    var body: some View {
        FormGroup("Session length") {
            FlowLayout(spacing: 6) {
                ForEach(Self.options, id: \.self) { option in
                    SelectableChip(title: option == 0 ? "Coach decides" : "\(option) min", isOn: minutes == option) {
                        minutes = option
                    }
                }
            }
            NoteText("How long one strength session may take at most. Runs follow the race plan.")
        }
    }
}

/// What a new plan keeps and what it replaces, as two waypoints.
private struct WhatHappensSection: View {
    var body: some View {
        FormGroup("What happens") {
            ListCard {
                row(
                    state: .done,
                    title: "Stays",
                    detail: "Logs, runs, readiness, streaks and coach chat."
                )
                ListCardRule()
                row(
                    state: .unplanned,
                    title: "Starts over",
                    detail: "Open sessions from today on, also on your watch, and the coach read. The coach plans the next 7 days."
                )
            }
        }
    }

    private func row(state: WaypointState, title: String, detail: String) -> some View {
        ListCardRow(minHeight: 64) {
            HStack(alignment: .top, spacing: 12) {
                WaypointMarker(state: state, size: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.trail(16, .semibold, relativeTo: .body))
                        .foregroundStyle(AppTheme.text)
                    Text(detail)
                        .font(.trail(14, .regular, relativeTo: .subheadline))
                        .foregroundStyle(AppTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
