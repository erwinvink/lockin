import XCTest

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
        XCTAssertTrue(app.staticTexts["Plan generator"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Generate AI week"].exists)
        XCTAssertFalse(app.staticTexts["Ready to refresh the next 7 days."].exists)
    }

    func testLogShowsEmptyAIOnlyStateAfterOnboarding() {
        let app = launchFreshApp()
        onboardDefault(app)

        app.tabBars.buttons["Log"].tap()
        XCTAssertTrue(app.staticTexts["Log"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Session history"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["No sessions yet."].exists)
        XCTAssertFalse(app.navigationBars["Log"].exists)
        XCTAssertFalse(app.staticTexts["DONE"].exists)
    }

    func testProgressAndRanksScreensAfterOnboarding() {
        let app = launchFreshApp()
        onboardDefault(app)

        app.tabBars.buttons["Progress"].tap()
        XCTAssertTrue(app.staticTexts["Progress"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Progress"].exists)
        XCTAssertTrue(app.staticTexts["PULL-UPS"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["XP"].exists)
        XCTAssertTrue(app.staticTexts["PENALTIES"].exists)
        XCTAssertFalse(app.buttons["History"].exists)
        tapWhenReady(app.buttons["Rank details and benchmarks"], in: app)
        XCTAssertTrue(app.navigationBars["Ranks"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Real-world anchors"].waitForExistence(timeout: 5))
        app.navigationBars["Ranks"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.staticTexts["Progress"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Progress"].exists)
    }

    func testCoachTabsAfterOnboarding() {
        let app = launchFreshApp()
        onboardDefault(app)

        app.tabBars.buttons["Coach"].tap()
        XCTAssertTrue(app.navigationBars["Coach"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Plan generator"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["WEEK PLAN"].exists)
        tapWhenReady(app.buttons["Context"], in: app)
        XCTAssertTrue(app.staticTexts["Privacy & architecture"].waitForExistence(timeout: 5))
        tapWhenReady(app.buttons["Rules"], in: app)
        XCTAssertTrue(app.staticTexts["Local safety checks"].waitForExistence(timeout: 5))
    }

    func testProfileResetFlowUsesAIOnlyPlanCreation() {
        let app = launchFreshApp()
        onboardDefault(app)

        app.tabBars.buttons["Profile"].tap()
        XCTAssertTrue(app.staticTexts["Profile"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars["Profile"].exists)
        XCTAssertFalse(app.staticTexts["Local fallback plan"].exists)
        XCTAssertFalse(app.buttons["Regenerate local fallback week"].exists)
        XCTAssertTrue(app.buttons["Request and schedule"].exists)
        tapWhenReady(app.buttons["Wipe all app data"], in: app)
        XCTAssertTrue(app.alerts["Wipe all app data?"].waitForExistence(timeout: 5))
        app.alerts["Wipe all app data?"].buttons["Wipe everything"].tap()
        XCTAssertTrue(app.images["lockin-wordmark"].waitForExistence(timeout: 5))
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

    private func tapWhenReady(_ element: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(element.waitForExistence(timeout: 5))
        var attempts = 0
        while !element.isHittable && attempts < 3 {
            app.swipeUp()
            attempts += 1
        }
        XCTAssertTrue(element.isHittable)
        element.tap()
    }
}
