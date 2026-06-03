import XCTest

final class FitnessAppUITests: XCTestCase {
    func testOnboardingScreenShowsGoalSetup() {
        let app = launchFreshApp()

        XCTAssertTrue(app.staticTexts["LOCKIN"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Create profile"].exists)
    }

    func testMainShellAndCoachGeneratorSurfaceAfterOnboarding() {
        let app = launchFreshApp()
        onboardDefault(app)

        XCTAssertTrue(app.staticTexts["No plan yet"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Open Coach and generate a strength week to populate Today and Log."].exists)
        XCTAssertFalse(app.navigationBars["Today"].exists)

        switchToTab("Coach", in: app)
        XCTAssertTrue(app.navigationBars["Coach"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Coach read"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Ready for the first week"].exists)
        XCTAssertTrue(app.buttons["Generate Strength Week"].exists)
        XCTAssertTrue(app.buttons["Generate Running Week"].exists)
        XCTAssertTrue(app.staticTexts["What I'll use"].exists)
    }

    func testLogShowsEmptyAIOnlyStateAfterOnboarding() {
        let app = launchFreshApp()
        onboardDefault(app)

        switchToTab("Log", in: app)
        XCTAssertTrue(app.staticTexts["Log"].waitForExistence(timeout: 5))
        XCTAssertTrue(waitForElement(app.staticTexts["OPEN ACTIVITIES"], in: app, swipes: 1))
        XCTAssertTrue(app.staticTexts["No open activities."].exists)
        XCTAssertTrue(waitForElement(app.staticTexts["SESSION HISTORY"], in: app, swipes: 2))
        XCTAssertTrue(app.staticTexts["No history yet."].exists)
        XCTAssertFalse(app.navigationBars["Log"].exists)
        XCTAssertFalse(app.staticTexts["DONE"].exists)
    }

    func testProgressAndConsistencyScreensAfterOnboarding() {
        let app = launchFreshApp()
        onboardDefault(app)

        switchToTab("Progress", in: app)
        XCTAssertTrue(app.staticTexts["Progress"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Progress"].exists)
        XCTAssertTrue(app.buttons["Strength"].exists)
        XCTAssertTrue(app.buttons["Running"].exists)
        XCTAssertFalse(app.buttons["History"].exists)
        let consistencyButton = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Consistency")).firstMatch
        tapWhenReady(consistencyButton, in: app)
        XCTAssertTrue(waitForElement(app.staticTexts["CONSISTENCY SCORE"], in: app, swipes: 2))
        XCTAssertTrue(app.staticTexts["Current Streak"].exists)
    }

    func testCoachReadAndAdvancedControlsAfterOnboarding() {
        let app = launchFreshApp()
        onboardDefault(app)

        switchToTab("Coach", in: app)
        XCTAssertTrue(app.navigationBars["Coach"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Coach read"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Ready for the first week"].exists)
        XCTAssertFalse(app.staticTexts["WEEK PLAN"].exists)
        XCTAssertFalse(app.buttons["Context"].exists)
        XCTAssertFalse(app.buttons["Rules"].exists)
        tapWhenReady(app.buttons["Coach Settings"], in: app)
        XCTAssertTrue(waitForElement(app.staticTexts["Model"], in: app, swipes: 3))
        XCTAssertTrue(app.staticTexts["Proxy status"].exists)
        XCTAssertFalse(app.textFields["Custom model ID"].exists)
        XCTAssertFalse(app.staticTexts["Technical checks"].exists)
    }

    func testProfileResetFlowUsesAIOnlyPlanCreation() {
        let app = launchFreshApp()
        onboardDefault(app)

        switchToTab("Profile", in: app)
        XCTAssertTrue(app.staticTexts["Profile"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Profile"].exists)
        XCTAssertFalse(app.staticTexts["Local fallback plan"].exists)
        XCTAssertFalse(app.buttons["Regenerate local fallback week"].exists)
        XCTAssertTrue(app.buttons["Request and schedule"].exists)
        tapWhenReady(app.buttons["Wipe all app data"], in: app)
        XCTAssertTrue(app.alerts["Wipe all app data?"].waitForExistence(timeout: 5))
        app.alerts["Wipe all app data?"].buttons["Wipe everything"].tap()
        XCTAssertTrue(app.staticTexts["LOCKIN"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Create profile"].exists)
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

    private func switchToTab(_ label: String, in app: XCUIApplication) {
        let tabButton = app.buttons[label].firstMatch
        tapWhenReady(tabButton, in: app, avoidFooter: false)
    }

    private func tapWhenReady(_ element: XCUIElement, in app: XCUIApplication, avoidFooter: Bool = true) {
        XCTAssertTrue(element.waitForExistence(timeout: 5))
        var attempts = 0
        while shouldScrollForTap(element, in: app, avoidFooter: avoidFooter) && attempts < 8 {
            app.swipeUp()
            attempts += 1
        }
        XCTAssertTrue(element.isHittable)
        element.tap()
    }

    private func shouldScrollForTap(_ element: XCUIElement, in app: XCUIApplication, avoidFooter: Bool) -> Bool {
        if !element.isHittable {
            return true
        }
        guard avoidFooter else {
            return false
        }
        let footerIsVisible = app.buttons["Today"].exists && app.buttons["Profile"].exists
        guard footerIsVisible else {
            return false
        }
        return element.frame.maxY > app.frame.maxY - 130
    }

    private func waitForElement(_ element: XCUIElement, in app: XCUIApplication, swipes: Int) -> Bool {
        if element.waitForExistence(timeout: 2) {
            return true
        }
        for _ in 0..<swipes {
            app.swipeUp()
            if element.waitForExistence(timeout: 1) {
                return true
            }
        }
        return element.exists
    }
}
