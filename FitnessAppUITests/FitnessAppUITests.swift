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
        XCTAssertTrue(app.buttons["confirm-run-button"].waitForExistence(timeout: 8))
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
        XCTAssertTrue(app.staticTexts["Session history"].waitForExistence(timeout: 5))
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
        XCTAssertTrue(app.staticTexts["Week schedule"].waitForExistence(timeout: 5))
        snap(app, "11-profile-top", in: directory)
        app.swipeUp()
        snap(app, "12-profile-middle", in: directory)
        app.swipeUp()
        snap(app, "13-profile-bottom", in: directory)

        // Back to Today for the interactive flows.
        app.tabBars.buttons["Today"].tap()
        sleepBriefly()

        // Edit pending run -> LogRunView sheet.
        let editRun = app.buttons["edit-run-details-button"]
        if editRun.waitForExistence(timeout: 5) {
            editRun.tap()
            XCTAssertTrue(app.buttons["save-run-button"].waitForExistence(timeout: 5))
            snap(app, "14-log-run-sheet", in: directory)
            app.buttons["Cancel"].tap()
            sleepBriefly()
        }

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

        XCTAssertTrue(app.images["lockin-wordmark"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Create profile"].exists)
    }

    func testMainShellAndCoachGeneratorSurfaceAfterOnboarding() {
        let app = launchFreshApp()
        onboardDefault(app)

        XCTAssertTrue(app.staticTexts["No AI plan yet"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Open Coach and generate an AI week to populate Today and Log."].exists)
        XCTAssertFalse(app.navigationBars["Today"].exists)

        app.tabBars.buttons["Coach"].tap()
        XCTAssertTrue(app.navigationBars["Coach"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Coach read"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Ready for the first week"].exists)
        XCTAssertTrue(app.buttons["Plan my week"].exists)
        // Coach inputs moved behind Advanced; the main surface stays focused
        // on the read and the one primary action.
        XCTAssertFalse(app.staticTexts["What I'll use"].exists)
    }

    func testLogShowsEmptyAIOnlyStateAfterOnboarding() {
        let app = launchFreshApp()
        onboardDefault(app)

        app.tabBars.buttons["Log"].tap()
        XCTAssertTrue(app.staticTexts["Log"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["OPEN ACTIVITIES"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["No open activities."].exists)
        XCTAssertTrue(app.staticTexts["Session history"].waitForExistence(timeout: 5))
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
        XCTAssertTrue(app.staticTexts["STREAK"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["BEST"].exists)
        XCTAssertTrue(app.staticTexts["MISSED TRAININGS"].exists)
        XCTAssertTrue(app.staticTexts["PULL-UPS"].waitForExistence(timeout: 5))
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
        XCTAssertTrue(app.staticTexts["Profile"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Profile"].exists)
        XCTAssertFalse(app.staticTexts["Local fallback plan"].exists)
        XCTAssertFalse(app.buttons["Regenerate local fallback week"].exists)
        XCTAssertTrue(app.staticTexts["Week schedule"].waitForExistence(timeout: 5))
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
        XCTAssertTrue(app.switches["Enabled"].exists)
        XCTAssertTrue(app.datePickers["reminder-time-picker"].exists)
        XCTAssertFalse(app.buttons["Request and schedule"].exists)
        tapWhenReady(app.buttons["Wipe all app data"], in: app)
        XCTAssertTrue(app.alerts["Wipe all app data?"].waitForExistence(timeout: 5))
        app.alerts["Wipe all app data?"].buttons["Wipe everything"].tap()
        XCTAssertTrue(app.images["lockin-wordmark"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Create profile"].exists)
    }

    func testTwoWeekSeedPreviewDataSurfaces() {
        let app = XCUIApplication()
        app.launchArguments = ["UITesting", "SeedTwoWeeksActivity"]
        app.launch()

        XCTAssertTrue(app.staticTexts["STREAK"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["BEST"].exists)
        XCTAssertFalse(app.staticTexts["CONSISTENCY"].exists)
        XCTAssertFalse(app.staticTexts["No session due today"].exists)
        // The seeded pending Garmin run renders a confirm card above the due session.
        XCTAssertTrue(app.buttons["confirm-run-button"].exists)
        XCTAssertTrue(app.staticTexts["Today Simulation"].exists)
        XCTAssertTrue(app.staticTexts["Pull-up"].exists)
        XCTAssertTrue(app.buttons["exercise-checkbox-unchecked"].exists)

        app.tabBars.buttons["Log"].tap()
        XCTAssertTrue(app.staticTexts["OPEN ACTIVITIES"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Session history"].exists)
        XCTAssertTrue(app.staticTexts["Today Simulation"].exists)
        XCTAssertTrue(app.staticTexts["Core Control"].exists)
        XCTAssertTrue(app.staticTexts["Push + Core"].exists)
        XCTAssertFalse(app.staticTexts["No history yet."].exists)

        let futureWorkout = app.buttons["week-plan-row-Pull Capacity"]
        XCTAssertTrue(futureWorkout.waitForExistence(timeout: 5))
        futureWorkout.tap()
        XCTAssertTrue(app.staticTexts["Workout details"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Workout preview"].exists)
        XCTAssertTrue(app.staticTexts["Warm-up"].exists)
        XCTAssertTrue(app.staticTexts["Pull-up"].exists)
        XCTAssertTrue(app.staticTexts["Available to log on the scheduled day."].exists)
        XCTAssertFalse(app.buttons["exercise-checkbox-unchecked"].exists)
        app.buttons["Done"].tap()

        app.tabBars.buttons["Progress"].tap()
        XCTAssertTrue(app.staticTexts["Progress"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Readiness"].exists)
        XCTAssertTrue(app.staticTexts["RUNNING"].exists)
        // Longest run (6 weeks) from the confirmed seed long run; weekly sums are
        // weekday-dependent, so the stable longest-run value is asserted instead.
        // The decimal separator follows the simulator locale, so match both forms.
        let longestRun = app.staticTexts.matching(
            NSPredicate(format: "label MATCHES %@", "16[.,]4 km")
        ).firstMatch
        XCTAssertTrue(longestRun.exists)
        XCTAssertTrue(app.staticTexts["MISSED TRAININGS"].exists)
        XCTAssertTrue(app.staticTexts["1"].exists)
        XCTAssertFalse(app.staticTexts["PENALTIES"].exists)
        XCTAssertFalse(app.buttons["Consistency details and benchmarks"].exists)

        app.tabBars.buttons["Coach"].tap()
        XCTAssertTrue(app.staticTexts["Coach read"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Back on track"].exists)

        app.tabBars.buttons["Log"].tap()
        XCTAssertTrue(app.staticTexts["OPEN ACTIVITIES"].waitForExistence(timeout: 5))
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
}
