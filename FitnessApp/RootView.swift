import SwiftData
import SwiftUI

struct RootView: View {
    @Query(sort: \UserProfile.createdAt) private var profiles: [UserProfile]

    var body: some View {
        ZStack {
            AppTheme.background.ignoresSafeArea()
            if let profile = profiles.first {
                AppShellView(profile: profile)
            } else {
                OnboardingView()
            }
        }
        .foregroundStyle(AppTheme.text)
    }
}
