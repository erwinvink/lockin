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
                .font(.trail(12, .semibold, relativeTo: .caption1))
                .lineLimit(1)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .overlay(Capsule().strokeBorder(AppTheme.divider, lineWidth: 1))
    }
}

/// Effort as a trail mark plus words: "Medium, RPE 6". The mark carries the
/// grade; the words make sure colour never carries meaning alone.
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
        HStack(spacing: 7) {
            TrailMark(grade: TrailGrade(label))
            Text(displayText)
                .font(.lockinMeta.monospacedDigit())
                .foregroundStyle(AppTheme.muted)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(displayText)
    }

    private var displayText: String {
        let base = prefix.map { "\($0): \(label.title)" } ?? label.title
        guard let targetRPE, targetRPE > 0 else { return base }
        return "\(base), RPE \(targetRPE)"
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
                    .font(.lockinMeta.monospacedDigit())
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

// MARK: - Session rows

struct WorkoutStatusIcon: View {
    var status: SessionStatus

    private var waypoint: WaypointState {
        switch status {
        case .planned: .planned
        case .completed, .deload, .partial: .done
        case .missed: .missed
        }
    }

    private var accessibilityLabel: String {
        switch status {
        case .planned: "Open"
        case .completed: "Done"
        case .partial: "Partial"
        case .missed: "Missed"
        case .deload: "Deloaded"
        }
    }

    var body: some View {
        WaypointMarker(state: waypoint, size: 22)
            .accessibilityElement()
            .accessibilityLabel(accessibilityLabel)
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
                .font(.trail(15, .regular, relativeTo: .subheadline))
                .foregroundStyle(AppTheme.muted)
            Spacer()
            Text(value)
                .font(.trail(15, .semibold, relativeTo: .subheadline).monospacedDigit())
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
        HStack(spacing: 10) {
            Text(title)
                .font(.lockinBody)
                .foregroundStyle(AppTheme.text)
                .lineLimit(2)
            Spacer()
            // No grouping: "3100", not "3.100", while typing and on screen.
            TextField(title, value: clampedValue, format: .number.grouping(.never))
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .font(.trail(16, .semibold, relativeTo: .body).monospacedDigit())
                .foregroundStyle(AppTheme.text)
                .tint(AppTheme.text)
                .focused($isFocused)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(width: 84)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(AppTheme.surfaceRaised)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(isFocused ? AppTheme.text : AppTheme.divider, lineWidth: isFocused ? 1.5 : 1)
                )
                .animation(.easeOut(duration: 0.15), value: isFocused)
            if !suffix.isEmpty {
                Text(suffix)
                    .font(.trail(14, .regular, relativeTo: .subheadline))
                    .foregroundStyle(AppTheme.muted)
                    .frame(minWidth: 24, alignment: .leading)
            }
        }
    }
}

/// Countdown on a race sign: days in the last two weeks, weeks before that.
func raceCountdownText(_ raceDate: Date) -> String {
    let calendar = Calendar.current
    let days = calendar.dateComponents(
        [.day],
        from: calendar.startOfDay(for: Date()),
        to: calendar.startOfDay(for: raceDate)
    ).day ?? 0
    if days <= 0 { return "Today" }
    if days < 14 { return days == 1 ? "1 day" : "\(days) days" }
    return "\(days / 7) wk"
}

// MARK: - Trailhead: trail marks

/// Effort as Swiss trail grades: the yellow hiking trail is light, the
/// white-red-white mountain trail is medium to hard, the white-blue-white
/// alpine route is very hard to max output.
enum TrailGrade {
    case hiking
    case mountain
    case alpine

    init(_ label: PlannedEffortLabel) {
        switch label {
        case .light: self = .hiking
        case .medium, .hard: self = .mountain
        case .veryHard, .maxOutput: self = .alpine
        }
    }

    /// The middle stripe of a painted mark; the hiking grade is plain yellow.
    var stripe: Color? {
        switch self {
        case .hiking: nil
        case .mountain: AppTheme.markerRed
        case .alpine: AppTheme.markerBlue
        }
    }
}

/// White-stripe-white bands, as painted on rocks and sign tips.
private struct TrailStripes: View {
    var stripe: Color

    var body: some View {
        VStack(spacing: 0) {
            Color.white
            stripe
            Color.white
        }
    }
}

struct TrailMark: View {
    var grade: TrailGrade
    /// Nil stretches the mark to the available width (a grade band).
    var width: CGFloat? = 20
    var height: CGFloat = 13

    var body: some View {
        ZStack {
            if let stripe = grade.stripe {
                TrailStripes(stripe: stripe)
            } else {
                AppTheme.sign
            }
        }
        .frame(width: width, height: height)
        .frame(maxWidth: width == nil ? .infinity : nil)
        .clipShape(RoundedRectangle(cornerRadius: 2, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 2, style: .continuous)
                .strokeBorder(AppTheme.text.opacity(0.3), lineWidth: 1)
        )
        .accessibilityHidden(true)
    }
}

// MARK: - Trailhead: signposts

/// A Swiss trail sign: a plate with an arrow tip on the trailing edge.
struct SignShape: Shape {
    var tip: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - tip, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.maxX - tip, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

/// Destination on the left, time on the right, like a trail sign. A
/// mountain or alpine grade paints the tip. Signs are information, never
/// buttons.
struct Signpost: View {
    enum Size {
        case large
        case small
    }

    enum Style {
        /// The normal yellow sign.
        case yellow
        /// A white plate with a granite outline, for "nothing due" days.
        case plain
    }

    var eyebrow: String
    var title: String
    var trailing: String
    var grade: TrailGrade?
    var size: Size = .large
    var style: Style = .yellow

    private var isLarge: Bool { size == .large }
    private var tip: CGFloat { isLarge ? 34 : 28 }
    private var stripeWidth: CGFloat { isLarge ? 64 : 58 }
    private var stripe: Color? { grade?.stripe }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: isLarge ? 1 : 0) {
                Text(eyebrow)
                    .font(.trail(isLarge ? 14 : 13, .semibold, relativeTo: .subheadline))
                Text(title)
                    .font(isLarge ? .lockinDisplay : .trail(20, .bold, relativeTo: .title3))
                    .lineLimit(2)
                    .minimumScaleFactor(0.75)
            }
            Spacer(minLength: 8)
            if !trailing.isEmpty {
                Text(trailing)
                    .font(.trail(isLarge ? 27 : 20, .bold, relativeTo: .title2).monospacedDigit())
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .foregroundStyle(AppTheme.text)
        .padding(.leading, 20)
        .padding(.trailing, (stripe == nil ? tip : stripeWidth) + 14)
        .padding(.vertical, 10)
        .frame(minHeight: isLarge ? 96 : 64)
        .background {
            ZStack(alignment: .trailing) {
                style == .yellow ? AppTheme.sign : AppTheme.surface
                if let stripe {
                    TrailStripes(stripe: stripe)
                        .frame(width: stripeWidth)
                }
            }
            .clipShape(SignShape(tip: tip))
        }
        .overlay {
            if style == .plain {
                SignShape(tip: tip)
                    .stroke(AppTheme.text, lineWidth: 2)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// Signs mounted on one grey post. The first sign runs full width; later
/// ones are inset so the stack reads as a real signpost.
struct SignpostStack<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            content
        }
        .padding(.top, 8)
        .padding(.bottom, 22)
        .background(alignment: .topLeading) {
            UnevenRoundedRectangle(topLeadingRadius: 3, topTrailingRadius: 3)
                .fill(AppTheme.post)
                .frame(width: 12)
                .padding(.leading, 28)
                .accessibilityHidden(true)
        }
    }
}

/// "1 h 15" / "28 min": the time on a sign.
func signDurationText(minutes: Int) -> String {
    guard minutes > 0 else { return "" }
    if minutes < 60 { return "\(minutes) min" }
    let hours = minutes / 60
    let rest = minutes % 60
    return rest == 0 ? "\(hours) h" : "\(hours) h \(rest)"
}

// MARK: - Trailhead: waypoints

enum WaypointState {
    case done
    case planned
    /// "You are here": the current step or today.
    case current
    case missed
    case rest
    /// Nothing planned yet.
    case unplanned
}

struct WaypointMarker: View {
    var state: WaypointState
    var size: CGFloat = 30

    var body: some View {
        ZStack {
            switch state {
            case .done:
                Circle().fill(AppTheme.text)
                Image(systemName: "checkmark")
                    .font(.system(size: size * 0.42, weight: .heavy))
                    .foregroundStyle(Color.white)
            case .planned:
                Circle().fill(AppTheme.surface)
                Circle().strokeBorder(AppTheme.text, lineWidth: 3)
            case .current:
                Circle().fill(AppTheme.sign)
                Circle().strokeBorder(AppTheme.text, lineWidth: 3)
            case .missed:
                Circle().fill(AppTheme.surface)
                Circle().strokeBorder(AppTheme.markerRed, lineWidth: 3)
                Image(systemName: "xmark")
                    .font(.system(size: size * 0.34, weight: .heavy))
                    .foregroundStyle(AppTheme.markerRed)
            case .rest:
                Circle()
                    .fill(AppTheme.post.opacity(0.55))
                    .frame(width: size * 0.4, height: size * 0.4)
            case .unplanned:
                Circle()
                    .fill(AppTheme.surface)
                Circle()
                    .strokeBorder(AppTheme.post, style: StrokeStyle(lineWidth: 2, dash: [3, 3]))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The dashed trail drawn between waypoints, vertical or horizontal.
struct TrailLine: Shape {
    var axis: Axis = .vertical

    func path(in rect: CGRect) -> Path {
        var path = Path()
        if axis == .vertical {
            path.move(to: CGPoint(x: rect.midX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
        } else {
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        }
        return path
    }
}

extension View {
    /// Draws the dashed trail behind a column of waypoint rows. `inset` is
    /// the distance from the top of the first row (and the bottom of the
    /// last) to its waypoint's centre; `leading` is the waypoint centre.
    func trailBehind(leading: CGFloat = 22, inset: CGFloat = 29) -> some View {
        background(alignment: .topLeading) {
            TrailLine()
                .stroke(AppTheme.post, style: StrokeStyle(lineWidth: 3, dash: [6, 6]))
                .frame(width: 3)
                .padding(.vertical, inset)
                .padding(.leading, leading - 1.5)
                .accessibilityHidden(true)
        }
    }
}
