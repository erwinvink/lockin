import SwiftUI

// MARK: - Brand

/// Onboarding brand block. The wordmark is template-rendered so it sits on
/// the dark canvas in warm off-white.
struct BrandHeader: View {
    var subtitle: String?

    var body: some View {
        VStack(alignment: .center, spacing: 12) {
            Image("LockinWordmark")
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: 188, height: 36)
                .foregroundStyle(AppTheme.text)
                .accessibilityLabel("lockin")
                .accessibilityIdentifier("lockin-wordmark")
            if let subtitle {
                Text(subtitle)
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(AppTheme.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
    }
}

/// Today's header: lock mark, app name, date — with a caller-provided
/// trailing element (streak chip, week ring). Replaces the old splash-style
/// wordmark banner.
struct LockinHeader<Trailing: View>: View {
    @ViewBuilder var trailing: Trailing

    init(@ViewBuilder trailing: () -> Trailing = { EmptyView() }) {
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(AppTheme.accent)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Lockin")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(AppTheme.text)
                    Text(Date.now, format: .dateTime.weekday(.wide).day().month())
                        .font(.footnote)
                        .foregroundStyle(AppTheme.muted)
                }
            }
            Spacer()
            trailing
        }
    }
}

/// Hairline capsule with a flame and the current streak count.
struct StreakChip: View {
    var streak: Int

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "flame.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(AppTheme.accent)
            Text("\(streak)")
                .font(.system(size: 14, weight: .semibold).monospacedDigit())
                .foregroundStyle(AppTheme.text)
                .contentTransition(.numericText())
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 6)
        .background(Capsule().fill(AppTheme.surface))
        .overlay(Capsule().strokeBorder(AppTheme.divider, lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Streak \(streak) sessions")
    }
}

// MARK: - Metric strip

/// Open metric strip: hairlines top and bottom, columns separated by short
/// vertical rules. The replacement for the old white metric-card grids.
struct MetricStrip: View {
    var cells: [MetricCellModel]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(cells.enumerated()), id: \.offset) { index, cell in
                MetricCell(model: cell)
                    .padding(.leading, index == 0 ? 0 : 14)
                if index < cells.count - 1 {
                    Rectangle()
                        .fill(AppTheme.divider)
                        .frame(width: 1, height: 34)
                }
            }
        }
        .ruled()
    }
}

struct MetricCellModel {
    var label: String
    var value: String
    var detail: String?
    var valueColor: Color = AppTheme.text
}

struct MetricCell: View {
    var model: MetricCellModel

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            MicroLabel(text: model.label)
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(model.value)
                    .font(.lockinNumeral(22))
                    .foregroundStyle(model.valueColor)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .contentTransition(.numericText())
                if let detail = model.detail {
                    Text(detail)
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(AppTheme.faint)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Progress

/// Slim goal-progress row: label, value over goal, 4pt gold bar. Replaces
/// the stacked ring cards.
struct GoalProgressRow: View {
    var title: String
    var current: Int
    var goal: Int
    var seconds: Bool = false
    var benchmark: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drawn = false

    private var progress: Double {
        min(1, max(0, Double(current) / Double(max(goal, 1))))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                MicroLabel(text: title.uppercased(), color: AppTheme.text)
                Spacer()
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(seconds ? format(seconds: current) : "\(current)")
                        .font(.lockinNumeral(17))
                        .foregroundStyle(AppTheme.text)
                        .contentTransition(.numericText())
                    Text("/ \(seconds ? format(seconds: goal) : "\(goal)")")
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(AppTheme.muted)
                }
            }

            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(AppTheme.divider)
                    Capsule()
                        .fill(AppTheme.accent)
                        .frame(width: max(4, proxy.size.width * (drawn ? progress : 0)))
                }
            }
            .frame(height: 4)

            if let benchmark {
                Text(benchmark)
                    .font(.system(size: 11))
                    .foregroundStyle(AppTheme.faint)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityValue("\(Int(progress * 100)) percent of goal")
        .onAppear {
            if reduceMotion {
                drawn = true
            } else {
                withAnimation(.smooth(duration: 0.7).delay(0.1)) { drawn = true }
            }
        }
    }
}

/// Compact gold ring for week completion — draws in on appear.
struct WeekRing: View {
    var progress: Double
    var label: String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drawn = false

    var body: some View {
        ZStack {
            Circle()
                .stroke(AppTheme.divider, lineWidth: 4)
            Circle()
                .trim(from: 0, to: drawn ? max(0.001, progress) : 0.001)
                .stroke(AppTheme.accent, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text(label)
                .font(.lockinNumeral(13))
                .foregroundStyle(AppTheme.text)
                .contentTransition(.numericText())
        }
        .frame(width: 54, height: 54)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Week \(Int(progress * 100)) percent complete")
        .onAppear {
            if reduceMotion {
                drawn = true
            } else {
                withAnimation(.smooth(duration: 0.8).delay(0.15)) { drawn = true }
            }
        }
    }
}

// MARK: - Chips and metadata

/// Quiet status chip: hairline capsule, no fill, color carried by the text
/// and icon. The single chip shape in the app.
struct StatusPill: View {
    var text: String
    var color: Color = AppTheme.accent
    var systemImage: String? = "checkmark.circle.fill"

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 10, weight: .semibold))
            }
            Text(text)
                .font(.system(size: 11, weight: .semibold))
                .lineLimit(1)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .overlay(Capsule().strokeBorder(AppTheme.divider, lineWidth: 1))
    }
}

/// Bare metadata label: icon + text, no container. Effort keeps the only
/// three-hue mapping in the design.
struct EffortPill: View {
    var label: PlannedEffortLabel
    var prefix: String?
    var targetRPE: Int?

    init(label: PlannedEffortLabel, prefix: String? = nil, targetRPE: Int? = nil) {
        self.label = label
        self.prefix = prefix
        self.targetRPE = targetRPE
    }

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "bolt.fill")
                .font(.system(size: 10, weight: .semibold))
            Text(displayText)
                .font(.system(size: 12, weight: .medium).monospacedDigit())
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .foregroundStyle(AppTheme.effortColor(label))
        .accessibilityLabel(displayText)
    }

    private var displayText: String {
        let base = prefix.map { "\($0): \(label.title)" } ?? label.title
        guard let targetRPE, targetRPE > 0 else { return base }
        return "\(base) · RPE \(targetRPE)"
    }
}

struct DurationPill: View {
    var minutes: Int

    var body: some View {
        if minutes > 0 {
            HStack(spacing: 4) {
                Image(systemName: "clock")
                    .font(.system(size: 10, weight: .semibold))
                Text(displayText)
                    .font(.system(size: 12, weight: .medium).monospacedDigit())
                    .lineLimit(1)
            }
            .foregroundStyle(AppTheme.muted)
            .accessibilityLabel("Estimated duration \(displayText)")
        }
    }

    private var displayText: String {
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        let remainingMinutes = minutes % 60
        return remainingMinutes == 0 ? "\(hours) hr" : "\(hours) hr \(remainingMinutes) min"
    }
}

/// Planned vs actual RPE as quiet text: "RPE 6 → 8", the actual colored.
struct RPEComparisonPill: View {
    var plannedRPE: Int?
    var actualRPE: Int

    private var normalizedPlannedRPE: Int? {
        guard let plannedRPE, (1...10).contains(plannedRPE) else { return nil }
        return plannedRPE
    }

    private var normalizedActualRPE: Int {
        min(10, max(1, actualRPE))
    }

    private var actualColor: Color {
        AppTheme.effortColor(PlannedEffortLabel.fromRPE(normalizedActualRPE))
    }

    var body: some View {
        HStack(spacing: 4) {
            Text("RPE")
                .foregroundStyle(AppTheme.faint)
            if let normalizedPlannedRPE {
                Text("\(normalizedPlannedRPE)")
                    .foregroundStyle(AppTheme.muted)
                Image(systemName: "arrow.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(AppTheme.faint)
            }
            Text("\(normalizedActualRPE)")
                .foregroundStyle(actualColor)
        }
        .font(.system(size: 12, weight: .medium).monospacedDigit())
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        if let normalizedPlannedRPE {
            return "RPE planned \(normalizedPlannedRPE), actual \(normalizedActualRPE)"
        }
        return "RPE actual \(normalizedActualRPE)"
    }
}

// MARK: - Session rows

struct WeekPlanTable: View {
    var sessions: [WorkoutSession]
    var prescriptions: [SetPrescription] = []
    var onSelectSession: (WorkoutSession) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            MicroLabel(text: "Open activities".uppercased())

            if sessions.isEmpty {
                Text("No open activities.")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 6)
            } else {
                VStack(spacing: 0) {
                    Hairline()
                    ForEach(Array(sessions.prefix(7).enumerated()), id: \.element.id) { index, session in
                        WeekPlanRow(
                            session: session,
                            durationMinutes: estimatedWorkoutDurationMinutes(
                                for: session,
                                prescriptions: prescriptionsForSession(session)
                            )
                        ) {
                            onSelectSession(session)
                        }
                        if index < min(sessions.count, 7) - 1 {
                            Hairline()
                        }
                    }
                    Hairline()
                }
            }
        }
    }

    private func prescriptionsForSession(_ session: WorkoutSession) -> [SetPrescription] {
        prescriptions
            .filter { $0.sessionId == session.id }
            .sorted { $0.orderIndex < $1.orderIndex }
    }
}

struct WeekPlanRow: View {
    var session: WorkoutSession
    var durationMinutes: Int = 0
    var onSelect: () -> Void = {}

    private var showsRunDistance: Bool {
        session.isRun && session.plannedDistanceKm > 0
    }

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 12) {
                Text(session.scheduledDate, format: .dateTime.weekday(.abbreviated))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(AppTheme.muted)
                    .frame(width: 34, alignment: .leading)
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(AppTheme.text)
                        .lineLimit(1)
                    if durationMinutes > 0 || session.plannedEffortLabel != nil || showsRunDistance {
                        HStack(spacing: 10) {
                            if showsRunDistance {
                                Text(runDistanceText(km: session.plannedDistanceKm))
                                    .font(.system(size: 12, weight: .medium).monospacedDigit())
                                    .foregroundStyle(AppTheme.muted)
                            }
                            DurationPill(minutes: durationMinutes)
                            if let effortLabel = session.plannedEffortLabel {
                                EffortPill(
                                    label: effortLabel,
                                    targetRPE: session.plannedEffortTargetRPE > 0 ? session.plannedEffortTargetRPE : nil
                                )
                            }
                        }
                    }
                }
                Spacer(minLength: 8)
                WorkoutStatusIcon(status: session.status)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(AppTheme.faint)
            }
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Open workout details")
        .accessibilityIdentifier("week-plan-row-\(session.title)")
    }
}

struct WorkoutStatusIcon: View {
    var status: SessionStatus

    private var iconName: String {
        switch status {
        case .planned: "circle"
        case .completed, .deload: "checkmark.circle.fill"
        case .missed: "xmark.circle.fill"
        }
    }

    private var accessibilityLabel: String {
        switch status {
        case .planned: "Open"
        case .completed: "Done"
        case .missed: "Missed"
        case .deload: "Deloaded"
        }
    }

    var body: some View {
        Image(systemName: iconName)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(status == .planned ? AppTheme.faint : AppTheme.statusColor(status))
            .accessibilityLabel(accessibilityLabel)
    }
}

struct WorkoutStatusPill: View {
    var status: SessionStatus

    var body: some View {
        StatusPill(text: title, color: AppTheme.statusColor(status), systemImage: iconName)
    }

    private var title: String {
        switch status {
        case .planned: "OPEN"
        case .completed: "DONE"
        case .missed: "MISSED"
        case .deload: "DELOAD"
        }
    }

    private var iconName: String {
        switch status {
        case .planned: "circle"
        case .completed, .deload: "checkmark.circle.fill"
        case .missed: "xmark.circle.fill"
        }
    }
}

/// Animated check circle for prescription rows: gold fill on completion with
/// a symbol bounce and light haptic.
struct CheckCircle: View {
    var isComplete: Bool
    var accessibilityName: String
    var onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            Image(systemName: isComplete ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(isComplete ? AppTheme.accent : AppTheme.faint)
                .symbolEffect(.bounce, options: .speed(1.4), value: isComplete)
                .frame(width: 34, height: 34)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.impact(weight: .light), trigger: isComplete) { _, newValue in newValue }
        .accessibilityLabel(isComplete ? "\(accessibilityName) done" : "Mark \(accessibilityName) done")
        .accessibilityIdentifier(isComplete ? "exercise-checkbox-checked" : "exercise-checkbox-unchecked")
    }
}

// MARK: - Rows and fields

struct InfoLine: View {
    var title: String
    var value: String
    var valueColor: Color = AppTheme.text

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title)
                .font(.footnote)
                .foregroundStyle(AppTheme.muted)
            Spacer()
            Text(value)
                .font(.footnote.weight(.semibold).monospacedDigit())
                .foregroundStyle(valueColor)
                .multilineTextAlignment(.trailing)
        }
    }
}

struct IntegerField: View {
    var title: String
    @Binding var value: Int
    var range: ClosedRange<Int>
    var suffix: String = ""

    @FocusState private var isFocused: Bool

    private var clampedValue: Binding<Int> {
        Binding(
            get: { value },
            set: { newValue in
                value = min(range.upperBound, max(range.lowerBound, newValue))
            }
        )
    }

    var body: some View {
        HStack(spacing: 12) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(AppTheme.text)
                .lineLimit(2)
            Spacer()
            TextField(title, value: clampedValue, format: .number)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .font(.system(size: 16, weight: .semibold).monospacedDigit())
                .foregroundStyle(AppTheme.text)
                .focused($isFocused)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(width: 92)
                .background(AppTheme.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                        .strokeBorder(isFocused ? AppTheme.accent : AppTheme.divider, lineWidth: 1)
                )
                .animation(.easeOut(duration: 0.15), value: isFocused)
            if !suffix.isEmpty {
                Text(suffix)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.muted)
            }
        }
    }
}

// MARK: - Empty states

/// Quiet empty state: small gold glyph, plain words, no card frame.
struct EmptyStateView: View {
    var systemImage: String
    var title: String
    var message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(AppTheme.accent)
            Text(title)
                .font(.lockinSection)
                .foregroundStyle(AppTheme.text)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(AppTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .ruled(verticalPadding: 20)
    }
}
