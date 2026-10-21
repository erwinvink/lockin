import XCTest

/// Captures full-resolution screenshots of every screen and sheet for design
/// review. Not a functional test: it never asserts visual content, it only
/// fails when navigation breaks. Run with
/// `TEST_RUNNER_SCREENSHOT_DIR=<absolute dir> xcodebuild test ... -only-testing:FitnessAppUITests/DesignScreenshotTour`.
final class DesignScreenshotTour: XCTestCase {
    private var screenshotDirectory: URL? {
        ProcessInfo.processInfo.environment["SCREENSHOT_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
    }

    func testCaptureSeededScreens() throws {
        guard let directory = screenshotDirectory else {
            throw XCTSkip("SCREENSHOT_DIR not set; the tour only runs for design capture.")
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let app = XCUIApplication()
        app.launchArguments = ["UITesting", "SeedTwoWeeksActivity"]
        app.launch()

        // Today, pristine.
        XCTAssertTrue(app.staticTexts["This week"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["save-run-feedback-button"].exists)
        snap(app, "01-today-top", in: directory)
        app.swipeUp()
        snap(app, "02-today-scrolled", in: directory)
        app.swipeDown()

        // Progress.
        app.tabBars.buttons["Progress"].tap()
        XCTAssertTrue(app.staticTexts["Readiness"].waitForExistence(timeout: 5))
        snap(app, "03-progress-top", in: directory)
        app.swipeUp()
        snap(app, "04-progress-scrolled", in: directory)

        // Coach.
        app.tabBars.buttons["Coach"].tap()
        XCTAssertTrue(app.staticTexts["Coach read"].waitForExistence(timeout: 5))
        snap(app, "05-coach-top", in: directory)
        app.swipeUp()
        snap(app, "06-coach-scrolled", in: directory)
        if app.buttons["Advanced"].exists {
            app.buttons["Advanced"].tap()
            sleepBriefly()
            snap(app, "07-coach-advanced", in: directory)
        }

        // Log.
        app.tabBars.buttons["Log"].tap()
        XCTAssertTrue(app.staticTexts["History"].waitForExistence(timeout: 5))
        snap(app, "08-log-top", in: directory)
        app.swipeUp()
        snap(app, "09-log-scrolled", in: directory)
        app.swipeDown()

        // Future workout preview sheet.
        let futureWorkout = app.buttons["week-plan-row-Pull Capacity"]
        if futureWorkout.waitForExistence(timeout: 5) {
            futureWorkout.tap()
            XCTAssertTrue(app.staticTexts["Workout details"].waitForExistence(timeout: 5))
            snap(app, "10-future-preview-sheet", in: directory)
            app.buttons["Done"].tap()
        }

        // Profile.
        app.tabBars.buttons["Profile"].tap()
        XCTAssertTrue(app.staticTexts["Strength days"].waitForExistence(timeout: 5))
        snap(app, "11-profile-top", in: directory)
        app.swipeUp()
        snap(app, "12-profile-middle", in: directory)
        app.swipeUp()
        snap(app, "13-profile-bottom", in: directory)

        // Back to Today for the interactive flows.
        app.tabBars.buttons["Today"].tap()
        sleepBriefly()

        // Workout info popover/sheet from the due session's first prescription.
        app.swipeUp()
        let infoRow = app.buttons["Shoulder mobility details"].firstMatch
        if infoRow.waitForExistence(timeout: 5) {
            infoRow.tap()
            sleepBriefly()
            snap(app, "15-workout-info-sheet", in: directory)
            dismissSheet(app)
        }

        // Check every exercise box, then Finish & log -> LogWorkoutView sheet.
        var attempts = 0
        while app.buttons["exercise-checkbox-unchecked"].firstMatch.exists, attempts < 12 {
            app.buttons["exercise-checkbox-unchecked"].firstMatch.tap()
            attempts += 1
        }
        let finishButton = app.buttons["finish-and-log-button"]
        if finishButton.waitForExistence(timeout: 3) {
            finishButton.tap()
        }
        if app.buttons["Save log"].waitForExistence(timeout: 5) {
            snap(app, "16-log-workout-sheet", in: directory)
            app.buttons["Cancel"].tap()
        }
    }

    func testCaptureOnboarding() throws {
        guard let directory = screenshotDirectory else {
            throw XCTSkip("SCREENSHOT_DIR not set; the tour only runs for design capture.")
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let app = XCUIApplication()
        app.launchArguments = ["UITesting"]
        app.launch()

        XCTAssertTrue(app.buttons["Create profile"].waitForExistence(timeout: 8))
        snap(app, "00-onboarding-top", in: directory)
        app.swipeUp()
        snap(app, "00-onboarding-middle", in: directory)
        app.swipeUp()
        snap(app, "00-onboarding-bottom", in: directory)
    }

    func testCaptureNewPlan() throws {
        guard let directory = screenshotDirectory else {
            throw XCTSkip("SCREENSHOT_DIR not set; the tour only runs for design capture.")
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let app = XCUIApplication()
        app.launchArguments = ["UITesting", "SeedTwoWeeksActivity"]
        app.launch()
        XCTAssertTrue(app.staticTexts["This week"].waitForExistence(timeout: 8))

        app.tabBars.buttons["Profile"].tap()
        let startButton = app.buttons["start-new-plan-button"]
        XCTAssertTrue(startButton.waitForExistence(timeout: 5))
        var attempts = 0
        while !startButton.isHittable, attempts < 8 {
            app.swipeUp()
            attempts += 1
        }
        app.swipeUp()
        snap(app, "new-plan-0-profile-entry", in: directory)
        startButton.tap()

        XCTAssertTrue(app.staticTexts["Start over"].waitForExistence(timeout: 5))
        snap(app, "new-plan-1-form-top", in: directory)
        for index in 2...6 {
            app.swipeUp()
            snap(app, "new-plan-\(index)-form", in: directory)
        }
        let start = app.buttons["new-plan-start-button"]
        attempts = 0
        while !start.isHittable, attempts < 4 {
            app.swipeUp()
            attempts += 1
        }
        start.tap()
        XCTAssertTrue(app.alerts["Start a new plan?"].waitForExistence(timeout: 5))
        snap(app, "new-plan-7-confirm", in: directory)
        app.alerts["Start a new plan?"].buttons["Start new plan"].tap()
        XCTAssertTrue(app.staticTexts["Waiting for the coach"].waitForExistence(timeout: 10))
        snap(app, "new-plan-8-offline", in: directory)
    }

    private func snap(_ app: XCUIApplication, _ name: String, in directory: URL) {
        sleepBriefly()
        let screenshot = XCUIScreen.main.screenshot()
        let url = directory.appendingPathComponent("\(name).png")
        try? screenshot.pngRepresentation.write(to: url)
    }

    private func dismissSheet(_ app: XCUIApplication) {
        let window = app.windows.firstMatch
        let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12))
        let end = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95))
        start.press(forDuration: 0.05, thenDragTo: end)
        sleepBriefly()
    }

    private func sleepBriefly() {
        usleep(450_000)
    }
}

final class FitnessAppUITests: XCTestCase {
    func testOnboardingScreenShowsGoalSetup() {
        let app = launchFreshApp()

        XCTAssertTrue(app.staticTexts["Set up lockin"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Create profile"].exists)
    }

    func testMainShellAndCoachGeneratorSurfaceAfterOnboarding() {
        let app = launchFreshApp()
        onboardDefault(app)

        XCTAssertTrue(app.staticTexts["No plan yet"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Plan your week"].exists)
        XCTAssertTrue(app.buttons["Open Coach"].exists)
        XCTAssertFalse(app.navigationBars["Today"].exists)

        app.tabBars.buttons["Coach"].tap()
        XCTAssertTrue(app.navigationBars["Coach"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Coach read"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Ready for the first week"].exists)
        XCTAssertTrue(app.staticTexts["Plan"].exists)
        XCTAssertTrue(app.staticTexts["Automatic"].exists)
        XCTAssertTrue(app.buttons["Create week schedule"].exists)
        XCTAssertFalse(app.buttons["Read new session"].exists)
        // Coach inputs and technical fallback controls live behind Advanced;
        // the main surface keeps only the user-facing plan action visible.
        XCTAssertFalse(app.staticTexts["What I'll use"].exists)
    }

    func testLogShowsEmptyAIOnlyStateAfterOnboarding() {
        let app = launchFreshApp()
        onboardDefault(app)

        app.tabBars.buttons["Log"].tap()
        XCTAssertTrue(app.staticTexts["Log"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Coming up"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Nothing planned yet. Your coach plans the week from Coach."].exists)
        XCTAssertTrue(app.staticTexts["History"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["No history yet."].exists)
        XCTAssertFalse(app.navigationBars["Log"].exists)
        XCTAssertFalse(app.staticTexts["DONE"].exists)
    }

    func testProgressScreenAfterOnboarding() {
        let app = launchFreshApp()
        onboardDefault(app)

        app.tabBars.buttons["Progress"].tap()
        XCTAssertTrue(app.staticTexts["Progress"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Progress"].exists)
        XCTAssertTrue(app.staticTexts["Sessions in a row"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Best streak"].exists)
        XCTAssertTrue(app.staticTexts["Missed"].exists)
        XCTAssertTrue(app.staticTexts["Pull-ups"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["PENALTIES"].exists)
        XCTAssertFalse(app.buttons["History"].exists)
        XCTAssertFalse(app.buttons["Consistency details and benchmarks"].exists)
    }

    func testCoachReadAndAdvancedControlsAfterOnboarding() {
        let app = launchFreshApp()
        onboardDefault(app)

        app.tabBars.buttons["Coach"].tap()
        XCTAssertTrue(app.navigationBars["Coach"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Coach read"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Ready for the first week"].exists)
        XCTAssertFalse(app.staticTexts["WEEK PLAN"].exists)
        XCTAssertFalse(app.buttons["Context"].exists)
        XCTAssertFalse(app.buttons["Rules"].exists)
        tapWhenReady(app.buttons["Advanced"], in: app)
        XCTAssertTrue(app.staticTexts["What I'll use"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Model"].waitForExistence(timeout: 5))
        // The proxy endpoint is configuration, not app state: no proxy status,
        // endpoint display, or endpoint editing may exist anywhere in the app.
        XCTAssertFalse(app.staticTexts["Proxy status"].exists)
        XCTAssertFalse(app.buttons["Check proxy"].exists)
        XCTAssertFalse(app.textFields["Proxy endpoint"].exists)
        XCTAssertFalse(app.textFields["Custom model ID"].exists)
        XCTAssertFalse(app.staticTexts["Technical checks"].exists)
    }

    func testProfileResetFlowUsesAIOnlyPlanCreation() {
        let app = launchFreshApp()
        onboardDefault(app)

        app.tabBars.buttons["Profile"].tap()
        XCTAssertTrue(app.staticTexts["Goals"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Profile"].exists)
        XCTAssertFalse(app.staticTexts["Local fallback plan"].exists)
        XCTAssertFalse(app.buttons["Regenerate local fallback week"].exists)
        XCTAssertTrue(app.staticTexts["Strength days"].waitForExistence(timeout: 5))
        tapWhenReady(app.buttons["Sa"], in: app)
        tapWhenReady(app.buttons["Tu"], in: app)

        app.tabBars.buttons["Coach"].tap()
        // The coach inputs live behind Advanced now; expand it to read the
        // week shape the coach will use.
        tapWhenReady(app.buttons["Advanced"], in: app)
        let updatedWeekShape = app.descendants(matching: .any)["coach-week-shape"]
        XCTAssertTrue(updatedWeekShape.waitForExistence(timeout: 5))
        XCTAssertTrue(updatedWeekShape.label.contains("Mo, Tu, We, Fr"))

        app.tabBars.buttons["Profile"].tap()
        XCTAssertTrue(app.staticTexts["Reminder"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.switches["Training reminder"].exists)
        XCTAssertTrue(app.datePickers["reminder-time-picker"].exists)
        XCTAssertFalse(app.buttons["Request and schedule"].exists)
        tapWhenReady(app.buttons["Wipe all app data"], in: app)
        XCTAssertTrue(app.alerts["Wipe all app data?"].waitForExistence(timeout: 5))
        app.alerts["Wipe all app data?"].buttons["Wipe everything"].tap()
        XCTAssertTrue(app.staticTexts["Set up lockin"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Create profile"].exists)
    }

    /// Profile > Start a new plan > confirm, on the seeded demo history. UI
    /// tests never call the proxy, so planning takes the offline path; the
    /// history must survive and the open plan must be gone.
    func testStartNewPlanKeepsHistoryAndClearsTheOpenPlan() {
        let app = XCUIApplication()
        app.launchArguments = ["UITesting", "SeedTwoWeeksActivity"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Today Simulation"].waitForExistence(timeout: 8))

        app.tabBars.buttons["Profile"].tap()
        XCTAssertTrue(app.staticTexts["Goals"].waitForExistence(timeout: 5))
        XCTAssertTrue(staticText(app, "Want a fresh start? Redo your race, goals, numbers and training days, and the coach plans a new week. Your logs, runs, streaks and coach chat stay.").waitForExistence(timeout: 5))
        tapWhenReady(app.buttons["Start a new plan"], in: app)

        // Pre-filled from the profile, the race goal and the best logged sets.
        XCTAssertTrue(app.staticTexts["Start over"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["New plan"].firstMatch.exists)
        // Profile's own race editor sits behind the sheet; this is the form's field.
        XCTAssertEqual(app.textFields["race-name-field"].value as? String, "Eiger Ultra 51K")
        XCTAssertTrue(app.buttons["Keep current"].isSelected)
        XCTAssertEqual(app.staticTexts["Pull-ups now"].value as? String, "8")
        XCTAssertEqual(app.staticTexts["Push-ups now"].value as? String, "28")
        XCTAssertEqual(app.staticTexts["Plank now"].value as? String, "1:35")
        XCTAssertTrue(app.staticTexts["Now is your best strict set from recent logs. Pick Retest to type new numbers."].exists)

        tapWhenReady(app.buttons["45 min"], in: app)
        XCTAssertTrue(app.buttons["45 min"].isSelected)
        tapWhenReady(app.buttons["new-plan-start-button"], in: app)
        let confirm = app.alerts["Start a new plan?"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        XCTAssertTrue(staticText(confirm, "Open sessions from today on are removed, also from your watch. Your logs, runs, readiness, streaks and coach chat stay.").exists)
        confirm.buttons["Start new plan"].tap()

        XCTAssertTrue(app.staticTexts["Waiting for the coach"].waitForExistence(timeout: 10))
        XCTAssertTrue(staticText(app, "Your new goals are saved and the old open sessions are gone. lockin can't reach the coach right now, so it asks again the next time you open the app. You can also plan the week from Coach.").exists)
        XCTAssertTrue(app.buttons["Try again"].exists)
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["start-new-plan-button"].waitForExistence(timeout: 5))

        // Log: history kept, the open sessions from today on are gone.
        app.tabBars.buttons["Log"].tap()
        XCTAssertTrue(app.staticTexts["Coming up"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Nothing planned yet. Your coach plans the week from Coach."].exists)
        XCTAssertFalse(app.staticTexts["Today Simulation"].exists)
        XCTAssertFalse(app.buttons["week-plan-row-Pull Capacity"].exists)
        XCTAssertTrue(app.staticTexts["Push + Core"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["No history yet."].exists)

        // Coach: the old read is cleared and waits for the next one.
        app.tabBars.buttons["Coach"].tap()
        XCTAssertTrue(app.staticTexts["Coach read"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Coach read needed"].exists)
        XCTAssertFalse(app.staticTexts["Back on track"].exists)

        // Progress: logged numbers and the race stay.
        app.tabBars.buttons["Progress"].tap()
        XCTAssertTrue(app.staticTexts["Progress"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Weekly distance"].exists)
        XCTAssertTrue(app.staticTexts["Missed"].exists)
    }

    func testTwoWeekSeedPreviewDataSurfaces() {
        let app = XCUIApplication()
        app.launchArguments = ["UITesting", "SeedTwoWeeksActivity"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Route"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["This week"].exists)
        XCTAssertFalse(app.staticTexts["CONSISTENCY"].exists)
        XCTAssertFalse(app.staticTexts["Rest day"].exists)
        XCTAssertFalse(app.buttons["save-run-feedback-button"].exists)
        XCTAssertTrue(app.staticTexts["Today Simulation"].exists)
        XCTAssertTrue(app.staticTexts["Pull-up"].exists)
        XCTAssertTrue(app.buttons["exercise-checkbox-unchecked"].exists)

        app.tabBars.buttons["Log"].tap()
        XCTAssertTrue(app.staticTexts["Coming up"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["History"].exists)
        XCTAssertTrue(app.staticTexts["Today Simulation"].exists)
        XCTAssertTrue(app.staticTexts["Core Control"].exists)
        XCTAssertTrue(app.staticTexts["Push + Core"].exists)
        XCTAssertFalse(app.staticTexts["No history yet."].exists)

        let futureWorkout = app.buttons["week-plan-row-Pull Capacity"]
        XCTAssertTrue(futureWorkout.waitForExistence(timeout: 5))
        futureWorkout.tap()
        XCTAssertTrue(app.staticTexts["Workout details"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Warm-up"].exists)
        XCTAssertTrue(app.staticTexts["Pull-up"].exists)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Opens on '")).firstMatch.exists)
        XCTAssertFalse(app.buttons["exercise-checkbox-unchecked"].exists)
        app.buttons["Done"].tap()

        app.tabBars.buttons["Progress"].tap()
        XCTAssertTrue(app.staticTexts["Progress"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Readiness"].exists)
        XCTAssertTrue(app.staticTexts["Weekly distance"].exists)
        // Longest run (6 weeks) from the confirmed seed long run; weekly sums are
        // weekday-dependent, so the stable longest-run value is asserted instead.
        // The decimal separator follows the simulator locale, so match both forms.
        let longestRun = app.staticTexts.matching(
            NSPredicate(format: "label MATCHES %@", "16[.,]4 km")
        ).firstMatch
        XCTAssertTrue(longestRun.exists)
        XCTAssertTrue(app.staticTexts["Missed"].exists)
        XCTAssertTrue(app.staticTexts["1"].exists)
        XCTAssertFalse(app.staticTexts["PENALTIES"].exists)
        XCTAssertFalse(app.buttons["Consistency details and benchmarks"].exists)

        app.tabBars.buttons["Coach"].tap()
        XCTAssertTrue(app.staticTexts["Coach read"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Back on track"].exists)
        XCTAssertTrue(app.staticTexts["Running"].exists)
        XCTAssertTrue(app.staticTexts["Strength"].exists)
        XCTAssertTrue(app.staticTexts["Next step"].exists)
        XCTAssertTrue(app.staticTexts["coach-read-updated-at"].exists)
        XCTAssertFalse(app.buttons["Read new session"].exists)

        app.tabBars.buttons["Log"].tap()
        XCTAssertTrue(app.staticTexts["Coming up"].waitForExistence(timeout: 5))
    }

    func testCoachChatAnswersSixConnectedQuestionsWithSeededTrainingData() throws {
        #if targetEnvironment(simulator)
        guard localCoachProxyIsReachable() else {
            throw XCTSkip("Start the local proxy at \(coachProxyHealthURL()?.absoluteString ?? "http://127.0.0.1:8787/health") to verify coach chat end to end.")
        }
        #endif

        let app = XCUIApplication()
        app.launchArguments = ["UITesting", "SeedTwoWeeksActivity", "RunCoachChatScript"]
        app.launchEnvironment["COACH_PROXY_ENDPOINT"] = coachProxyEndpoint()
        app.launch()

        app.tabBars.buttons["Coach"].tap()
        XCTAssertTrue(app.staticTexts["Coach read"].waitForExistence(timeout: 5))
        tapWhenReady(app.buttons["Chat"], in: app)
        XCTAssertTrue(app.textFields["coach-chat-input"].waitForExistence(timeout: 5))

        let status = app.staticTexts["coach-chat-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        let sixTurnsComplete = NSPredicate(format: "label == %@", "12 messages")
        expectation(for: sixTurnsComplete, evaluatedWith: status)
        waitForExpectations(timeout: 30)

        assertChatContains(app, "Keep going")
        assertChatContains(app, "one more honest")
        assertChatContains(app, "recent pain up to 4/10")
        assertChatContains(app, "Earlier you asked about your long-term schedule, your biggest improvement point, and fatigue")
        assertChatContains(app, "against the 80% standard")
        assertChatContains(app, "Keep shoulders warm before pull work")
    }

    func testProfileDebugSeedButtonLoadsDemoHistory() {
        let app = launchFreshApp()
        onboardDefault(app)

        app.tabBars.buttons["Profile"].tap()
        XCTAssertTrue(app.staticTexts["Goals"].waitForExistence(timeout: 5))
        tapWhenReady(app.buttons["seed-demo-history-button"], in: app)
        XCTAssertTrue(app.alerts["Replace with demo history?"].waitForExistence(timeout: 5))
        app.alerts["Replace with demo history?"].buttons["Seed demo history"].tap()

        app.tabBars.buttons["Coach"].tap()
        XCTAssertTrue(app.staticTexts["Coach read"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Back on track"].exists)
        XCTAssertTrue(app.staticTexts["coach-read-updated-at"].exists)
        XCTAssertFalse(app.buttons["Read new session"].exists)

        app.tabBars.buttons["Progress"].tap()
        XCTAssertTrue(app.staticTexts["Readiness"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Weekly distance"].exists)
    }

    private func launchFreshApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["UITesting"]
        app.launch()
        return app
    }

    private func onboardDefault(_ app: XCUIApplication) {
        XCTAssertTrue(app.buttons["Create profile"].waitForExistence(timeout: 5))
        tapWhenReady(app.buttons["Create profile"], in: app)
    }

    private func tapWhenReady(_ element: XCUIElement, in app: XCUIApplication) {
        var attempts = 0
        while !element.waitForExistence(timeout: 1) && attempts < 4 {
            app.swipeUp()
            attempts += 1
        }
        XCTAssertTrue(element.exists)

        attempts = 0
        while !element.isHittable && attempts < 4 {
            app.swipeUp()
            attempts += 1
        }
        XCTAssertTrue(element.isHittable)
        element.tap()
    }

    /// Exact-label lookup for copy longer than the 128-character limit of
    /// subscript queries.
    private func staticText(_ root: XCUIElement, _ label: String) -> XCUIElement {
        root.staticTexts.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func askCoach(_ app: XCUIApplication, _ question: String, expect expectedText: String) {
        let input = app.textFields["coach-chat-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        input.typeText(question)
        let sendButton = app.buttons["coach-chat-send-button"]
        XCTAssertTrue(sendButton.waitForExistence(timeout: 5))
        usleep(150_000)
        sendButton.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(textContaining(app, expectedText).waitForExistence(timeout: 15))
        waitForCoachTypingToFinish(app)
    }

    private func textContaining(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", text)).firstMatch
    }

    private func elementContaining(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] %@", text))
            .firstMatch
    }

    private func assertChatContains(
        _ app: XCUIApplication,
        _ text: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let element = elementContaining(app, text)
        if element.waitForExistence(timeout: 2) {
            return
        }

        let scrollView = app.scrollViews["coach-chat-scroll"]
        for _ in 0..<5 {
            if scrollView.exists {
                scrollView.swipeUp()
            } else {
                app.swipeUp()
            }
            if element.waitForExistence(timeout: 1) {
                return
            }
        }

        XCTFail("Expected coach chat to contain: \(text)", file: file, line: line)
    }

    private func waitForCoachTypingToFinish(_ app: XCUIApplication) {
        let typing = app.descendants(matching: .any)["coach-chat-typing"]
        if typing.exists {
            let gone = NSPredicate(format: "exists == false")
            expectation(for: gone, evaluatedWith: typing)
            waitForExpectations(timeout: 5)
        }
        usleep(150_000)
    }

    private func localCoachProxyIsReachable() -> Bool {
        guard let url = coachProxyHealthURL() else { return false }
        let expectation = XCTestExpectation(description: "local coach proxy health")
        var reachable = false
        URLSession.shared.dataTask(with: url) { _, response, _ in
            if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                reachable = true
            }
            expectation.fulfill()
        }.resume()
        _ = XCTWaiter.wait(for: [expectation], timeout: 2)
        return reachable
    }

    private func coachProxyHealthURL() -> URL? {
        var rawValue = coachProxyEndpoint()
        if !rawValue.contains("://") {
            rawValue = "http://\(rawValue)"
        }
        guard var components = URLComponents(string: rawValue) else { return nil }
        components.path = "/health"
        components.query = nil
        return components.url
    }

    private func coachProxyEndpoint() -> String {
        if let endpoint = usableProxyEndpoint(ProcessInfo.processInfo.environment["COACH_PROXY_ENDPOINT"]) {
            return endpoint
        }
        if let endpoint = usableProxyEndpoint(Bundle(for: type(of: self)).object(forInfoDictionaryKey: "CoachProxyEndpoint") as? String) {
            return endpoint
        }
        return "http://127.0.0.1:8787/generate-week-plan"
    }

    private func usableProxyEndpoint(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains("$(") else { return nil }
        return trimmed
    }
}
