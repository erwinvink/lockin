import SwiftData
import SwiftUI

struct TodayView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.openTab) private var openTab
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \WorkoutBlock.orderIndex) private var blocks: [WorkoutBlock]
    @Query(sort: \SetPrescription.orderIndex) private var prescriptions: [SetPrescription]
    @Query(sort: \RunLog.completedAt, order: .reverse) private var runLogs: [RunLog]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var performanceLogs: [PerformanceLog]
    @Query(sort: \GarminDailySnapshot.date, order: .reverse) private var snapshots: [GarminDailySnapshot]
    @Query(sort: \RaceGoal.createdAt) private var raceGoals: [RaceGoal]
    @Query private var ranks: [RankState]

    var profile: UserProfile
    @State private var loggingSession: WorkoutSession?
    @State private var loggingRun: WorkoutSession?
    @State private var pendingLoggingSessionID: UUID?
    @State private var previewSession: WorkoutSession?
    @State private var workoutCardResetID = UUID()

    /// Today's planned sessions plus yesterday's unlogged ones, so a late
    /// evening session can still be logged the next morning.
    private var dueSessions: [WorkoutSession] {
        duePlannedSessions(from: sessions) + lateLoggableSessions(from: sessions, logs: performanceLogs, runLogs: runLogs)
    }

    private func isFromYesterday(_ session: WorkoutSession) -> Bool {
        Calendar.current.isDateInYesterday(session.scheduledDate)
    }

    private var futureSession: WorkoutSession? {
        nextFuturePlannedSession(from: sessions)
    }

    private var rank: RankState {
        ranks.first ?? RankState()
    }

    private var streakSnapshot: TrainingStreakSnapshot {
        let computed = trainingStreakSnapshot(from: sessions)
        if computed.best > 0 { return computed }
        return TrainingStreakSnapshot(current: rank.streak, best: rank.displayedBestStreak)
    }

    /// Morning readiness only counts when the snapshot is from today or
    /// yesterday — stale wellness shown as "readiness" would mislead.
    private var todaysSnapshot: GarminDailySnapshot? {
        guard let snapshot = snapshots.first else { return nil }
        let calendar = Calendar.current
        let age = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: snapshot.date),
            to: calendar.startOfDay(for: Date())
        ).day ?? .max
        return age <= 1 ? snapshot : nil
    }

    /// A session scheduled today that is already logged (or deloaded), so a
    /// quiet Today reads "done", not "rest".
    private var finishedToday: Bool {
        sessions.contains {
            Calendar.current.isDateInToday($0.scheduledDate) && [.completed, .partial, .deload].contains($0.status)
        }
    }

    /// The race goal, while race day is still ahead.
    private var upcomingRace: RaceGoal? {
        guard let race = raceGoals.first else { return nil }
        let calendar = Calendar.current
        return calendar.startOfDay(for: race.raceDate) >= calendar.startOfDay(for: Date()) ? race : nil
    }

    // MARK: Week context (display only)

    private var weekInterval: DateInterval? {
        Calendar.current.dateInterval(of: .weekOfYear, for: Date())
    }

    private var thisWeekSessions: [WorkoutSession] {
        guard let weekInterval else { return [] }
        return sessions
            .filter { weekInterval.start <= $0.scheduledDate && $0.scheduledDate < weekInterval.end }
            .sorted { $0.scheduledDate < $1.scheduledDate }
    }

    private var thisWeekKm: Double {
        guard let weekInterval else { return 0 }
        return confirmedRunLogs(from: runLogs)
            .filter { weekInterval.start <= $0.completedAt && $0.completedAt < weekInterval.end }
            .reduce(0) { $0 + $1.distanceKm }
    }

    var body: some View {
        NavigationStack {
            ScreenBackground {
                TodayHeader(readiness: todaysSnapshot?.trainingReadiness ?? 0)
                    .entrance(0)

                signs
                    .entrance(1)

                if let snapshot = todaysSnapshot, let note = conditionsNote(snapshot) {
                    ConditionsNote(lead: "Last night.", detail: note)
                        .padding(.top, -14)
                        .entrance(2)
                }

                dayContent
                    .entrance(3)

                if !thisWeekSessions.isEmpty {
                    WeekTrail(
                        sessions: thisWeekSessions,
                        weekStart: weekInterval?.start ?? Date(),
                        streak: streakSnapshot,
                        weekKm: thisWeekKm,
                        onSelect: { previewSession = $0 }
                    )
                    .entrance(4)
                }
            }
            .sheet(item: $loggingSession, onDismiss: resetCheckedWorkoutIfLogWasCancelled) { session in
                LogWorkoutView(session: session, profile: profile)
            }
            .sheet(item: $loggingRun) { session in
                LogRunView(mode: .log(session), profile: profile)
            }
            .sheet(item: $previewSession) { session in
                FutureWorkoutPreviewSheet(
                    session: session,
                    blocks: blocksForSession(session),
                    prescriptions: prescriptionsForSession(session)
                )
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
            }
        }
    }

    // MARK: Signs

    @ViewBuilder
    private var signs: some View {
        SignpostStack {
            if let primary = dueSessions.first {
                Signpost(
                    eyebrow: dueEyebrow(primary),
                    title: primary.title,
                    trailing: signDurationText(minutes: durationMinutes(primary)),
                    grade: primary.plannedEffortLabel.map(TrailGrade.init)
                )
                secondarySign(after: primary)
            } else if sessions.isEmpty {
                Signpost(eyebrow: "Start here", title: "Plan your week", trailing: "")
            } else if let next = futureSession {
                Signpost(
                    eyebrow: "Today",
                    title: finishedToday ? "Done for today" : "Rest day",
                    trailing: "",
                    style: .plain
                )
                nextSessionSign(next)
            } else {
                Signpost(eyebrow: "This week", title: "Week done", trailing: weekDoneCountText)
                if let race = upcomingRace {
                    raceSign(race)
                }
            }
        }
    }

    @ViewBuilder
    private func secondarySign(after primary: WorkoutSession) -> some View {
        if let race = upcomingRace {
            raceSign(race)
        } else if let next = futureSession, next.id != primary.id {
            nextSessionSign(next)
        }
    }

    private func raceSign(_ race: RaceGoal) -> some View {
        Signpost(
            eyebrow: "Race day, \(race.raceDate.formatted(.dateTime.day().month(.abbreviated)))",
            title: race.name.isEmpty ? "Race" : race.name,
            trailing: raceCountdownText(race.raceDate),
            grade: .mountain,
            size: .small
        )
        .padding(.trailing, 40)
    }

    private func nextSessionSign(_ session: WorkoutSession) -> some View {
        Signpost(
            eyebrow: relativeDayText(session.scheduledDate),
            title: session.title,
            trailing: signDurationText(minutes: durationMinutes(session)),
            grade: session.plannedEffortLabel.map(TrailGrade.init),
            size: .small
        )
        .padding(.trailing, 40)
    }

    // MARK: Day content

    @ViewBuilder
    private var dayContent: some View {
        if !dueSessions.isEmpty {
            VStack(alignment: .leading, spacing: 32) {
                ForEach(Array(dueSessions.enumerated()), id: \.element.id) { index, session in
                    VStack(alignment: .leading, spacing: 16) {
                        // A second session on the same day gets its own sign.
                        if index > 0 {
                            SignpostStack {
                                Signpost(
                                    eyebrow: isFromYesterday(session) ? "Yesterday, not logged yet" : "Also today",
                                    title: session.title,
                                    trailing: signDurationText(minutes: durationMinutes(session)),
                                    grade: session.plannedEffortLabel.map(TrailGrade.init),
                                    size: .small
                                )
                            }
                        }
                        if session.isRun {
                            RunRouteSection(session: session, onLog: { loggingRun = session })
                        } else {
                            StrengthRouteSection(
                                session: session,
                                prescriptions: prescriptionsForSession(session),
                                blocks: blocksForSession(session),
                                onComplete: { beginLogging(session) }
                            )
                            .id("\(session.id.uuidString)-\(workoutCardResetID.uuidString)")
                        }
                    }
                }
            }
        } else if sessions.isEmpty {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("No plan yet")
                        .font(.lockinSection)
                    Text("Your coach builds the week from your numbers, your training days and your race goal. It only plans days that are still ahead.")
                        .font(.lockinBody)
                        .foregroundStyle(AppTheme.bodyText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Button("Open Coach") { openTab(.coach) }
                    .buttonStyle(PrimaryActionButtonStyle())
            }
        } else if futureSession != nil {
            Text(finishedToday
                ? "Today's session is logged. The coach updates its read from it."
                : "Nothing to log today. Sessions open in Log on their day.")
                .font(.lockinBody)
                .foregroundStyle(AppTheme.bodyText)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Every session is logged")
                        .font(.lockinSection)
                    Text("Progress has your new numbers, and the coach can plan next week.")
                        .font(.lockinBody)
                        .foregroundStyle(AppTheme.bodyText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 10) {
                    Button("Plan next week") { openTab(.coach) }
                        .buttonStyle(PrimaryActionButtonStyle())
                    Button("See progress") { openTab(.progress) }
                        .buttonStyle(SecondaryActionButtonStyle())
                }
            }
        }
    }

    // MARK: Text helpers

    private func durationMinutes(_ session: WorkoutSession) -> Int {
        session.isRun
            ? session.estimatedDurationMinutes
            : estimatedWorkoutDurationMinutes(for: session, prescriptions: prescriptionsForSession(session))
    }

    private func dueEyebrow(_ session: WorkoutSession) -> String {
        let day = isFromYesterday(session) ? "Yesterday" : "Today"
        if session.isRun {
            return session.plannedDistanceKm > 0 ? "\(day), \(runDistanceText(km: session.plannedDistanceKm))" : day
        }
        let count = prescriptionsForSession(session).count
        switch count {
        case 0: return day
        case 1: return "\(day), 1 movement"
        default: return "\(day), \(count) movements"
        }
    }

    private func relativeDayText(_ date: Date) -> String {
        if Calendar.current.isDateInTomorrow(date) { return "Tomorrow" }
        return date.formatted(.dateTime.weekday(.wide))
    }

    private var weekDoneCountText: String {
        let week = thisWeekSessions
        guard !week.isEmpty else { return "" }
        let done = week.filter { [.completed, .partial, .deload].contains($0.status) }.count
        return "\(done) of \(week.count)"
    }

    /// "Sleep 82, HRV balanced, body battery 61." The Garmin sidecar
    /// zero-fills missing metrics, so zero means "no data".
    private func conditionsNote(_ snapshot: GarminDailySnapshot) -> String? {
        var parts: [String] = []
        if snapshot.sleepScore > 0 { parts.append("sleep \(snapshot.sleepScore)") }
        let hrv = snapshot.hrvStatus
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "_", with: " ")
            .lowercased()
        if !hrv.isEmpty { parts.append("HRV \(hrv)") }
        if snapshot.bodyBattery > 0 { parts.append("body battery \(snapshot.bodyBattery)") }
        guard let first = parts.first else { return nil }
        parts[0] = first.prefix(1).uppercased() + first.dropFirst()
        return parts.joined(separator: ", ") + "."
    }

    private func blocksForSession(_ session: WorkoutSession) -> [WorkoutBlock] {
        blocks
            .filter { $0.sessionId == session.id }
            .sorted { $0.orderIndex < $1.orderIndex }
    }

    private func prescriptionsForSession(_ session: WorkoutSession) -> [SetPrescription] {
        prescriptions
            .filter { $0.sessionId == session.id }
            .sorted { $0.orderIndex < $1.orderIndex }
    }

    private func beginLogging(_ session: WorkoutSession) {
        guard session.status == .planned || session.status == .missed else { return }
        pendingLoggingSessionID = session.id
        loggingSession = session
    }

    private func resetCheckedWorkoutIfLogWasCancelled() {
        guard let pendingLoggingSessionID else { return }
        let session = sessions.first { $0.id == pendingLoggingSessionID }
        if session?.status == .planned || session?.status == .missed {
            workoutCardResetID = UUID()
        }
        self.pendingLoggingSessionID = nil
    }
}

// MARK: - Entrance choreography

/// One-shot staggered fade-up for Today's sections. Skipped entirely under
/// Reduce Motion.
private struct EntranceModifier: ViewModifier {
    let index: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : 10)
            .onAppear {
                guard !shown else { return }
                if reduceMotion {
                    shown = true
                } else {
                    withAnimation(.smooth(duration: 0.45).delay(Double(index) * 0.05)) {
                        shown = true
                    }
                }
            }
    }
}

private extension View {
    func entrance(_ index: Int) -> some View {
        modifier(EntranceModifier(index: index))
    }
}

// MARK: - Header and conditions

private struct TodayHeader: View {
    var readiness: Int

    var body: some View {
        HStack(alignment: .center) {
            Text(Date.now, format: .dateTime.weekday(.wide).day().month(.wide))
                .font(.trail(15, .medium, relativeTo: .subheadline))
                .foregroundStyle(AppTheme.muted)
            Spacer()
            if readiness > 0 {
                Label {
                    Text("Readiness \(readiness)")
                        .font(.trail(15, .semibold, relativeTo: .subheadline).monospacedDigit())
                } icon: {
                    Image(systemName: "mountain.2")
                        .font(.system(size: 13, weight: .semibold))
                }
                .foregroundStyle(AppTheme.text)
                .accessibilityLabel("Garmin readiness \(readiness)")
            }
        }
    }
}

private struct ConditionsNote: View {
    var lead: String
    var detail: String

    var body: some View {
        (Text(lead).font(.trail(15, .semibold, relativeTo: .subheadline))
            + Text(" " + detail).font(.trail(15, .regular, relativeTo: .subheadline)))
            .foregroundStyle(AppTheme.text)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card(padding: 14)
    }
}

// MARK: - Strength route

private struct StrengthRouteSection: View {
    var session: WorkoutSession
    var prescriptions: [SetPrescription]
    var blocks: [WorkoutBlock]
    var onComplete: () -> Void
    @State private var completedPrescriptionIds: Set<UUID> = []
    @State private var infoItem: SetPrescription?

    private var allComplete: Bool {
        !prescriptions.isEmpty && completedPrescriptionIds.count == prescriptions.count
    }

    private var nextItem: SetPrescription? {
        prescriptions.first { !completedPrescriptionIds.contains($0.id) }
    }

    private var ctaTitle: String {
        guard let nextItem else { return "Log session" }
        let name = nextItem.exercise.title.lowercased()
        return completedPrescriptionIds.isEmpty ? "Start with \(name)" : "Continue with \(name)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader("Route") {
                if !prescriptions.isEmpty {
                    Text("\(completedPrescriptionIds.count) of \(prescriptions.count) done")
                        .font(.trail(14, .semibold, relativeTo: .subheadline).monospacedDigit())
                        .foregroundStyle(AppTheme.muted)
                        .contentTransition(.numericText())
                }
            }

            if prescriptions.isEmpty {
                Text("No exercise details yet.")
                    .font(.lockinBody)
                    .foregroundStyle(AppTheme.muted)
            } else {
                VStack(spacing: 0) {
                    ForEach(prescriptions) { item in
                        RouteRow(
                            item: item,
                            isComplete: completedPrescriptionIds.contains(item.id),
                            onToggle: { toggle(item) },
                            onInfo: { infoItem = item }
                        )
                    }
                }
                .trailBehind(leading: 22, inset: 29)

                Button(ctaTitle) {
                    if allComplete {
                        onComplete()
                    } else if let nextItem {
                        infoItem = nextItem
                    }
                }
                .buttonStyle(PrimaryActionButtonStyle())
                // Logging stays an explicit decision: the button only turns
                // into "Log session" once every row is checked.
                .accessibilityIdentifier(allComplete ? "finish-and-log-button" : "continue-workout-button")
            }
        }
        .animation(.smooth(duration: 0.3), value: allComplete)
        .sheet(item: $infoItem) { item in
            WorkoutInfoContent(
                prescription: item,
                block: blocks.first { $0.id == item.blockId },
                onDone: { completedPrescriptionIds.insert(item.id) }
            )
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
            .presentationBackground(AppTheme.background)
        }
    }

    private func toggle(_ item: SetPrescription) {
        if completedPrescriptionIds.contains(item.id) {
            completedPrescriptionIds.remove(item.id)
        } else {
            completedPrescriptionIds.insert(item.id)
        }
    }
}

/// One exercise as a waypoint on the day's route: tap the waypoint (or the
/// row) to check it off, the info button opens the timer and explanation.
private struct RouteRow: View {
    var item: SetPrescription
    var isComplete: Bool
    var onToggle: () -> Void
    var onInfo: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Button(action: onToggle) {
                WaypointMarker(state: isComplete ? .done : .planned, size: 30)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .sensoryFeedback(.impact(weight: .light), trigger: isComplete) { _, newValue in newValue }
            .accessibilityLabel(isComplete ? "\(item.exercise.title) done" : "Mark \(item.exercise.title) done")
            .accessibilityIdentifier(isComplete ? "exercise-checkbox-checked" : "exercise-checkbox-unchecked")

            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.exercise.title)
                        .font(.lockinRowTitle)
                        .foregroundStyle(isComplete ? AppTheme.muted : AppTheme.text)
                        .lineLimit(1)
                    if let effortLabel = item.plannedEffortLabel {
                        EffortPill(
                            label: effortLabel,
                            targetRPE: item.plannedEffortTargetRPE > 0 ? item.plannedEffortTargetRPE : nil
                        )
                    }
                }
                Spacer(minLength: 8)
                Text(prescriptionText(item))
                    .font(.trail(19, .bold, relativeTo: .headline).monospacedDigit())
                    .foregroundStyle(isComplete ? AppTheme.muted : AppTheme.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: onToggle)

            Button(action: onInfo) {
                Image(systemName: "info.circle")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(AppTheme.muted)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(item.exercise.title) details")
        }
        .frame(minHeight: 58)
        .animation(.easeOut(duration: 0.2), value: isComplete)
    }
}

// MARK: - Run route

private struct RunRouteSection: View {
    var session: WorkoutSession
    var onLog: () -> Void = {}

    private var purposeText: String {
        var purpose = session.summary
        if purpose.hasPrefix("AI: ") {
            purpose = String(purpose.dropFirst(4))
        }
        return purpose.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var targetHeading: String {
        switch session.runTargetType {
        case .hr?: "Heart rate target"
        case .pace?: "Pace target"
        case nil: "Target"
        }
    }

    /// The watch-facing numbers, big; the zone goes in the caption.
    private var targetNumbers: (value: String, unit: String)? {
        let low = session.runTargetLow
        let high = session.runTargetHigh
        guard low > 0, high > 0 else { return nil }
        switch session.runTargetType {
        case .hr?:
            return (low == high ? "\(low)" : "\(low)\u{2013}\(high)", "bpm")
        case .pace?:
            return (low == high ? format(seconds: low) : "\(format(seconds: low))\u{2013}\(format(seconds: high))", "/km")
        case nil:
            return nil
        }
    }

    private var zone: String {
        session.runZone.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .center) {
                    Text(targetHeading)
                        .font(.trail(15, .semibold, relativeTo: .subheadline))
                        .foregroundStyle(AppTheme.muted)
                    Spacer(minLength: 8)
                    if let effortLabel = session.plannedEffortLabel {
                        EffortPill(
                            label: effortLabel,
                            targetRPE: session.plannedEffortTargetRPE > 0 ? session.plannedEffortTargetRPE : nil
                        )
                    }
                }
                if let targetNumbers {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(targetNumbers.value)
                            .font(.lockinNumeral(44))
                            .lineLimit(1)
                            .minimumScaleFactor(0.6)
                        Text(targetNumbers.unit)
                            .font(.trail(18, .semibold, relativeTo: .headline))
                            .foregroundStyle(AppTheme.muted)
                    }
                    .accessibilityElement(children: .combine)
                    if !zone.isEmpty {
                        Text(zone)
                            .font(.trail(15, .semibold, relativeTo: .subheadline))
                    }
                } else {
                    Text(runTargetText(session: session))
                        .font(.trail(28, .bold, relativeTo: .title1))
                }
                if !purposeText.isEmpty {
                    Text(purposeText)
                        .font(.trail(15, .regular, relativeTo: .subheadline))
                        .foregroundStyle(AppTheme.bodyText)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 2)
                }
            }
            .foregroundStyle(AppTheme.text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()

            VStack(spacing: 0) {
                RunDetailRow(title: "Distance", value: runDistanceText(km: session.plannedDistanceKm))
                if session.plannedElevationM > 0 {
                    Hairline()
                    RunDetailRow(title: "Climb", value: "\(session.plannedElevationM) m")
                }
                if session.estimatedDurationMinutes > 0 {
                    Hairline()
                    RunDetailRow(title: "Time", value: signDurationText(minutes: session.estimatedDurationMinutes))
                }
            }
            .padding(.horizontal, 16)
            .card(padding: 0)

            WatchStatusRow(session: session)

            // Garmin completes runs automatically; this is for runs without
            // the watch, or when Garmin isn't connected.
            Button("Log run by hand", action: onLog)
                .buttonStyle(SecondaryActionButtonStyle())
                .accessibilityIdentifier("log-run-button")
        }
    }
}

private struct RunDetailRow: View {
    var title: String
    var value: String

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Text(title)
                .font(.trail(16, .regular, relativeTo: .body))
                .foregroundStyle(AppTheme.muted)
            Spacer(minLength: 8)
            Text(value)
                .font(.trail(17, .semibold, relativeTo: .headline).monospacedDigit())
                .foregroundStyle(AppTheme.text)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(minHeight: 50)
    }
}

/// Where the planned run stands on the Garmin watch.
private struct WatchStatusRow: View {
    var session: WorkoutSession

    private var status: (title: String, detail: String, chip: String?, isProblem: Bool) {
        if session.pushedToGarminAt != nil || session.garminSyncStatus == .synced {
            return ("On your watch", "Garmin imports the run when you finish.", "Synced", false)
        }
        switch session.garminSyncStatus {
        case .some(.pending), .some(.retrying), .some(.blockedOnDelete):
            return ("Sending to your watch", "This usually takes a minute.", nil, false)
        case .some(.failed):
            return ("Watch sync failed", "Open Profile, then Garmin, to try again.", nil, true)
        case .some(.synced):
            return ("On your watch", "Garmin imports the run when you finish.", "Synced", false)
        case .some(.deleted), .none:
            return ("Not on your watch yet", "It goes to Garmin once the sync runs.", nil, false)
        }
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "applewatch")
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(status.isProblem ? AppTheme.markerRedText : AppTheme.text)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 1) {
                Text(status.title)
                    .font(.trail(16, .semibold, relativeTo: .headline))
                    .foregroundStyle(status.isProblem ? AppTheme.markerRedText : AppTheme.text)
                Text(status.detail)
                    .font(.lockinMeta)
                    .foregroundStyle(AppTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            if let chip = status.chip {
                Label(chip, systemImage: "checkmark")
                    .font(.trail(12, .semibold, relativeTo: .caption1))
                    .foregroundStyle(Color.white)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(AppTheme.text))
            }
        }
        .card(padding: 14)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - This week

/// The week as a short trail: one waypoint per day, today in sign yellow.
/// Tapping a day with a session opens its preview.
private struct WeekTrail: View {
    var sessions: [WorkoutSession]
    var weekStart: Date
    var streak: TrainingStreakSnapshot
    var weekKm: Double
    var onSelect: (WorkoutSession) -> Void

    private var days: [Date] {
        let calendar = Calendar.current
        return (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: weekStart) }
    }

    private var weekNote: String {
        let done = sessions.filter { [.completed, .partial, .deload].contains($0.status) }.count
        let open = sessions.filter { $0.status == .planned }.count
        if open == 0 { return "\(done) done" }
        return "\(done) done, \(open) to go"
    }

    private func sessionsOn(_ day: Date) -> [WorkoutSession] {
        sessions.filter { Calendar.current.isDate($0.scheduledDate, inSameDayAs: day) }
    }

    private func state(for day: Date) -> WaypointState {
        let daySessions = sessionsOn(day)
        guard !daySessions.isEmpty else { return .rest }
        if daySessions.contains(where: { $0.status == .missed }) { return .missed }
        if daySessions.allSatisfy({ $0.status != .planned }) { return .done }
        return Calendar.current.isDateInToday(day) ? .current : .planned
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("This week")
                    .font(.trail(17, .semibold, relativeTo: .headline))
                Spacer()
                Text(weekNote)
                    .font(.lockinMeta.monospacedDigit())
                    .foregroundStyle(AppTheme.muted)
            }

            HStack(spacing: 0) {
                ForEach(days, id: \.self) { day in
                    dayCell(day)
                        .frame(maxWidth: .infinity)
                }
            }
            .background(alignment: .top) {
                TrailLine(axis: .horizontal)
                    .stroke(AppTheme.post, style: StrokeStyle(lineWidth: 3, dash: [5, 5]))
                    .frame(height: 3)
                    .padding(.top, 36)
                    .padding(.horizontal, 22)
                    .accessibilityHidden(true)
            }

            Hairline()

            HStack {
                Text(streak.current == 1 ? "1 session in a row" : "\(streak.current) sessions in a row")
                Spacer()
                if weekKm > 0 {
                    Text("\(runDistanceText(km: weekKm)) run")
                }
            }
            .font(.lockinMeta.monospacedDigit())
            .foregroundStyle(AppTheme.muted)
        }
        .foregroundStyle(AppTheme.text)
        .card(padding: 14)
    }

    @ViewBuilder
    private func dayCell(_ day: Date) -> some View {
        let daySessions = sessionsOn(day)
        let dayState = state(for: day)
        let label = VStack(spacing: 8) {
            Text(day, format: .dateTime.weekday(.abbreviated))
                .font(.trail(12, .semibold, relativeTo: .caption1))
                .foregroundStyle(Calendar.current.isDateInToday(day) ? AppTheme.text : AppTheme.muted)
            // Session waypoints sit on a white disc that cuts the trail;
            // rest days are small dots the trail runs straight through.
            WaypointMarker(state: dayState, size: 26)
                .background {
                    if dayState != .rest {
                        Circle().fill(AppTheme.surface).padding(-3)
                    }
                }
        }
        .frame(minWidth: 44, minHeight: 56)
        .contentShape(Rectangle())

        if let first = daySessions.first {
            Button { onSelect(first) } label: { label }
                .buttonStyle(.plain)
                .accessibilityLabel(dayAccessibilityText(day, sessions: daySessions))
                .accessibilityHint("Open workout details")
        } else {
            label
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(day.formatted(.dateTime.weekday(.wide))), rest")
        }
    }

    private func dayAccessibilityText(_ day: Date, sessions: [WorkoutSession]) -> String {
        let titles = sessions.map(\.title).joined(separator: " and ")
        let status: String
        switch state(for: day) {
        case .done: status = "done"
        case .missed: status = "missed"
        case .current: status = "today"
        default: status = "planned"
        }
        return "\(day.formatted(.dateTime.weekday(.wide))), \(titles), \(status)"
    }
}
