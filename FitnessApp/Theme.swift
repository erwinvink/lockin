import SwiftUI

enum AppTheme {
    static let background = Color(red: 0.972, green: 0.957, blue: 0.928)
    static let surface = Color.white
    static let surfaceRaised = Color(red: 0.992, green: 0.988, blue: 0.976)
    static let divider = Color.black.opacity(0.08)
    static let text = Color(red: 0.075, green: 0.083, blue: 0.095)
    static let muted = Color(red: 0.43, green: 0.45, blue: 0.48)
    static let accent = Color(red: 0.27, green: 0.67, blue: 0.13)
    static let accentSoft = Color(red: 0.90, green: 0.96, blue: 0.86)
    static let warning = Color(red: 0.84, green: 0.12, blue: 0.08)
    static let warningSoft = Color(red: 1.0, green: 0.92, blue: 0.90)
    static let gold = Color(red: 0.88, green: 0.56, blue: 0.08)
    static let goldSoft = Color(red: 1.0, green: 0.94, blue: 0.78)

    static let cardRadius: CGFloat = 14
    static let smallRadius: CGFloat = 8
}

struct CardModifier: ViewModifier {
    var padding: CGFloat = 16

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(
                RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous)
                    .fill(AppTheme.surface)
                    .shadow(color: .black.opacity(0.08), radius: 16, x: 0, y: 8)
            )
            .overlay(
                RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous)
                    .stroke(AppTheme.divider, lineWidth: 1)
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
}

struct PrimaryActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(AppTheme.accent)
                    .shadow(color: AppTheme.accent.opacity(configuration.isPressed ? 0.12 : 0.30), radius: 14, x: 0, y: 8)
            )
            .opacity(configuration.isPressed ? 0.82 : 1)
    }
}

struct SecondaryActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(AppTheme.text)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(AppTheme.surfaceRaised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(AppTheme.divider, lineWidth: 1)
            )
            .opacity(configuration.isPressed ? 0.76 : 1)
    }
}

struct ScreenBackground<Content: View>: View {
    let title: String?
    @ViewBuilder var content: Content

    init(title: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let title {
                    Text(title)
                        .font(.system(.largeTitle, design: .rounded, weight: .bold))
                        .foregroundStyle(AppTheme.text)
                        .padding(.top, 4)
                }
                content
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 28)
        }
        .scrollIndicators(.hidden)
        .background(AppTheme.background.ignoresSafeArea())
    }
}
