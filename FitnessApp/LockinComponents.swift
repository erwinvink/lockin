import SwiftUI

struct BrandHeader: View {
    var subtitle: String?

    var body: some View {
        VStack(alignment: .center, spacing: 10) {
            Image("LockinWordmark")
                .resizable()
                .scaledToFit()
                .frame(width: 260, height: 50, alignment: .leading)
                .accessibilityLabel("lockin")
                .accessibilityIdentifier("lockin-wordmark")
            if let subtitle {
                Text(subtitle)
                    .font(.subheadline.weight(.medium))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(AppTheme.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
    }
}

struct GoalStrip: View {
    var profile: UserProfile

    var body: some View {
        HStack(spacing: 0) {
            GoalStripItem(value: "\(profile.goalPullUps)", label: "Pull-ups")
            Divider().frame(height: 34)
            GoalStripItem(value: "\(profile.goalPushUps)", label: "Push-ups")
            Divider().frame(height: 34)
            GoalStripItem(value: format(seconds: profile.goalPlankSeconds), label: "Plank")
        }
        .padding(.vertical, 16)
        .card(padding: 0)
    }
}

struct GoalStripItem: View {
    var value: String
    var label: String

    var body: some View {
        VStack(spacing: 3) {
            Text(value)
                .font(.system(.title2, design: .rounded, weight: .bold))
                .foregroundStyle(AppTheme.text)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(label.uppercased())
                .font(.caption2.weight(.medium))
                .foregroundStyle(AppTheme.muted)
        }
        .frame(maxWidth: .infinity)
    }
}

struct MetricCard: View {
    var title: String
    var value: String
    var subtitle: String
    var color: Color = AppTheme.accent
    var systemImage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(color)
                }
                Text(title.uppercased())
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppTheme.muted)
            }
            Text(value)
                .font(.system(.title2, design: .rounded, weight: .bold))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(subtitle)
                .font(.caption2)
                .foregroundStyle(AppTheme.muted)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 14)
    }
}

struct ProgressRing: View {
    var title: String
    var current: Int
    var goal: Int
    var seconds: Bool = false
    var benchmark: String?

    private var progress: Double {
        min(1, max(0, Double(current) / Double(max(goal, 1))))
    }

    var body: some View {
        HStack(spacing: 18) {
            ZStack {
                Circle()
                    .stroke(AppTheme.accentSoft, lineWidth: 9)
                Circle()
                    .trim(from: 0, to: progress)
                    .stroke(AppTheme.accent, style: StrokeStyle(lineWidth: 9, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text("\(Int(progress * 100))%")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(AppTheme.accent)
            }
            .frame(width: 76, height: 76)

            VStack(alignment: .leading, spacing: 8) {
                Text(title.uppercased())
                    .font(.caption.weight(.bold))
                    .foregroundStyle(AppTheme.text)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(seconds ? format(seconds: current) : "\(current)")
                        .font(.system(.title2, design: .rounded, weight: .bold))
                    Text("/ \(seconds ? format(seconds: goal) : "\(goal)")")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(AppTheme.muted)
                }
                if let benchmark {
                    Label(benchmark, systemImage: "shield.checkered")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(AppTheme.gold)
                }
            }
            Spacer()
        }
        .card()
    }
}

struct ReadinessTile: View {
    var title: String
    var value: String
    var status: String
    var color: Color = AppTheme.accent

    var body: some View {
        VStack(spacing: 6) {
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(AppTheme.muted)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.75)
            Text(value)
                .font(.system(.title, design: .rounded, weight: .bold))
                .foregroundStyle(AppTheme.text)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            HStack(spacing: 5) {
                Circle()
                    .fill(color)
                    .frame(width: 6, height: 6)
                Text(status)
                    .font(.caption2)
                    .foregroundStyle(AppTheme.muted)
            }
        }
        .frame(maxWidth: .infinity)
        .card(padding: 12)
    }
}

struct StatusPill: View {
    var text: String
    var color: Color = AppTheme.accent
    var systemImage: String? = "checkmark.circle.fill"

    var body: some View {
        HStack(spacing: 5) {
            Text(text)
            if let systemImage {
                Image(systemName: systemImage)
            }
        }
        .font(.caption.weight(.bold))
        .foregroundStyle(color)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(color.opacity(0.12))
        .clipShape(Capsule())
    }
}

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
        HStack(spacing: 5) {
            Image(systemName: iconName)
            Text(displayText)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .font(.caption2.weight(.bold))
        .foregroundStyle(color)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(color.opacity(0.12))
        .clipShape(Capsule())
        .accessibilityLabel(displayText)
    }

    private var displayText: String {
        let base = prefix.map { "\($0): \(label.title)" } ?? label.title
        guard let targetRPE, targetRPE > 0 else { return base }
        return "\(base) RPE \(targetRPE)"
    }

    private var color: Color {
        switch label {
        case .light: AppTheme.accent
        case .medium: AppTheme.gold
        case .hard, .veryHard: AppTheme.warning
        case .maxOutput: AppTheme.warning
        }
    }

    private var iconName: String {
        switch label {
        case .light: "leaf"
        case .medium: "speedometer"
        case .hard: "flame"
        case .veryHard: "flame.fill"
        case .maxOutput: "bolt.fill"
        }
    }
}

struct ValidationStatusCard: View {
    var title: String = "Plan validation"
    var status: String
    var contextState: String
    var detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(title.uppercased())
                    .font(.caption.weight(.bold))
                    .foregroundStyle(AppTheme.text)
                Spacer()
                StatusPill(text: status.capitalized, color: AppTheme.muted, systemImage: "checklist")
            }
            InfoLine(title: "Context state", value: contextState)
            InfoLine(title: "Validated", value: detail)
        }
        .card()
    }
}

struct WeekPlanTable: View {
    var sessions: [WorkoutSession]
    var onSelectSession: (WorkoutSession) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Open activities".uppercased())
                    .font(.caption.weight(.bold))
                    .foregroundStyle(AppTheme.text)
            }

            if sessions.isEmpty {
                Text("No open activities.")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(sessions.prefix(7).enumerated()), id: \.element.id) { index, session in
                        WeekPlanRow(session: session) {
                            onSelectSession(session)
                        }
                        if index < min(sessions.count, 7) - 1 {
                            Divider()
                        }
                    }
                }
                .background(AppTheme.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                        .stroke(AppTheme.divider, lineWidth: 1)
                )
            }
        }
        .card()
    }
}

struct WeekPlanRow: View {
    var session: WorkoutSession
    var onSelect: () -> Void = {}

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 10) {
                Text(session.scheduledDate, format: .dateTime.weekday(.abbreviated))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppTheme.muted)
                    .frame(width: 34, alignment: .leading)
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(AppTheme.text)
                        .lineLimit(1)
                    if let effortLabel = session.plannedEffortLabel {
                        EffortPill(
                            label: effortLabel,
                            targetRPE: session.plannedEffortTargetRPE > 0 ? session.plannedEffortTargetRPE : nil
                        )
                    }
                }
                Spacer()
                WorkoutStatusIcon(status: session.status)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(AppTheme.muted.opacity(0.7))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
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

    private var statusColor: Color {
        switch status {
        case .planned: AppTheme.muted
        case .completed, .deload: AppTheme.accent
        case .missed: AppTheme.warning
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
            .font(.body.weight(.bold))
            .foregroundStyle(statusColor)
            .accessibilityLabel(accessibilityLabel)
    }
}

struct WorkoutStatusPill: View {
    var status: SessionStatus

    var body: some View {
        StatusPill(text: title, color: color, systemImage: iconName)
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

    private var color: Color {
        switch status {
        case .planned: AppTheme.muted
        case .completed, .deload: AppTheme.accent
        case .missed: AppTheme.warning
        }
    }
}

struct InfoLine: View {
    var title: String
    var value: String
    var valueColor: Color = AppTheme.text

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title)
                .font(.caption)
                .foregroundStyle(AppTheme.muted)
            Spacer()
            Text(value)
                .font(.caption.weight(.semibold))
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
                .font(.system(.body, design: .rounded, weight: .semibold))
                .foregroundStyle(AppTheme.text)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(width: 92)
                .background(AppTheme.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                        .stroke(AppTheme.divider, lineWidth: 1)
                )
            if !suffix.isEmpty {
                Text(suffix)
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            }
        }
    }
}

struct Hexagon: Shape {
    func path(in rect: CGRect) -> Path {
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let radius = min(rect.width, rect.height) / 2
        var path = Path()

        for index in 0..<6 {
            let angle = CGFloat(index) * .pi / 3 - .pi / 2
            let point = CGPoint(
                x: center.x + radius * cos(angle),
                y: center.y + radius * sin(angle)
            )
            if index == 0 {
                path.move(to: point)
            } else {
                path.addLine(to: point)
            }
        }
        path.closeSubpath()
        return path
    }
}
