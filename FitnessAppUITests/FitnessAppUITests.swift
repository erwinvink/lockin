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
        XCTAssertTrue(app.staticTexts["Coach read"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Ready for the first week"].exists)
        XCTAssertTrue(app.buttons["Generate AI week"].exists)
        XCTAssertTrue(app.staticTexts["What I'll use"].exists)
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
        XCTAssertTrue(app.staticTexts["Model"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Proxy status"].exists)
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
        app.swipeUp()
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
