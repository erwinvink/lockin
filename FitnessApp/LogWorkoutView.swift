import SwiftData
import SwiftUI

struct LogWorkoutView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Query private var ranks: [RankState]
    @Query(sort: \SetPrescription.orderIndex) private var prescriptions: [SetPrescription]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var previousLogs: [PerformanceLog]

    var session: WorkoutSession
    var profile: UserProfile

    @State private var pullUps = 0
    @State private var pushUps = 0
    @State private var plankSeconds = 0
    @State private var rpe = 7
    @State private var painLevel = 0
    @State private var fatigueLevel = 5
    @State private var notes = ""

    private var sessionPrescriptions: [SetPrescription] {
        prescriptions
            .filter { $0.sessionId == session.id }
            .sorted { $0.orderIndex < $1.orderIndex }
    }

    private var sessionExercises: [ExerciseKind] {
        var seen: Set<ExerciseKind> = []
        return sessionPrescriptions.compactMap { prescription in
            guard !seen.contains(prescription.exercise) else { return nil }
            seen.insert(prescription.exercise)
            return prescription.exercise
        }
    }

    private var shouldLogPullUps: Bool {
        sessionExercises.contains(.pullUp)
    }

    private var shouldLogPushUps: Bool {
        sessionExercises.contains(.pushUp)
    }

    private var shouldLogPlank: Bool {
        sessionExercises.contains(.plank)
    }

    private var latestPullUps: Int {
        previousLogs.first(where: { $0.loggedPullUps })?.pullUps ?? profile.baselinePullUps
    }

    private var latestPushUps: Int {
        previousLogs.first(where: { $0.loggedPushUps })?.pushUps ?? profile.baselinePushUps
    }

    private var latestPlankSeconds: Int {
        previousLogs.first(where: { $0.loggedPlankSeconds })?.plankSeconds ?? profile.baselinePlankSeconds
    }

    var body: some View {
        NavigationStack {
            ScreenBackground {
                VStack(alignment: .leading, spacing: 5) {
                    Text(session.title)
                        .font(.system(.title2, design: .rounded, weight: .bold))
                    Text("Record the best strict set or hold from this session, not total reps across all sets.")
                        .font(.caption)
                        .foregroundStyle(AppTheme.muted)
                }
                .card()

                LogSessionOverviewCard(session: session, exercises: sessionExercises)

                LoggedWorkCard(
                    shouldLogPullUps: shouldLogPullUps,
                    shouldLogPushUps: shouldLogPushUps,
                    shouldLogPlank: shouldLogPlank,
                    pullUps: $pullUps,
                    pushUps: $pushUps,
                    plankSeconds: $plankSeconds
                )

                ReadinessInputCard(
                    rpe: $rpe,
                    painLevel: $painLevel,
                    fatigueLevel: $fatigueLevel
                )

                NotesCard(notes: $notes)

                Button("Save log", action: save)
                    .buttonStyle(PrimaryActionButtonStyle())
            }
            .navigationTitle("Log")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .onAppear(perform: seedLatestValues)
    }

    private func seedLatestValues() {
        pullUps = latestPullUps
        pushUps = latestPushUps
        plankSeconds = latestPlankSeconds
    }

    private func save() {
        let savedPullUps = shouldLogPullUps ? pullUps : latestPullUps
        let savedPushUps = shouldLogPushUps ? pushUps : latestPushUps
        let savedPlankSeconds = shouldLogPlank ? plankSeconds : latestPlankSeconds
        let log = PerformanceLog(
            sessionId: session.id,
            pullUps: savedPullUps,
            pushUps: savedPushUps,
            plankSeconds: savedPlankSeconds,
            loggedPullUps: shouldLogPullUps,
            loggedPushUps: shouldLogPushUps,
            loggedPlankSeconds: shouldLogPlank,
            rpe: rpe,
            painLevel: painLevel,
            fatigueLevel: fatigueLevel,
            notes: notes
        )
        modelContext.insert(log)
        session.status = painLevel >= 4 || fatigueLevel >= 9 ? .deload : .completed

        let outcome = TrainingEngine().score(
            log: SessionLogInput(
                completed: true,
                pullUps: savedPullUps,
                pushUps: savedPushUps,
                plankSeconds: savedPlankSeconds,
                loggedPullUps: shouldLogPullUps,
                loggedPushUps: shouldLogPushUps,
                loggedPlankSeconds: shouldLogPlank,
                rpe: rpe,
                painLevel: painLevel,
                fatigueLevel: fatigueLevel
            ),
            plannedSession: nil
        )
        let rank = ranks.first ?? RankState()
        if ranks.isEmpty { modelContext.insert(rank) }
        applyScoreOutcome(outcome, to: rank)

        if outcome.didTriggerDeload {
            let coachPlan = CoachPlan(weekStart: Date(), summary: outcome.reason, source: .rules, validationStatus: .clamped)
            modelContext.insert(coachPlan)
            modelContext.insert(CoachDecision(planId: coachPlan.id, rationale: outcome.reason, safetyFlags: ["auto-deload"]))
        }

        try? modelContext.save()
        dismiss()
    }
}

private struct LogSessionOverviewCard: View {
    var session: WorkoutSession
    var exercises: [ExerciseKind]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Session type", systemImage: "figure.strengthtraining.traditional")
                .font(.headline)
            InfoLine(title: "Focus", value: session.focus.title)
            InfoLine(title: "Exercises", value: exerciseText)
            InfoLine(title: "Score rule", value: "+\(TrainingEngine.missedSessionPenaltyPoints) penalties only if marked missed")
        }
        .card()
    }

    private var exerciseText: String {
        let names = exercises.map(\.title)
        return names.isEmpty ? "Readiness only" : names.joined(separator: ", ")
    }
}

private struct LoggedWorkCard: View {
    var shouldLogPullUps: Bool
    var shouldLogPushUps: Bool
    var shouldLogPlank: Bool
    @Binding var pullUps: Int
    @Binding var pushUps: Int
    @Binding var plankSeconds: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Logged work")
                .font(.headline)
            Text("Use the best clean uninterrupted set for reps, and the longest clean hold for plank.")
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
            if shouldLogPullUps {
                IntegerField(title: "Best pull-up set", value: $pullUps, range: 0...300)
            }
            if shouldLogPushUps {
                IntegerField(title: "Best push-up set", value: $pushUps, range: 0...500)
            }
            if shouldLogPlank {
                IntegerField(title: "Longest plank hold", value: $plankSeconds, range: 0...3_600, suffix: "sec")
            }
            if !shouldLogPullUps && !shouldLogPushUps && !shouldLogPlank {
                Text("No goal max test is planned in this session. Log readiness and notes only.")
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            }
        }
        .card()
    }
}

private struct ReadinessInputCard: View {
    @Binding var rpe: Int
    @Binding var painLevel: Int
    @Binding var fatigueLevel: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Readiness")
                .font(.headline)
            IntegerField(title: "RPE", value: $rpe, range: 1...10)
            IntegerField(title: "Pain", value: $painLevel, range: 0...10)
            IntegerField(title: "Fatigue", value: $fatigueLevel, range: 1...10)
        }
        .card()
    }
}

private struct NotesCard: View {
    @Binding var notes: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Notes")
                .font(.headline)
            TextField("What changed?", text: $notes, axis: .vertical)
                .textFieldStyle(.roundedBorder)
        }
        .card()
    }
}
