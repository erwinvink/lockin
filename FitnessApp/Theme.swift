import CoreText
import SwiftUI
import UIKit

/// Trailhead — the approved visual direction (design canvas, Trailhead page).
/// Swiss trail signage on a light snow ground: white cards on a 1pt line,
/// granite for text and the one primary action, sign yellow only for signs,
/// the active tab and "you are here". Effort is shown with trail marks.
enum AppTheme {
    // MARK: Palette
    static let background = Color(trailHex: 0xF3F5F6)   // Snow: screen ground
    static let surface = Color(trailHex: 0xFFFFFF)      // White: cards, inputs
    static let surfaceRaised = Color(trailHex: 0xEEF1F3)
    static let text = Color(trailHex: 0x1A2024)         // Granite
    static let bodyText = Color(trailHex: 0x2E373D)     // Rock: long body copy
    static let muted = Color(trailHex: 0x5F6A72)        // Slate: labels, meta
    static let faint = Color(trailHex: 0x6E787F)
    static let divider = Color(trailHex: 0xDCE1E4)      // Line: borders
    static let dividerSoft = Color(trailHex: 0xE6EAEC)
    static let post = Color(trailHex: 0x9AA3A8)         // Scree: sign posts, trail
    static let sign = Color(trailHex: 0xF7C600)         // Sign yellow
    static let markerRed = Color(trailHex: 0xD3262E)
    static let markerRedText = Color(trailHex: 0xB81F27)
    static let markerBlue = Color(trailHex: 0x1F5FA8)

    /// The primary action is granite, not yellow: yellow belongs to signs.
    static let accent = text
    static let accentInk = Color.white
    static let warning = markerRed

    // Legacy aliases so screens not yet redrawn stay on-palette.
    static let gold = accent
    static let goldSoft = accent.opacity(0.08)
    static let accentSoft = accent.opacity(0.08)
    static let warningSoft = markerRed.opacity(0.10)

    // MARK: Geometry
    static let screenMargin: CGFloat = 20
    static let sectionSpacing: CGFloat = 22
    static let rowSpacing: CGFloat = 12
    static let cardRadius: CGFloat = 16
    static let smallRadius: CGFloat = 12
    static let buttonRadius: CGFloat = 14

    /// Text colour for an effort word. The trail mark next to it carries the
    /// grade, so light and medium stay neutral.
    static func effortColor(_ label: PlannedEffortLabel) -> Color {
        switch label {
        case .light, .medium: text
        case .hard: markerRedText
        case .veryHard, .maxOutput: markerBlue
        }
    }

    static func statusColor(_ status: SessionStatus) -> Color {
        switch status {
        case .planned: muted
        case .completed, .partial, .deload: text
        case .missed: markerRedText
        }
    }
}

extension Color {
    init(trailHex hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

// MARK: - Signika

/// Signika, a typeface drawn for wayfinding. It ships as an asset-catalog
/// data set (variable weight axis) and is registered at launch, so neither
/// Info.plist nor the project file needs a font entry.
enum TrailFont {
    static let familyName = "Signika"

    enum Weight: CGFloat {
        case regular = 400
        case medium = 500
        case semibold = 600
        case bold = 700

        var systemWeight: UIFont.Weight {
            switch self {
            case .regular: .regular
            case .medium: .medium
            case .semibold: .semibold
            case .bold: .bold
            }
        }
    }

    /// Call once at launch. Safe to call again.
    static func registerIfNeeded() {
        _ = isRegistered
    }

    static let isRegistered: Bool = {
        guard let asset = NSDataAsset(name: "Signika"),
              let provider = CGDataProvider(data: asset.data as CFData),
              let font = CGFont(provider)
        else { return false }
        var error: Unmanaged<CFError>?
        if CTFontManagerRegisterGraphicsFont(font, &error) { return true }
        // Already registered in this process counts as success.
        return UIFont.familyNames.contains(familyName)
    }()

    private static let weightAxis = 0x7767_6874 // 'wght'

    static func uiFont(size: CGFloat, weight: Weight) -> UIFont {
        guard isRegistered else {
            return .systemFont(ofSize: size, weight: weight.systemWeight)
        }
        let variation = UIFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String)
        let descriptor = UIFontDescriptor(fontAttributes: [
            .family: familyName,
            variation: [weightAxis: weight.rawValue]
        ])
        return UIFont(descriptor: descriptor, size: size)
    }
}

// MARK: - Type scale

extension Font {
    /// Signika at a fixed design size that still follows Dynamic Type.
    static func trail(
        _ size: CGFloat,
        _ weight: TrailFont.Weight = .regular,
        relativeTo style: UIFont.TextStyle = .body
    ) -> Font {
        let base = TrailFont.uiFont(size: size, weight: weight)
        let scaled = UIFontMetrics(forTextStyle: style).scaledFont(for: base)
        return Font(scaled as CTFont)
    }

    /// Sign title: the one big answer on a screen (today's session).
    static var lockinDisplay: Font { .trail(31, .bold, relativeTo: .largeTitle) }
    /// Screen titles rendered in content (Progress, Log, Profile).
    static var lockinScreenTitle: Font { .trail(32, .bold, relativeTo: .largeTitle) }
    /// Section titles inside a screen ("Route", "This week").
    static var lockinSection: Font { .trail(22, .bold, relativeTo: .title2) }
    /// Row titles: exercise names, list items.
    static var lockinRowTitle: Font { .trail(17, .semibold, relativeTo: .headline) }
    static var lockinBody: Font { .trail(16, .regular, relativeTo: .body) }
    static var lockinMeta: Font { .trail(13, .regular, relativeTo: .footnote) }
    /// Numerals (timer, reps, readiness) — tabular so values don't jump.
    static func lockinNumeral(_ size: CGFloat) -> Font {
        .trail(size, .bold, relativeTo: .title1).monospacedDigit()
    }
}

/// Small label ("STREAK", "OPEN ACTIVITIES"). Callers pass the final string —
/// UI tests assert the text verbatim.
struct MicroLabel: View {
    var text: String
    var color: Color = AppTheme.muted

    var body: some View {
        Text(text)
            .font(.trail(12, .semibold, relativeTo: .caption1))
            .tracking(0.6)
            .foregroundStyle(color)
    }
}

// MARK: - Hairlines and sections

/// 1pt rule between rows and around ruled sections.
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

/// White card on a 1pt line. One elevation language: never a shadow, never
/// a card inside a card.
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

    /// Ruled section: hairlines above and below, open background.
    func ruled(verticalPadding: CGFloat = 14) -> some View {
        VStack(spacing: 0) {
            Hairline()
            self.padding(.vertical, verticalPadding)
            Hairline()
        }
    }

    /// Input treatment shared by every free-text field.
    func lockinField() -> some View {
        self
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(AppTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous)
                    .strokeBorder(AppTheme.post.opacity(0.6), lineWidth: 1)
            )
    }
}

// MARK: - Buttons

/// Granite primary — one per screen. Press: slight dim and settle; reduce
/// motion drops the scale and keeps the dim.
struct PrimaryActionButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.trail(18, .semibold, relativeTo: .headline))
            .foregroundStyle(isEnabled ? AppTheme.accentInk : AppTheme.muted)
            .frame(maxWidth: .infinity, minHeight: 56)
            .background(
                RoundedRectangle(cornerRadius: AppTheme.buttonRadius, style: .continuous)
                    .fill(isEnabled ? AppTheme.accent : AppTheme.divider)
            )
            .opacity(configuration.isPressed ? 0.82 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(.snappy(duration: 0.22), value: configuration.isPressed)
    }
}

/// Outlined secondary. A destructive role turns border and label red.
struct SecondaryActionButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let isDestructive = configuration.role == .destructive
        configuration.label
            .font(.trail(16, .semibold, relativeTo: .headline))
            .foregroundStyle(isDestructive ? AppTheme.markerRedText : AppTheme.text)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(
                RoundedRectangle(cornerRadius: AppTheme.buttonRadius, style: .continuous)
                    .fill(configuration.isPressed ? AppTheme.surfaceRaised : AppTheme.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.buttonRadius, style: .continuous)
                    .strokeBorder(isDestructive ? AppTheme.markerRed : AppTheme.text, lineWidth: 2)
            )
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(.snappy(duration: 0.22), value: configuration.isPressed)
    }
}

// MARK: - Screen scaffold

/// Every screen draws on the same snow ground. The optional title renders in
/// content (not a navigation bar) — the UI tests assert which screens have
/// real navigation bars and which don't.
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
            // Clear the floating tab bar so rows never sit under it.
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
