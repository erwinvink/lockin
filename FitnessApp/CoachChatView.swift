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
    @State private var isConfirmingClear = false
    @FocusState private var isComposerFocused: Bool

    var profile: UserProfile

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
            CoachChatHeader(
                messages: messages,
                raceGoal: raceGoals.first,
                onClear: messages.isEmpty || isSending ? nil : { isConfirmingClear = true }
            )
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
                            CoachChatBubble(
                                message: message,
                                onRetry: message.role == .user && message.status == .failed && !isSending
                                    ? { retry(message) }
                                    : nil
                            )
                            .id(message.id)
                        }

                        if !isSending, let followUps = latestFollowUps {
                            CoachFollowUpChips(questions: followUps, onPick: ask)
                                .id("coach-chat-follow-ups")
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
        .confirmationDialog("Clear conversation?", isPresented: $isConfirmingClear, titleVisibility: .visible) {
            Button("Clear conversation", role: .destructive, action: clearConversation)
        } message: {
            Text("Every message in this chat is deleted. Your training data stays.")
        }
        #if DEBUG
        .task {
            await runUITestScriptIfNeeded()
        }
        #endif
    }

    /// The latest coach answer's suggested questions, shown under it.
    private var latestFollowUps: [String]? {
        guard let last = messages.last,
              last.role == .coach,
              last.status == .sent else { return nil }
        let prompts = last.followUpPrompts
        return prompts.isEmpty ? nil : prompts
    }

    @MainActor
    private func useStarterQuestion(_ question: String) {
        draft = question
        sendDraft()
    }

    /// Sends a suggested question as is, leaving any draft alone.
    @MainActor
    private func ask(_ question: String) {
        guard let userMessage = prepareQuestion(question, clearDraft: false) else { return }
        isComposerFocused = false
        Task {
            await requestReply(including: userMessage)
        }
    }

    /// Sends a question that failed again, as the same bubble.
    @MainActor
    private func retry(_ question: CoachChatMessage) {
        guard !isSending else { return }
        CoachChatHistory.prepareRetry(of: question, in: messages, modelContext: modelContext)
        isSending = true
        try? modelContext.save()
        Task {
            await requestReply(including: question)
        }
    }

    @MainActor
    private func clearConversation() {
        guard !isSending else { return }
        try? CoachChatHistory.clear(in: modelContext)
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
            let turns = CoachChatHistory.turns(from: storedMessages(), including: userMessage)
            let response = try await LocalCoachClient(endpointString: endpoint).sendCoachChat(
                CoachChatRequest(request: request, messages: turns)
            )
            isSending = false
            // Device time, not the server's generatedAt: a clock difference
            // must never sort the answer above its question.
            modelContext.insert(CoachChatMessage(
                createdAt: max(Date(), userMessage.createdAt.addingTimeInterval(0.001)),
                role: .coach,
                text: response.answer,
                status: .sent,
                evidence: response.evidence,
                memorySummary: response.memorySummary,
                answerKind: response.answerKind,
                followUpPrompts: response.followUpPrompts,
                usedModel: response.usedModel
            ))
            try modelContext.save()
        } catch {
            isSending = false
            userMessage.status = .failed
            modelContext.insert(CoachChatMessage(
                createdAt: max(Date(), userMessage.createdAt.addingTimeInterval(0.001)),
                role: .coach,
                text: chatFailureMessage(for: error),
                status: .failed
            ))
            try? modelContext.save()
        }
        try? CoachChatHistory.prune(in: modelContext)
    }

    /// A fresh fetch, not the @Query array: right after a retry deleted a
    /// failed reply, the query can still hold that deleted message.
    @MainActor
    private func storedMessages() -> [CoachChatMessage] {
        (try? modelContext.fetch(FetchDescriptor<CoachChatMessage>(sortBy: [SortDescriptor(\.createdAt)]))) ?? messages
    }

    private func chatFailureMessage(for error: Error) -> String {
        let details = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !details.isEmpty else {
            return "I could not reach coach chat right now."
        }
        return "I could not reach coach chat right now.\n\n\(details)"
    }

    @MainActor
    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            withAnimation(.smooth(duration: 0.25)) {
                if isSending {
                    proxy.scrollTo("coach-chat-typing", anchor: .bottom)
                } else if latestFollowUps != nil {
                    proxy.scrollTo("coach-chat-follow-ups", anchor: .bottom)
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
    /// Nil hides the clear button (nothing to clear, or a reply is on its way).
    var onClear: (() -> Void)?

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "signpost.right.fill")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(AppTheme.text)
                .frame(width: 40, height: 40)
                .background(Circle().fill(AppTheme.sign))
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 1) {
                Text("Coach chat")
                    .font(.trail(17, .semibold, relativeTo: .headline))
                    .foregroundStyle(AppTheme.text)
                Text(statusText)
                    .font(.lockinMeta)
                    .foregroundStyle(AppTheme.muted)
                    .lineLimit(1)
                    .accessibilityIdentifier("coach-chat-status")
            }

            Spacer()

            if let onClear {
                Button(action: onClear) {
                    Image(systemName: "trash")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(AppTheme.muted)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear conversation")
                .accessibilityIdentifier("coach-chat-clear-button")
            }

            CoachChip(text: "Live data", systemImage: "bolt.fill")
        }
    }

    private var statusText: String {
        if messages.count == 1 {
            return "1 message"
        }
        if !messages.isEmpty {
            return "\(messages.count) messages"
        }
        if let raceGoal {
            return "Training for \(raceGoal.name)"
        }
        return "Ready for questions"
    }
}

private struct CoachChatStarter: View {
    var questions: [String]
    var onPick: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Ask one thing")
                .font(.lockinSection)
                .foregroundStyle(AppTheme.text)
            Text("The coach answers from your logged sessions, runs and Garmin data.")
                .font(.trail(15, .regular, relativeTo: .subheadline))
                .foregroundStyle(AppTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 8)
            FlowLayout(spacing: 8) {
                ForEach(questions, id: \.self) { question in
                    CoachQuestionChip(question: question, onPick: onPick)
                }
            }
        }
        .accessibilityIdentifier("coach-chat-starter")
    }
}

/// The latest answer's suggested next questions, under the coach bubble.
private struct CoachFollowUpChips: View {
    var questions: [String]
    var onPick: (String) -> Void

    var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(questions, id: \.self) { question in
                CoachQuestionChip(question: question, onPick: onPick)
            }
        }
        .padding(.trailing, 48)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("coach-chat-follow-ups")
    }
}

private struct CoachQuestionChip: View {
    var question: String
    var onPick: (String) -> Void

    var body: some View {
        Button(question) { onPick(question) }
            .font(.trail(15, .medium, relativeTo: .subheadline))
            .foregroundStyle(AppTheme.text)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(Capsule().fill(AppTheme.surface))
            .overlay(Capsule().strokeBorder(AppTheme.divider, lineWidth: 1))
    }
}

private struct CoachChatBubble: View {
    var message: CoachChatMessage
    /// Set on a failed question: tapping the bubble sends it again.
    var onRetry: (() -> Void)?

    static let quickAnswerCaption = "Quick answer (coach model unavailable)"

    private var isUser: Bool {
        message.role == .user
    }

    /// The corner nearest the speaker stays tight, like a speech tail.
    private var shape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: 16,
            bottomLeadingRadius: isUser ? 16 : 4,
            bottomTrailingRadius: isUser ? 4 : 16,
            topTrailingRadius: 16,
            style: .continuous
        )
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if isUser { Spacer(minLength: 48) }

            VStack(alignment: .leading, spacing: 10) {
                Text(message.text)
                    .font(.lockinBody)
                    .foregroundStyle(isUser ? AppTheme.accentInk : AppTheme.bodyText)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)

                if !isUser, !message.evidence.isEmpty {
                    CoachEvidenceStrip(evidence: message.evidence)
                }

                if isQuickAnswer {
                    Label(Self.quickAnswerCaption, systemImage: "bolt.slash")
                        .font(.trail(12, .semibold, relativeTo: .caption1))
                        .foregroundStyle(AppTheme.muted)
                }

                // A failed coach reply is the error itself; only the question
                // is marked as not sent.
                if isUser, message.status == .failed {
                    Label(
                        onRetry == nil ? "Not sent" : "Not sent. Tap to retry",
                        systemImage: onRetry == nil ? "exclamationmark.circle.fill" : "arrow.clockwise.circle.fill"
                    )
                        .font(.trail(13, .semibold, relativeTo: .footnote))
                        .foregroundStyle(AppTheme.accentInk)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(shape.fill(isUser ? AppTheme.text : AppTheme.surface))
            .overlay(shape.strokeBorder(isUser ? Color.clear : borderColor, lineWidth: message.status == .failed ? 1.5 : 1))
            .frame(maxWidth: 318, alignment: isUser ? .trailing : .leading)
            .contentShape(shape)
            .onTapGesture {
                onRetry?()
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityAddTraits(onRetry == nil ? [] : .isButton)
            .accessibilityHint(onRetry == nil ? "" : "Sends this question again.")
            .accessibilityIdentifier(isUser ? "coach-chat-user-message" : "coach-chat-coach-message")

            if !isUser { Spacer(minLength: 48) }
        }
    }

    private var borderColor: Color {
        message.status == .failed ? AppTheme.markerRed : AppTheme.divider
    }

    private var isQuickAnswer: Bool {
        !isUser && message.status == .sent && !message.usedModel
    }

    private var accessibilityLabel: String {
        var parts = [message.text]
        if !message.evidence.isEmpty {
            parts.append(contentsOf: message.evidence)
        }
        if isQuickAnswer {
            parts.append(Self.quickAnswerCaption)
        }
        if isUser, message.status == .failed {
            parts.append(onRetry == nil ? "Not sent" : "Not sent. Tap to retry")
        }
        return parts.joined(separator: ". ")
    }
}

/// What the answer stands on, each line marked like a waymark.
private struct CoachEvidenceStrip: View {
    var evidence: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Rectangle()
                .fill(AppTheme.dividerSoft)
                .frame(height: 1)
                .padding(.bottom, 2)
            Text("Based on")
                .font(.trail(12, .semibold, relativeTo: .caption1))
                .foregroundStyle(AppTheme.muted)
            ForEach(evidence.prefix(3), id: \.self) { item in
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    TrailMark(grade: .hiking, width: 10, height: 7)
                        .alignmentGuide(.firstTextBaseline) { $0[.bottom] }
                    Text(item)
                        .font(.trail(13, .regular, relativeTo: .footnote))
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
            Image(systemName: "ellipsis")
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(AppTheme.muted)
                .symbolEffect(.variableColor.iterative, options: .repeating)
                .frame(width: 44, height: 20)
                .padding(.horizontal, 10)
                .padding(.vertical, 10)
                .background(
                    UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 4, bottomTrailingRadius: 16, topTrailingRadius: 16, style: .continuous)
                        .fill(AppTheme.surface)
                )
                .overlay(
                    UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 4, bottomTrailingRadius: 16, topTrailingRadius: 16, style: .continuous)
                        .strokeBorder(AppTheme.divider, lineWidth: 1)
                )
            Spacer(minLength: 48)
        }
        .accessibilityElement(children: .ignore)
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
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Ask the coach anything", text: $draft, axis: .vertical)
                .font(.lockinBody)
                .foregroundStyle(AppTheme.text)
                .tint(AppTheme.text)
                .lineLimit(1...4)
                .focused($isFocused)
                .submitLabel(.send)
                .onSubmit {
                    if canSend {
                        onSend()
                    }
                }
                .textFieldStyle(.plain)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .frame(minHeight: 46)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(AppTheme.surface))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(isFocused ? AppTheme.text : AppTheme.post.opacity(0.6), lineWidth: isFocused ? 1.5 : 1)
                )
                .accessibilityIdentifier("coach-chat-input")
                .accessibilityLabel("Ask coach")

            Button(action: onSend) {
                Group {
                    if isSending {
                        SwiftUI.ProgressView()
                            .tint(AppTheme.text)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 18, weight: .bold))
                    }
                }
                .foregroundStyle(canSend ? AppTheme.text : AppTheme.faint)
                .frame(width: 46, height: 46)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(canSend || isSending ? AppTheme.sign : AppTheme.surfaceRaised)
                )
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel(isSending ? "Coach is answering" : "Send")
            .accessibilityHint(canSend ? "Sends your question to coach chat." : "Enter a question before sending.")
            .accessibilityIdentifier("coach-chat-send-button")
        }
    }
}
