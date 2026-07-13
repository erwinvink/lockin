import SwiftData
import SwiftUI

struct CoachChatView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \CoachChatMessage.createdAt) private var messages: [CoachChatMessage]
    @Query(sort: \PerformanceLog.completedAt, order: .reverse) private var logs: [PerformanceLog]
    @Query(sort: \WorkoutSession.scheduledDate) private var sessions: [WorkoutSession]
    @Query(sort: \SetPrescription.orderIndex) private var prescriptions: [SetPrescription]
    @Query(sort: \RaceGoal.createdAt) private var raceGoals: [RaceGoal]
    @Query(sort: \RunLog.completedAt, order: .reverse) private var runLogs: [RunLog]

    private let endpoint = LocalCoachClient.defaultEndpointString
    @AppStorage("coachModelID") private var selectedModelID = CoachModelCatalog.defaultModelID
    @State private var draft = ""
    @State private var isSending = false
    @State private var didRunUITestScript = false
    @FocusState private var isComposerFocused: Bool

    var profile: UserProfile

    private static let maxSentTurns = 20
    private static let starterQuestions = [
        "Am I working well?",
        "Am I on schedule for the Eiger Ultra?",
        "What is my biggest improvement point?",
        "Can you motivate me?",
        "What can you say about fatigue?",
        "What about shoulder pain?"
    ]

    var body: some View {
        VStack(spacing: 0) {
            CoachChatHeader(messages: messages, raceGoal: raceGoals.first)
                .padding(.horizontal, AppTheme.screenMargin)
                .padding(.top, 10)
                .padding(.bottom, 8)

            Hairline()

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if messages.isEmpty {
                            CoachChatStarter(questions: Self.starterQuestions, onPick: useStarterQuestion)
                                .padding(.top, 18)
                        }

                        ForEach(messages, id: \.id) { message in
                            CoachChatBubble(message: message)
                                .id(message.id)
                        }

                        if isSending {
                            CoachTypingBubble()
                                .id("coach-chat-typing")
                        }
                    }
                    .padding(.horizontal, AppTheme.screenMargin)
                    .padding(.top, 12)
                    .padding(.bottom, 12)
                }
                .scrollIndicators(.hidden)
                .scrollDismissesKeyboard(.interactively)
                .contentShape(Rectangle())
                .simultaneousGesture(TapGesture().onEnded {
                    isComposerFocused = false
                })
                .accessibilityIdentifier("coach-chat-scroll")
                .onChange(of: messages.count) { _, _ in
                    scrollToBottom(proxy)
                }
                .onChange(of: isSending) { _, _ in
                    scrollToBottom(proxy)
                }
            }

            Hairline()

            CoachChatComposer(
                draft: $draft,
                isFocused: $isComposerFocused,
                isSending: isSending,
                onSend: sendDraft
            )
            .padding(.horizontal, AppTheme.screenMargin)
            .padding(.vertical, 10)
        }
        .background(AppTheme.background.ignoresSafeArea())
        #if DEBUG
        .task {
            await runUITestScriptIfNeeded()
        }
        #endif
    }

    @MainActor
    private func useStarterQuestion(_ question: String) {
        draft = question
        sendDraft()
    }

    @MainActor
    private func sendDraft() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let userMessage = prepareQuestion(text, clearDraft: true) else { return }
        isComposerFocused = false

        Task {
            await requestReply(including: userMessage)
        }
    }

    @MainActor
    private func prepareQuestion(_ text: String, clearDraft: Bool) -> CoachChatMessage? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isSending else { return nil }

        let userMessage = CoachChatMessage(role: .user, text: trimmed, status: .sent)
        modelContext.insert(userMessage)
        if clearDraft {
            draft = ""
        }
        isSending = true
        try? modelContext.save()
        return userMessage
    }

    #if DEBUG
    @MainActor
    private func runUITestScriptIfNeeded() async {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("UITesting"),
              args.contains("RunCoachChatScript"),
              messages.isEmpty,
              !didRunUITestScript else { return }

        didRunUITestScript = true
        for question in Self.starterQuestions {
            guard let userMessage = prepareQuestion(question, clearDraft: false) else { return }
            await requestReply(including: userMessage)
        }
    }
    #endif

    @MainActor
    private func requestReply(including userMessage: CoachChatMessage) async {
        do {
            let request = makeCoachRequest(
                profile: profile,
                modelID: selectedModelID,
                logs: logs,
                sessions: sessions,
                prescriptions: prescriptions,
                raceGoal: raceGoals.first,
                runLogs: runLogs,
                weekStart: rollingPlanStart()
            )
            let turns = chatTurns(including: userMessage)
            let response = try await LocalCoachClient(endpointString: endpoint).sendCoachChat(
                CoachChatRequest(request: request, messages: turns)
            )
            isSending = false
            modelContext.insert(CoachChatMessage(
                createdAt: response.generatedAt,
                role: .coach,
                text: response.answer,
                status: .sent,
                evidence: response.evidence,
                memorySummary: response.memorySummary,
                answerKind: response.answerKind
            ))
            try modelContext.save()
        } catch {
            isSending = false
            userMessage.status = .failed
            modelContext.insert(CoachChatMessage(
                role: .coach,
                text: chatFailureMessage(for: error),
                status: .failed
            ))
            try? modelContext.save()
        }
    }

    private func chatFailureMessage(for error: Error) -> String {
        let details = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !details.isEmpty else {
            return "I could not reach coach chat right now."
        }
        return "I could not reach coach chat right now.\n\n\(details)"
    }

    private func chatTurns(including userMessage: CoachChatMessage) -> [CoachChatTurnRequest] {
        var combined = messages
        if !combined.contains(where: { $0.id == userMessage.id }) {
            combined.append(userMessage)
        }
        let sorted = combined.sorted { $0.createdAt < $1.createdAt }
        let sentMessages = sorted.enumerated().compactMap { index, message -> CoachChatMessage? in
            guard message.status == .sent else { return nil }
            if message.role == .user,
               sorted.indices.contains(index + 1),
               sorted[index + 1].role == .coach,
               sorted[index + 1].status == .failed {
                return nil
            }
            return message
        }

        return sentMessages
            .suffix(Self.maxSentTurns)
            .map {
                CoachChatTurnRequest(
                    role: $0.role.rawValue,
                    text: $0.text,
                    createdAt: $0.createdAt
                )
            }
    }

    @MainActor
    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            withAnimation(.smooth(duration: 0.25)) {
                if isSending {
                    proxy.scrollTo("coach-chat-typing", anchor: .bottom)
                } else if let last = messages.last {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
        }
    }
}

private struct CoachChatHeader: View {
    var messages: [CoachChatMessage]
    var raceGoal: RaceGoal?

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            ZStack {
                Circle()
                    .fill(AppTheme.surfaceRaised)
                Image(systemName: "brain.head.profile")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(AppTheme.accent)
            }
            .frame(width: 38, height: 38)

            VStack(alignment: .leading, spacing: 2) {
                Text("Coach chat")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(AppTheme.text)
                Text(statusText)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.muted)
                    .lineLimit(1)
                    .accessibilityIdentifier("coach-chat-status")
            }

            Spacer()

            StatusPill(text: "Live data", color: AppTheme.accent, systemImage: "bolt.fill")
        }
    }

    private var statusText: String {
        if !messages.isEmpty {
            return "\(messages.count) messages"
        }
        if let raceGoal {
            return "\(raceGoal.name) context"
        }
        return "Ready for questions"
    }
}

private struct CoachChatStarter: View {
    var questions: [String]
    var onPick: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Ask one thing")
                .font(.lockinSection)
                .foregroundStyle(AppTheme.text)
            FlowLayout(spacing: 8) {
                ForEach(questions, id: \.self) { question in
                    Button(question) { onPick(question) }
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(AppTheme.text)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(AppTheme.surfaceRaised)
                        .clipShape(Capsule())
                        .overlay(Capsule().strokeBorder(AppTheme.divider, lineWidth: 1))
                }
            }
        }
        .accessibilityIdentifier("coach-chat-starter")
    }
}

private struct CoachChatBubble: View {
    var message: CoachChatMessage

    private var isUser: Bool {
        message.role == .user
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if isUser { Spacer(minLength: 44) }

            VStack(alignment: isUser ? .trailing : .leading, spacing: 8) {
                Text(message.text)
                    .font(.subheadline)
                    .foregroundStyle(isUser ? AppTheme.accentInk : AppTheme.text)
                    .fixedSize(horizontal: false, vertical: true)

                if !isUser, !message.evidence.isEmpty {
                    CoachEvidenceStrip(evidence: message.evidence)
                }

                if message.status == .failed {
                    MicroLabel(text: "FAILED", color: AppTheme.warning)
                }
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 10)
            .background(isUser ? AppTheme.accent : AppTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(isUser ? AppTheme.accent.opacity(0.35) : AppTheme.divider, lineWidth: 1)
            )
            .frame(maxWidth: 318, alignment: isUser ? .trailing : .leading)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityIdentifier(isUser ? "coach-chat-user-message" : "coach-chat-coach-message")

            if !isUser { Spacer(minLength: 44) }
        }
    }

    private var accessibilityLabel: String {
        var parts = [message.text]
        if !message.evidence.isEmpty {
            parts.append(contentsOf: message.evidence)
        }
        if message.status == .failed {
            parts.append("Failed")
        }
        return parts.joined(separator: ". ")
    }
}

private struct CoachEvidenceStrip: View {
    var evidence: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(evidence.prefix(3), id: \.self) { item in
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(AppTheme.accent)
                    Text(item)
                        .font(.system(size: 11))
                        .foregroundStyle(AppTheme.muted)
                        .lineLimit(2)
                }
            }
        }
        .accessibilityIdentifier("coach-chat-evidence")
    }
}

private struct CoachTypingBubble: View {
    var body: some View {
        HStack {
            HStack(spacing: 5) {
                Circle().fill(AppTheme.muted).frame(width: 5, height: 5)
                Circle().fill(AppTheme.muted).frame(width: 5, height: 5)
                Circle().fill(AppTheme.muted).frame(width: 5, height: 5)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(AppTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(AppTheme.divider, lineWidth: 1)
            )
            Spacer(minLength: 44)
        }
        .accessibilityIdentifier("coach-chat-typing")
        .accessibilityLabel("Coach is typing")
    }
}

private struct CoachChatComposer: View {
    @Binding var draft: String
    @FocusState.Binding var isFocused: Bool
    var isSending: Bool
    var onSend: () -> Void

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Ask coach", text: $draft, axis: .vertical)
                .font(.subheadline)
                .foregroundStyle(AppTheme.text)
                .lineLimit(1...4)
                .focused($isFocused)
                .submitLabel(.send)
                .onSubmit {
                    if canSend {
                        onSend()
                    }
                }
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 11)
                .background(AppTheme.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(AppTheme.divider, lineWidth: 1)
                )
                .accessibilityIdentifier("coach-chat-input")
                .accessibilityLabel("Ask coach")

            Button(action: onSend) {
                Image(systemName: isSending ? "hourglass" : "paperplane.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(AppTheme.accentInk)
                    .frame(width: 42, height: 42)
                    .background(canSend ? AppTheme.accent : AppTheme.faint)
                    .clipShape(Circle())
            }
            .disabled(!canSend)
            .accessibilityLabel(isSending ? "Coach is answering" : "Send")
            .accessibilityHint(canSend ? "Sends your question to coach chat." : "Enter a question before sending.")
            .accessibilityIdentifier("coach-chat-send-button")
        }
    }
}

private struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 320
        let rows = rows(for: subviews, maxWidth: width)
        return CGSize(width: width, height: rows.reduce(0) { $0 + $1.height } + CGFloat(max(0, rows.count - 1)) * spacing)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var origin = bounds.origin
        for row in rows(for: subviews, maxWidth: bounds.width) {
            var x = origin.x
            for item in row.items {
                item.subview.place(
                    at: CGPoint(x: x, y: origin.y),
                    proposal: ProposedViewSize(item.size)
                )
                x += item.size.width + spacing
            }
            origin.y += row.height + spacing
        }
    }

    private func rows(for subviews: Subviews, maxWidth: CGFloat) -> [FlowRow] {
        var rows: [FlowRow] = []
        var current = FlowRow()
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if !current.items.isEmpty, current.width + spacing + size.width > maxWidth {
                rows.append(current)
                current = FlowRow()
            }
            current.add(subview: subview, size: size, spacing: spacing)
        }
        if !current.items.isEmpty {
            rows.append(current)
        }
        return rows
    }

    private struct FlowRow {
        var items: [(subview: LayoutSubview, size: CGSize)] = []
        var width: CGFloat = 0
        var height: CGFloat = 0

        mutating func add(subview: LayoutSubview, size: CGSize, spacing: CGFloat) {
            width += items.isEmpty ? size.width : spacing + size.width
            height = max(height, size.height)
            items.append((subview, size))
        }
    }
}
