import SwiftUI

struct LockinCard<Content: View>: View {
    var padding: CGFloat = AppTheme.cardPadding
    var background: Color = AppTheme.surface
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .background(
                RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous)
                    .fill(background)
            )
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous)
                    .stroke(AppTheme.border, lineWidth: 1)
            )
    }
}

struct SectionLabel: View {
    var text: String

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 12, weight: .semibold))
            .tracking(1.2)
            .foregroundStyle(AppTheme.forest)
    }
}

struct AppHeader<Trailing: View>: View {
    var title: String?
    var usesWordmark = false
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(alignment: .center) {
            if usesWordmark {
                Text("LOCKIN")
                    .font(.system(size: 22, weight: .semibold))
                    .tracking(5)
                    .foregroundStyle(AppTheme.textPrimary)
                    .accessibilityIdentifier("lockin-wordmark")
            } else if let title {
                Text(title)
                    .font(.system(size: 32, weight: .bold))
                    .foregroundStyle(AppTheme.textPrimary)
            }
            Spacer()
            trailing
        }
        .frame(minHeight: 44)
    }
}

struct BrandHeader: View {
    var subtitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("LOCKIN")
                .font(.system(size: 22, weight: .semibold))
                .tracking(5)
                .foregroundStyle(AppTheme.textPrimary)
                .accessibilityIdentifier("lockin-wordmark")
            if let subtitle {
                Text(subtitle)
                    .font(.system(size: 15))
                    .foregroundStyle(AppTheme.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct AvatarCircle: View {
    var initials: String = "EV"
    var size: CGFloat = 38

    var body: some View {
        ZStack {
            Circle()
                .fill(AppTheme.rankDark)
            Text(initials)
                .font(.system(size: max(11, size * 0.32), weight: .semibold))
                .foregroundStyle(AppTheme.surfaceElevated)
        }
        .frame(width: size, height: size)
        .accessibilityLabel("Profile")
    }
}

struct SegmentedFilter: View {
    var options: [String]
    @Binding var selection: String

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options, id: \.self) { option in
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        selection = option
                    }
                } label: {
                    Text(option)
                        .font(.system(size: 12, weight: selection == option ? .semibold : .regular))
                        .foregroundStyle(selection == option ? AppTheme.textPrimary : AppTheme.textSecondary)
                        .frame(maxWidth: .infinity)
                        .frame(height: 36)
                        .background(
                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .fill(selection == option ? AppTheme.surface : Color.clear)
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(
            RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                .fill(AppTheme.backgroundSecondary)
        )
        .overlay(
            RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                .stroke(AppTheme.border, lineWidth: 1)
        )
    }
}

struct PrimaryActionButton: View {
    var title: String
    var systemImage: String = "arrow.right"
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title)
                Spacer()
                Image(systemName: systemImage)
                    .font(.system(size: 24, weight: .regular))
            }
            .padding(.horizontal, 20)
        }
        .buttonStyle(PrimaryActionButtonStyle())
    }
}

struct SecondaryButton: View {
    var title: String
    var systemImage: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
        }
        .buttonStyle(SecondaryActionButtonStyle())
    }
}

struct MetricPill: View {
    var title: String
    var value: String
    var color: Color = AppTheme.forest

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(AppTheme.textSecondary)
            Text(value)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct StatusPill: View {
    var text: String
    var color: Color = AppTheme.forest
    var systemImage: String? = "checkmark.circle.fill"

    var body: some View {
        HStack(spacing: 5) {
            if let systemImage {
                Image(systemName: systemImage)
            }
            Text(text)
        }
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(color)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(color.opacity(0.10))
        .clipShape(Capsule())
    }
}

struct InfoLine: View {
    var title: String
    var value: String
    var valueColor: Color = AppTheme.textPrimary

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.system(size: 12))
                .foregroundStyle(AppTheme.textSecondary)
            Spacer(minLength: 12)
            Text(value)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(valueColor)
                .multilineTextAlignment(.trailing)
        }
    }
}

struct ProgressArc: View {
    var progress: Double
    var size: CGFloat = 96
    var lineWidth: CGFloat = 4
    var color: Color = AppTheme.forest

    var body: some View {
        ZStack {
            ArcShape()
                .stroke(AppTheme.borderStrong, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
            ArcShape(progress: min(1, max(0, progress)))
                .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
        }
        .frame(width: size, height: size * 0.62)
        .accessibilityHidden(true)
    }
}

private struct ArcShape: Shape {
    var progress: Double = 1

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let radius = min(rect.width / 2, rect.height)
        let center = CGPoint(x: rect.midX, y: rect.maxY)
        path.addArc(
            center: center,
            radius: radius,
            startAngle: .degrees(180),
            endAngle: .degrees(180 + 180 * progress),
            clockwise: false
        )
        return path
    }
}

struct SparklineView: View {
    var values: [Double]
    var color: Color = AppTheme.olive

    var body: some View {
        GeometryReader { proxy in
            let points = normalizedPoints(in: proxy.size)
            Path { path in
                guard let first = points.first else { return }
                path.move(to: first)
                for point in points.dropFirst() {
                    path.addLine(to: point)
                }
            }
            .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))

            ForEach(Array(points.enumerated()), id: \.offset) { _, point in
                Circle()
                    .fill(color)
                    .frame(width: 3, height: 3)
                    .position(point)
            }
        }
        .frame(height: 42)
        .accessibilityHidden(true)
    }

    private func normalizedPoints(in size: CGSize) -> [CGPoint] {
        let fallback = values.isEmpty ? [0, 1, 0.6, 0.8] : values
        let minValue = fallback.min() ?? 0
        let maxValue = fallback.max() ?? 1
        let span = max(0.0001, maxValue - minValue)
        return fallback.enumerated().map { index, value in
            let x = fallback.count == 1 ? size.width : CGFloat(index) / CGFloat(fallback.count - 1) * size.width
            let normalized = (value - minValue) / span
            let y = size.height - CGFloat(normalized) * (size.height - 6) - 3
            return CGPoint(x: x, y: y)
        }
    }
}

struct GoalMetricCard: View {
    var title: String
    var goalLabel: String
    var current: String
    var target: String
    var percentage: Double
    var sparkline: [Double]
    var dateLabel: String?

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(title)
                            .font(.system(size: 16, weight: .semibold))
                        Text(goalLabel)
                            .font(.system(size: 12))
                            .foregroundStyle(AppTheme.textSecondary)
                    }
                    Spacer()
                    Text("\(Int(percentage * 100))%")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(AppTheme.textSecondary)
                }

                HStack(alignment: .bottom) {
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text(current)
                            .font(.system(size: 34, weight: .medium, design: .default))
                        Text("/ \(target)")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundStyle(AppTheme.textSecondary)
                    }
                    Spacer()
                    ProgressArc(progress: percentage)
                }

                SparklineView(values: sparkline)
                if let dateLabel {
                    Text(dateLabel)
                        .font(.system(size: 11))
                        .foregroundStyle(AppTheme.textTertiary)
                }
            }
        }
        .accessibilityLabel("\(title), \(current) of \(target), \(Int(percentage * 100)) percent")
        .accessibilityIdentifier("goal-\(title)")
    }
}

enum ConsistencyDayStatus {
    case completed
    case planned
    case missed
    case rest
    case today
}

struct ConsistencyStrip: View {
    var statuses: [ConsistencyDayStatus]

    var body: some View {
        HStack(spacing: 8) {
            ForEach(Array(statuses.prefix(7).enumerated()), id: \.offset) { _, status in
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(fill(for: status))
                    .overlay(
                        RoundedRectangle(cornerRadius: 7, style: .continuous)
                            .stroke(stroke(for: status), lineWidth: status == .rest ? 0 : 1)
                    )
                    .frame(width: 32, height: 32)
                    .accessibilityLabel(label(for: status))
            }
        }
    }

    private func fill(for status: ConsistencyDayStatus) -> Color {
        switch status {
        case .completed, .today: AppTheme.forest
        case .planned: AppTheme.surfaceWarm
        case .missed: AppTheme.surfaceWarm
        case .rest: AppTheme.backgroundSecondary
        }
    }

    private func stroke(for status: ConsistencyDayStatus) -> Color {
        switch status {
        case .completed, .today: AppTheme.forest
        case .planned: AppTheme.forest
        case .missed: AppTheme.danger
        case .rest: Color.clear
        }
    }

    private func label(for status: ConsistencyDayStatus) -> String {
        switch status {
        case .completed: "Completed"
        case .planned: "Planned"
        case .missed: "Missed"
        case .rest: "Rest"
        case .today: "Today"
        }
    }
}

struct WorkoutRowCard: View {
    var title: String
    var subtitle: String
    var status: String
    var systemImage: String
    var tint: Color = AppTheme.forest
    var trailingSystemImage: String? = nil

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(tint)
                .frame(width: 28, height: 28)
                .background(Circle().fill(tint.opacity(0.10)))

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(AppTheme.textPrimary)
                Text(subtitle)
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
                    .lineLimit(2)
            }
            Spacer()
            Text(status)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(AppTheme.textSecondary)
            if let trailingSystemImage {
                Image(systemName: trailingSystemImage)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(tint)
            }
        }
        .padding(.vertical, 10)
    }
}

struct CoachReadCard: View {
    var headline: String
    var summary: String
    var latestChange: String?
    var recommendation: String?
    var dateText: String = "Today"
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        LockinCard(background: AppTheme.surfaceElevated) {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    SectionLabel(text: "Coach Read")
                    Text(dateText)
                        .font(.system(size: 11))
                        .foregroundStyle(AppTheme.textSecondary)
                }
                Text(headline)
                    .font(.system(size: 18, weight: .semibold))
                Text(summary)
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                if let latestChange, !latestChange.isEmpty {
                    InfoLine(title: "Latest change", value: latestChange)
                }
                if let recommendation, !recommendation.isEmpty {
                    InfoLine(title: "Recommendation", value: recommendation)
                }
                if let actionTitle, let action {
                    Button(action: action) {
                        HStack {
                            Text(actionTitle)
                            Image(systemName: "arrow.right")
                        }
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(AppTheme.forest)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

struct CalendarDayMarker: View {
    var day: Int
    var status: ConsistencyDayStatus?

    var body: some View {
        Text("\(day)")
            .font(.system(size: 13, weight: status == .today ? .semibold : .regular))
            .foregroundStyle(status == .completed || status == .today ? AppTheme.surfaceElevated : AppTheme.textPrimary)
            .frame(width: 30, height: 30)
            .background(Circle().fill(fill))
            .overlay(Circle().stroke(stroke, lineWidth: status == nil ? 0 : 1))
    }

    private var fill: Color {
        switch status {
        case .completed, .today: AppTheme.forest
        case .planned: AppTheme.surfaceWarm
        case .missed: AppTheme.surfaceWarm
        case .rest: AppTheme.backgroundSecondary
        case nil: Color.clear
        }
    }

    private var stroke: Color {
        switch status {
        case .planned: AppTheme.forest
        case .missed: AppTheme.danger
        case .rest: AppTheme.border
        default: Color.clear
        }
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
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            SectionLabel(text: label)
        }
        .frame(maxWidth: .infinity)
    }
}

struct MetricCard: View {
    var title: String
    var value: String
    var subtitle: String
    var color: Color = AppTheme.forest
    var systemImage: String?

    init(title: String, value: String, subtitle: String, color: Color = AppTheme.forest, systemImage: String? = nil) {
        self.title = title
        self.value = value
        self.subtitle = subtitle
        self.color = color
        self.systemImage = systemImage
    }

    var body: some View {
        LockinCard(padding: 14) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    if let systemImage {
                        Image(systemName: systemImage)
                            .foregroundStyle(color)
                    }
                    SectionLabel(text: title)
                }
                Text(value)
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(color)
                    .lineLimit(1)
                    .minimumScaleFactor(0.65)
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(AppTheme.textSecondary)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
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
        GoalMetricCard(
            title: title,
            goalLabel: "Goal: \(seconds ? format(seconds: goal) : "\(goal)")",
            current: seconds ? format(seconds: current) : "\(current)",
            target: seconds ? format(seconds: goal) : "\(goal)",
            percentage: progress,
            sparkline: [0.2, 0.3, 0.28, 0.44, 0.56, progress],
            dateLabel: benchmark
        )
    }
}

struct ReadinessTile: View {
    var title: String
    var value: String
    var status: String
    var color: Color = AppTheme.forest

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(AppTheme.textSecondary)
            Text(value)
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
            HStack(spacing: 5) {
                Circle()
                    .fill(color)
                    .frame(width: 6, height: 6)
                Text(status)
                    .font(.system(size: 11))
                    .foregroundStyle(AppTheme.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 12)
    }
}

struct ValidationStatusCard: View {
    var title: String = "Plan validation"
    var status: String
    var contextState: String
    var detail: String

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    SectionLabel(text: title)
                    Spacer()
                    StatusPill(text: status.capitalized, color: AppTheme.textSecondary, systemImage: "checklist")
                }
                InfoLine(title: "Context state", value: contextState)
                InfoLine(title: "Validated", value: detail)
            }
        }
    }
}

struct WeekPlanTable: View {
    var sessions: [WorkoutSession]

    var body: some View {
        LockinCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Week plan")
                if sessions.isEmpty {
                    Text("No sessions yet.")
                        .font(.system(size: 14))
                        .foregroundStyle(AppTheme.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(sessions.prefix(7).enumerated()), id: \.element.id) { index, session in
                            WeekPlanRow(session: session)
                            if index < min(sessions.count, 7) - 1 {
                                Divider()
                            }
                        }
                    }
                }
            }
        }
    }
}

struct WeekPlanRow: View {
    var session: WorkoutSession

    var body: some View {
        WorkoutRowCard(
            title: session.title,
            subtitle: session.scheduledDate.formatted(date: .abbreviated, time: .omitted),
            status: session.status.rawValue.capitalized,
            systemImage: icon(for: session.focus),
            tint: color(for: session.status),
            trailingSystemImage: session.status == .completed ? "checkmark" : nil
        )
    }

    private func icon(for focus: SessionFocus) -> String {
        switch focus {
        case .pull: "figure.strengthtraining.traditional"
        case .push: "figure.core.training"
        case .core: "figure.core.training"
        case .mixed: "figure.cross.training"
        case .recovery: "leaf"
        }
    }

    private func color(for status: SessionStatus) -> Color {
        switch status {
        case .planned: AppTheme.forest
        case .completed: AppTheme.success
        case .missed: AppTheme.danger
        case .deload: AppTheme.olive
        }
    }
}

struct WorkoutStatusIcon: View {
    var status: SessionStatus

    var body: some View {
        Image(systemName: image)
            .foregroundStyle(color)
            .accessibilityLabel(status.rawValue.capitalized)
    }

    private var image: String {
        switch status {
        case .planned: "circle"
        case .completed: "checkmark.circle.fill"
        case .missed: "xmark.circle"
        case .deload: "leaf.circle"
        }
    }

    private var color: Color {
        switch status {
        case .planned: AppTheme.textTertiary
        case .completed: AppTheme.success
        case .missed: AppTheme.danger
        case .deload: AppTheme.olive
        }
    }
}

struct WorkoutStatusPill: View {
    var status: SessionStatus

    var body: some View {
        StatusPill(text: status.rawValue.capitalized, color: color, systemImage: image)
    }

    private var image: String {
        switch status {
        case .planned: "circle"
        case .completed: "checkmark.circle.fill"
        case .missed: "xmark.circle"
        case .deload: "leaf.circle"
        }
    }

    private var color: Color {
        switch status {
        case .planned: AppTheme.textSecondary
        case .completed: AppTheme.success
        case .missed: AppTheme.danger
        case .deload: AppTheme.olive
        }
    }
}

struct IntegerField: View {
    var title: String
    @Binding var value: Int
    var range: ClosedRange<Int>
    var suffix: String = ""

    var body: some View {
        HStack(spacing: 10) {
            Text(title)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(AppTheme.textPrimary)
            Spacer()
            TextField(title, value: clampedValue, format: .number)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 78)
                .textFieldStyle(.roundedBorder)
            if !suffix.isEmpty {
                Text(suffix)
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
            }
        }
    }

    private var clampedValue: Binding<Int> {
        Binding(
            get: { value },
            set: { value = min(range.upperBound, max(range.lowerBound, $0)) }
        )
    }
}

struct Hexagon: Shape {
    func path(in rect: CGRect) -> Path {
        let width = rect.width
        let height = rect.height
        let points = [
            CGPoint(x: width * 0.50, y: 0),
            CGPoint(x: width, y: height * 0.25),
            CGPoint(x: width, y: height * 0.75),
            CGPoint(x: width * 0.50, y: height),
            CGPoint(x: 0, y: height * 0.75),
            CGPoint(x: 0, y: height * 0.25)
        ]
        var path = Path()
        path.move(to: points[0])
        for point in points.dropFirst() {
            path.addLine(to: point)
        }
        path.closeSubpath()
        return path
    }
}
