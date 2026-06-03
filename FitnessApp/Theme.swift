import SwiftUI

enum AppTheme {
    static let background = Color(hex: "FAF8F2")
    static let backgroundSecondary = Color(hex: "F3F0E8")
    static let surface = Color(hex: "FFFFFF")
    static let surfaceWarm = Color(hex: "F7F4EC")
    static let surfaceElevated = Color(hex: "FEFCF7")
    static let border = Color(hex: "E4DED2")
    static let borderStrong = Color(hex: "D4CCBD")
    static let dividerLine = Color(hex: "EAE5DC")
    static let text = Color(hex: "171A15")
    static let textPrimary = Color(hex: "171A15")
    static let textSecondary = Color(hex: "5F6258")
    static let textTertiary = Color(hex: "8D8A80")
    static let forest = Color(hex: "203A24")
    static let forestLight = Color(hex: "385B38")
    static let olive = Color(hex: "73804A")
    static let sage = Color(hex: "AAB18A")
    static let stone = Color(hex: "C8C1B3")
    static let success = Color(hex: "2E6B3F")
    static let warning = Color(hex: "B7791F")
    static let danger = Color(hex: "A14A3B")
    static let blueRunning = Color(hex: "3D6F91")
    static let rankDark = Color(hex: "111713")
    static let rankDarkSecondary = Color(hex: "1D241F")
    static let primaryButtonForeground = Color(hex: "FFFDF8")
    static let tabSurface = Color(hex: "FEFCF7")
    static let coachNoteFill = Color(hex: "F7F4EC")
    static let exerciseIconFill = Color(hex: "EEF2E8")

    static let muted = textSecondary
    static let accent = forest
    static let accentSoft = Color(hex: "E8EDE0")
    static let divider = border
    static let gold = olive
    static let goldSoft = sage.opacity(0.28)
    static let surfaceRaised = surfaceElevated

    static let screenHorizontal: CGFloat = 20
    static let screenTop: CGFloat = 16
    static let sectionGap: CGFloat = 12
    static let cardPadding: CGFloat = 16
    static let cardGap: CGFloat = 12
    static let rowGap: CGFloat = 10
    static let microGap: CGFloat = 6
    static let bottomSafeAreaExtra: CGFloat = 4
    static let tabBarClearance: CGFloat = 80
    static let cardRadius: CGFloat = 8
    static let largeCardRadius: CGFloat = 10
    static let buttonRadius: CGFloat = 6
    static let smallRadius: CGFloat = 8
}

extension Color {
    init(hex: String) {
        var cleaned = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        cleaned = cleaned.replacingOccurrences(of: "#", with: "")

        var value: UInt64 = 0
        Scanner(string: cleaned).scanHexInt64(&value)

        let red = Double((value >> 16) & 0xFF) / 255.0
        let green = Double((value >> 8) & 0xFF) / 255.0
        let blue = Double(value & 0xFF) / 255.0
        self.init(red: red, green: green, blue: blue)
    }
}

struct CardModifier: ViewModifier {
    var padding: CGFloat = AppTheme.cardPadding

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(
                RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous)
                    .fill(AppTheme.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous)
                    .stroke(AppTheme.border, lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.035), radius: 8, x: 0, y: 2)
    }
}

extension View {
    func card(padding: CGFloat = AppTheme.cardPadding) -> some View {
        modifier(CardModifier(padding: padding))
    }

    func panel() -> some View {
        card()
    }
}

struct PrimaryActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(AppTheme.primaryButtonForeground)
            .frame(maxWidth: .infinity)
            .frame(height: 40)
            .background(
                RoundedRectangle(cornerRadius: AppTheme.buttonRadius, style: .continuous)
                    .fill(AppTheme.forest)
            )
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .opacity(configuration.isPressed ? 0.86 : 1)
    }
}

struct SecondaryActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(AppTheme.textPrimary)
            .frame(maxWidth: .infinity)
            .frame(height: 46)
            .background(
                RoundedRectangle(cornerRadius: AppTheme.buttonRadius, style: .continuous)
                    .fill(AppTheme.surfaceWarm)
            )
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.buttonRadius, style: .continuous)
                    .stroke(AppTheme.border, lineWidth: 1)
            )
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .opacity(configuration.isPressed ? 0.78 : 1)
    }
}

struct ScreenBackground<Content: View>: View {
    let title: String?
    let trailing: AnyView?
    @ViewBuilder var content: Content

    init(title: String? = nil, trailing: AnyView? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.trailing = trailing
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AppTheme.sectionGap) {
                if title != nil || trailing != nil {
                    HStack(alignment: .center) {
                        if let title {
                            Text(title)
                                .font(.system(size: 32, weight: .bold, design: .default))
                                .foregroundStyle(AppTheme.textPrimary)
                        }
                        Spacer()
                        trailing
                    }
                    .padding(.top, AppTheme.screenTop)
                }
                content
            }
            .padding(.horizontal, AppTheme.screenHorizontal)
            .padding(.bottom, 28 + AppTheme.tabBarClearance)
        }
        .scrollIndicators(.hidden)
        .background(AppTheme.background.ignoresSafeArea())
    }
}
