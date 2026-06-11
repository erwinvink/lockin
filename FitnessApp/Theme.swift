import SwiftUI

/// Premium Flat Gold — the approved visual direction (Design/redesign-screens/
/// style-guide.md). One dark canvas, hairlines over cards, gold reserved for
/// the primary action and progress, monospaced digits for every metric.
enum AppTheme {
    // MARK: Palette (#111111 / #171717 / #f1eee8 / #928e86 / #c4a35c / #2a2926)
    static let background = Color(red: 0.067, green: 0.067, blue: 0.067)
    static let surface = Color(red: 0.090, green: 0.090, blue: 0.090)
    static let surfaceRaised = Color(red: 0.114, green: 0.110, blue: 0.102)
    static let text = Color(red: 0.945, green: 0.933, blue: 0.910)
    static let muted = Color(red: 0.573, green: 0.557, blue: 0.525)
    static let faint = Color(red: 0.420, green: 0.408, blue: 0.384)
    static let accent = Color(red: 0.769, green: 0.639, blue: 0.361)
    static let accentInk = Color(red: 0.086, green: 0.075, blue: 0.055)
    static let divider = Color(red: 0.165, green: 0.161, blue: 0.149)
    static let warning = Color(red: 0.886, green: 0.337, blue: 0.306)

    // Legacy aliases — gold merged into the single accent; soft fills became
    // translucent washes so any straggling call site stays on-palette.
    static let gold = accent
    static let goldSoft = accent.opacity(0.14)
    static let accentSoft = accent.opacity(0.14)
    static let warningSoft = warning.opacity(0.14)

    // MARK: Geometry
    static let screenMargin: CGFloat = 20
    static let sectionSpacing: CGFloat = 28
    static let rowSpacing: CGFloat = 12
    static let cardRadius: CGFloat = 12
    static let smallRadius: CGFloat = 10
    static let buttonRadius: CGFloat = 16

    /// Effort is the one place three hues are allowed: quiet, gold, red.
    static func effortColor(_ label: PlannedEffortLabel) -> Color {
        switch label {
        case .light: muted
        case .medium: accent
        case .hard, .veryHard, .maxOutput: warning
        }
    }

    static func statusColor(_ status: SessionStatus) -> Color {
        switch status {
        case .planned: muted
        case .completed, .deload: accent
        case .missed: warning
        }
    }
}

// MARK: - Type scale

extension Font {
    /// Display: the one big answer on a screen (Today's session title).
    static var lockinDisplay: Font { .system(size: 34, weight: .semibold) }
    /// Screen titles rendered in content (Progress, Log, Profile).
    static var lockinScreenTitle: Font { .system(size: 28, weight: .semibold) }
    /// Section titles inside a screen ("This week", "Session history").
    static var lockinSection: Font { .system(size: 17, weight: .semibold) }
    /// Hero numerals (timer, readiness) — always pair with monospacedDigit.
    static func lockinNumeral(_ size: CGFloat) -> Font {
        .system(size: size, weight: .semibold).monospacedDigit()
    }
}

/// Tracked uppercase micro label ("TODAY", "OPEN ACTIVITIES"). Callers pass
/// the final string — UI tests assert the uppercased text verbatim.
struct MicroLabel: View {
    var text: String
    var color: Color = AppTheme.muted

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .tracking(1.4)
            .foregroundStyle(color)
    }
}

// MARK: - Hairlines and sections

/// 1px rule — the only divider in the app. Replaces every card border.
struct Hairline: View {
    var body: some View {
        Rectangle()
            .fill(AppTheme.divider)
            .frame(height: 1)
    }
}

struct SectionHeader<Trailing: View>: View {
    var title: String
    @ViewBuilder var trailing: Trailing

    init(_ title: String, @ViewBuilder trailing: () -> Trailing = { EmptyView() }) {
        self.title = title
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.lockinSection)
                .foregroundStyle(AppTheme.text)
            Spacer()
            trailing
        }
    }
}

/// Flat framed surface — the rare card. One elevation language: a fill and a
/// hairline, never a shadow. Reserved for content that genuinely needs a
/// frame (coach read, pending-run confirm, sheet field groups).
struct CardModifier: ViewModifier {
    var padding: CGFloat = 16

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(
                RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous)
                    .fill(AppTheme.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous)
                    .strokeBorder(AppTheme.divider, lineWidth: 1)
            )
    }
}

extension View {
    func card(padding: CGFloat = 16) -> some View {
        modifier(CardModifier(padding: padding))
    }

    func panel() -> some View {
        card()
    }

    /// Ruled section: hairlines above and below, open background. The default
    /// container of the design — use instead of cards wherever possible.
    func ruled(verticalPadding: CGFloat = 14) -> some View {
        VStack(spacing: 0) {
            Hairline()
            self.padding(.vertical, verticalPadding)
            Hairline()
        }
    }

    /// Flat input treatment shared by every free-text field.
    func lockinField() -> some View {
        self
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(AppTheme.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                    .strokeBorder(AppTheme.divider, lineWidth: 1)
            )
    }
}

// MARK: - Buttons

/// Gold primary — one per screen. Press: ink dims, scale settles on a snappy
/// spring; reduce-motion drops the scale and keeps the dim.
struct PrimaryActionButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(AppTheme.accentInk)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(
                RoundedRectangle(cornerRadius: AppTheme.buttonRadius, style: .continuous)
                    .fill(AppTheme.accent)
            )
            .brightness(configuration.isPressed ? -0.07 : 0)
            .saturation(isEnabled ? 1 : 0.55)
            .opacity(isEnabled ? 1 : 0.45)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(.snappy(duration: 0.22), value: configuration.isPressed)
    }
}

/// Quiet secondary — hairline border, no fill until pressed. A destructive
/// button role turns the label red on its own.
struct SecondaryActionButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(configuration.role == .destructive ? AppTheme.warning : AppTheme.text)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: AppTheme.buttonRadius, style: .continuous)
                    .fill(configuration.isPressed ? AppTheme.surfaceRaised : .clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.buttonRadius, style: .continuous)
                    .strokeBorder(AppTheme.divider, lineWidth: 1)
            )
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(.snappy(duration: 0.22), value: configuration.isPressed)
    }
}

// MARK: - Screen scaffold

/// Every screen and sheet draws on the same flat canvas. The optional title
/// renders in content (not a navigation bar) — the UI tests assert which
/// screens have real navigation bars and which don't.
struct ScreenBackground<Content: View>: View {
    let title: String?
    @ViewBuilder var content: Content

    init(title: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AppTheme.sectionSpacing) {
                if let title {
                    Text(title)
                        .font(.lockinScreenTitle)
                        .foregroundStyle(AppTheme.text)
                        .padding(.top, 6)
                }
                content
            }
            .padding(.horizontal, AppTheme.screenMargin)
            .padding(.top, 12)
            // Clear the floating glass tab bar so rows never die under it.
            .padding(.bottom, 48)
        }
        .scrollIndicators(.hidden)
        .background(AppTheme.background.ignoresSafeArea())
        // Barless screens: dissolve content under the status bar instead of
        // letting type collide with the clock.
        .overlay(alignment: .top) {
            LinearGradient(
                stops: [
                    .init(color: AppTheme.background, location: 0),
                    .init(color: AppTheme.background.opacity(0.85), location: 0.45),
                    .init(color: AppTheme.background.opacity(0), location: 1)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 64)
            .ignoresSafeArea(edges: .top)
            .allowsHitTesting(false)
        }
    }
}
