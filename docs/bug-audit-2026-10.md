# lockin bug audit — October 2026

Read-only audit of the iOS app (`FitnessApp/`), the coach proxy (`Proxy/src`) and the Garmin sidecar (`GarminService/`), done on 2026-10-17 against `8d60972` (branch `codex/coach-chat-garmin-reliability`). Nothing was fixed or committed; UI and styling files were not touched because a redesign is in progress.

Each bug lists where it is, how it goes wrong, how bad it is, a suggested fix, and how sure the finding is:

- **Confirmed**: the failing path was traced end to end in the code, or a test fails.
- **Suspected**: the code allows it, but it depends on runtime timing, server behaviour or platform behaviour that was not reproduced.

Severity is one of **crash**, **data loss**, **wrong behaviour** or **cosmetic**. Within each severity, the bugs with the most day-to-day impact come first.

IDs: **C/D/W/X/L** are iOS findings, **S** are proxy and Garmin sidecar findings.

## Fix status (2026-10-20)

All 38 findings are fixed on branch `fix/bug-audit-2026-10`. Each fix has a regression test, except where noted. A second review of the fixes found 12 follow-up issues (among them a `userId` path traversal into the Garmin token folder and a reconnect regression), and those are fixed too. Nothing is deployed.

Final test runs: iOS unit 172/172, iOS UI 8 passed and 3 skipped (baseline: 2 failing), Proxy 228/228 with `tsc` clean, GarminService 82/82.

| ID | Fix | Test |
|---|---|---|
| C1 | A store that is present and readable but can't be opened (damaged, unmigratable) is moved to `default.store.unreadable-<time>`, journal files first, and a fresh store opens; RootView shows a one-time notice with the backup path. A store that can't be read (file protection, permissions) or a full disk is left alone and the error is rethrown. | `testUnreadableStoreIsMovedAsideAndReplaced`, `testUnreadableStoreFileIsLeftInPlace` |
| C2 | App-active planning builds its request with a fresh fetch after the awaited replan (`makeCoachRequestFromStore`). | covered by the request builders' tests; view wiring not unit-tested |
| S1 | The scheduler tick never rejects; a corrupt state file is backed up and read as empty. | `auto-plan.test.ts` (2) |
| D0 | The app sends `lockedThroughDate`; the proxy never deletes a synced workout dated today or earlier just because it wasn't resent, and drops past records from its state (without deleting them on Garmin) so counts stay right. | `testGarminSyncPlanRequestLocksTodayAndOnlySendsFutureRuns`, `garmin-sync.test.ts` (3) |
| D1 | Replans always cut off at tomorrow, so today's sessions and watch workout stay. The old test asserting the opposite was removed. | `testPersistAIPlanKeepsTodayPlannedSessionAfterTrainingIsDone` |
| S2 | The sidecar lists failed metrics in `unavailableMetrics`; the proxy treats them and 0 as missing; the app never overwrites a stored reading with them or with 0. | `testIngestWellnessSkipsUnavailableMetricsAndKeepsStoredValues`, sidecar (7), proxy enrichment tests |
| S3 | A changed run never adopts the Garmin id it is deleting. | `garmin-sync.test.ts` (2) |
| D2 | Logging goes through `recordStrengthLog`, which rolls back on a failed save; the sheet stays open with the error. | rollback path not unit-tested |
| W1 | "Log run" on Today (manual `RunLog`, scored like Garmin; a "very weak" feel is a deload even when the run was cut short), "Rate" on Garmin runs in Log; a later Garmin activity replaces the manual row and keeps RPE, feel and notes, and upgrades a manual partial to full credit; manual runs count as volume unless Garmin has a run that day. | `testRecordManualRun…` (2), `testGarminActivityReplacesManualRunLogAndKeepsAthleteRating`, `testRateRunStoresRPEAndFeelAndDeloadsOnVeryWeak`, `testShortManualRunWithVeryWeakFeelIsDeload`, `testConfirmedRunLogsDropManualRowWhenGarminHasThatDay`, `testGarminUpgradeOfManualPartialRunAddsMissingCredit` |
| W2 | Background Garmin sync no longer waits for the Profile flag; it backs off 10 minutes after a failed attempt and clears the flag when Garmin is logged out. | `testGarminSyncAttemptThrottle` |
| S4 | A session is due once its day has passed, or as soon as it is finished today; today's open sessions are `pendingToday`, outside the score. | `build-coach-context.test.ts` (3) |
| W3 | The actual-RPE slider starts at the planned RPE (runs: 4 easy, 7 hard). | `testInitialLoggedRPEStartsAtPlannedRPE` |
| W4 | Yesterday's unlogged sessions stay on Today; logging a missed one refunds the miss. | `testLateLoggableSessions…`, `testRecordStrengthLogOnMissedSession…` |
| S5 | Optional `LOCKIN_APP_TOKEN` (the app sends `X-Lockin-App-Token` from the `COACH_PROXY_APP_TOKEN` build setting); Garmin routes need a UUID `userId`, and the sidecar rejects any id outside `[A-Za-z0-9_-]` and any token path outside `tokens/users/`; model allow-list; `/v1` refuses the default secret in production; tokens expire after 180 days. | `testCoachClientSendsAppTokenWhenConfigured`, `app-auth`, `garmin-routes`, `model-selection`, `lockin-auth` tests |
| W6 | Server plans are checked on the device for structure (days 1–6, selected days only, known exercises and run kinds) before they replace the schedule. | `testGeneratedPlanStructureMustRespectSelectedDays` |
| S6 | "Has running days" comes from `runningDays`; selected days with none left this week mean zero runs; an empty selection means any day. | `validate-running-week.test.ts` (4) |
| S7 | The earned-progression check is skipped when no session can be scheduled. | `validate-week-plan.test.ts` |
| S8 | A missed nightly run is caught up on app open; `nextRetryAt` retries run, with the failure budget reset per new trigger, and an app open doesn't cancel a pending retry; OpenAI calls time out after 5 minutes and a `generating` state older than 30 minutes is recovered. | `auto-plan.test.ts` (5) |
| S9 | Chat keywords match at word starts; weather needs whole words. | `chat.test.ts` (2) |
| S10 | Long coach messages in history are shortened, not rejected; answers are capped at 1200 characters. | `chat.test.ts` (2) |
| W5 | One `CoachReadRefresher`: retried on app open when the flag is set (at most every 10 minutes); "Sync now" refreshes the read like the background sync. | `testCoachReadRefreshIsDueWhenRetryFlagIsSet` |
| W11 | After a pain or "very weak" log, if no new plan lands, the next planned strength session is deloaded on the device (once). | `testLocalDeloadScalesNextPlannedStrengthSessionOnce` |
| W7 | Changing training days, running days, the long-run day or the race goal (including edits) triggers one forced replan when leaving Profile (or on the next app open); it is asked again until the proxy has answered. | `testPlanRefreshRequestIsConsumedOnce`, `testPlanRefreshRetriesOnlyWhenTheProxyWasNotReached` |
| S11 | The sidecar tags workouts with `lockin:<sessionId>:<fingerprint>` and reuses a tagged workout instead of creating a duplicate; pushes are serialised per user. Not checked live: whether Garmin's workout list returns `description`. | sidecar tests |
| S12 | Enrichment fetches 2 days, caches 10 minutes per user, and logs when Garmin data is missing. | `garmin-enrichment.test.ts` |
| S13 | Warm-up and cool-down distance come out of the main step for hard runs. | `test_garmin_mapping.py` |
| W8 | Stale watch ids are queued on the device until sent; an overlapping plan sync loops once more, and a Profile "Retry" that overlapped a new plan pushes it right after. | `testGarminStaleWorkoutQueueKeepsIdsUntilSent` |
| W9 | One reminder per day for sessions still planned; reminders are rebuilt after logs, Garmin syncs, replans and the missed sweep. | `testWorkoutReminderRequestsSkipDoneSessionsAndMergeSameDay` |
| W10 | Reset clears the plan throttle; a profile with no sessions gets one forced first plan (once the proxy has answered, never again for that profile, so a failed or empty first plan can't trigger an OpenAI call on every app open). | `testAutoPlanForcesFirstPlanOncePerProfile` |
| S14 | MFA connect keeps the pending login 5 minutes (without the password) and finishes it with `resume_login`. `/connect` always does a fresh credential login, so expired tokens no longer block reconnecting and a wrong password never "connects". Not checked against a live Garmin account. | sidecar tests |
| S15 | With the request's `timeZone`, "today" ends at the next local midnight. | `build-coach-context.test.ts` |
| X1 | Deload logs no longer create `CoachPlan` rows; "Latest AI plan" only looks at AI plans. | `testLatestAIPlanIgnoresRulePlans`, strength-log test |
| X2 | The plan button says when planning is busy and shows the real error text. | not unit-tested |
| X3 | Coach replies get device time, never sorting above the question. | not unit-tested |
| X4 | Readiness sliders handle VoiceOver adjust actions directly. | not unit-tested |
| X5 | Progress hides readiness older than yesterday. | `testFreshReadinessSnapshotIgnoresStaleDays` |
| L1 | Save is disabled while saving, and a second log of the same session is refused. | strength-log test |
| L2 | The local planner schedules exactly the selected days. | `testGenerateWeekWithOneSelectedDayPlansOnlyThatDay` |

Also fixed: `GarminService/test_main.py::test_login_cooldown_blocks_immediate_retry` only passed with real token files in `GarminService/tokens`; it now uses a temporary folder.

Default coach model is now `gpt-6.1-sol` (proxy default, allow-list and iOS catalog). The app moves a stored model choice to it once after the update.

## Where to start

1. **Protect today's plan and the watch:** D0 and D1. Every run-day morning the watch workout disappears today, and a replan after a finished session deletes the rest of the day.
2. **Stop false misses:** W1, W2 and W4. Runs need a manual completion path, background Garmin sync shouldn't depend on visiting Profile, and late strength logs need a grace day.
3. **Make the coach read honest:** S4, W3 and S2. Today's session counts against adherence from midnight, the default RPE fakes "harder than planned", and one Garmin hiccup turns wellness values into 0.
4. **Lock down the public proxy:** S5. The owner's Garmin data and OpenAI key are reachable without credentials.

## Summary, most severe first

| # | ID | Severity | Status | Bug |
|---|---|---|---|---|
| 1 | C1 | crash | suspected | A store that can't be opened crashes every launch, and the fallback retries the same store |
| 2 | C2 | crash | suspected | App-active auto-plan reads `@Query` models the same task may just have deleted |
| 3 | S1 | crash | confirmed path, rare | Auto-plan state file read error becomes an unhandled rejection and the proxy exits |
| 4 | D0 | data loss | confirmed (probed) | Any plan sync on a run day deletes today's run from the watch |
| 5 | D1 | data loss | confirmed | A replan after any completed session today deletes the rest of today's plan |
| 6 | S2 | data loss | confirmed (traced) | One Garmin hiccup turns a wellness metric into 0, which overwrites the stored value |
| 7 | S3 | data loss | confirmed (probed) | Sync deletes a changed workout and marks the same id as synced |
| 8 | D2 | data loss | confirmed | A failed log save is silently dropped and the sheet closes anyway |
| 9 | W1 | wrong behaviour | confirmed | Runs can't be completed without Garmin, so they all turn into misses |
| 10 | W2 | wrong behaviour | confirmed | Background Garmin sync only runs after Profile has set a flag |
| 11 | S4 | wrong behaviour | confirmed (probed) | Today's planned session counts as missed from midnight, so the coach says "Watch" |
| 12 | W3 | wrong behaviour | confirmed | Logged RPE defaults to 7, so light sessions look "above plan" |
| 13 | W4 | wrong behaviour | confirmed | A strength session can't be logged after midnight and is marked missed |
| 14 | S5 | wrong behaviour (security) | confirmed in code | Proxy routes have no authentication: owner's Garmin data, any OpenAI model, hardcoded secret |
| 15 | W6 | wrong behaviour | confirmed | On-device plan validation is dead code, so server plans are saved unchecked |
| 16 | S6 | wrong behaviour | confirmed (probed) | Running validator accepts runs on non-running days when this week has none left |
| 17 | S7 | wrong behaviour | confirmed (probed) | Strength validator rejects a correct zero-session week (422) |
| 18 | S8 | wrong behaviour | confirmed | A missed nightly plan is never caught up; `nextRetryAt` is never read; a crash during generation leaves the user stuck |
| 19 | S9 | wrong behaviour | confirmed (probed) | Chat gives the "no weather" answer to anything containing "train" |
| 20 | S10 | wrong behaviour | confirmed (probed) | Chat breaks for good after one pain answer longer than 1200 characters |
| 21 | W5 | wrong behaviour | confirmed | Coach-read retry flag is written but never read; "Sync now" never refreshes the read |
| 22 | W11 | wrong behaviour | confirmed | "Next work auto-deloaded" is not done on the device |
| 23 | W7 | wrong behaviour | suspected | Changing training days doesn't replan or move reminders |
| 24 | S11 | wrong behaviour | suspected | A push timeout can leave duplicate workouts on the watch |
| 25 | S12 | wrong behaviour | suspected | Coach requests usually go out without Garmin readiness (10 s budget for 29 calls) |
| 26 | S13 | wrong behaviour | confirmed in code | Hard-run watch workouts are about 15 minutes longer than planned |
| 27 | W8 | wrong behaviour | suspected | A Garmin sync started while another is running drops the stale ids (cleaned up late) |
| 28 | W9 | wrong behaviour | confirmed | Reminders still fire for sessions that are already done |
| 29 | W10 | wrong behaviour | confirmed | After "Wipe all data" the first plan can wait 30 minutes |
| 30 | S14 | wrong behaviour | suspected | Garmin MFA connect starts a new login, so an emailed code likely fails |
| 31 | S15 | wrong behaviour | confirmed (probed) | On the spring-forward day, tomorrow's session is reported as today |
| 32 | X1 | cosmetic | confirmed | Deload records show as "Latest AI plan" |
| 33 | X2 | cosmetic | confirmed | Plan-request errors and the busy state are hidden behind one generic message |
| 34 | X3 | cosmetic | suspected | Chat can sort the answer above the question when clocks differ |
| 35 | X4 | cosmetic | suspected | Readiness sliders may not save VoiceOver changes |
| 36 | X5 | cosmetic | confirmed | Progress shows old Garmin readiness as if current |
| 37 | L1 | low | suspected | A double tap on "Save log" can log the session twice |
| 38 | L2 | low | confirmed, dead code | Local fallback planner puts a session on a rest day when only one day is selected |

## Test results

| Suite | Command | Result |
|---|---|---|
| iOS unit + UI tests | `xcodebuild test -scheme FitnessApp` | **Not run.** Every `xcodebuild` / `xcrun simctl` call stops with "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license'". Accepting needs `sudo`, so it was left alone. |
| Proxy | `npm test` | 169 / 169 pass |
| Proxy | `npx tsc --noEmit` | clean |
| GarminService | `.venv/bin/python -m pytest` (caches off) | 47 / 47 pass |

All green suites mean the bugs below sit in paths the tests don't cover, or in behaviour the tests assert on purpose (noted where that is the case).

## README product rules vs. the code

| Rule | Verdict | Details |
|---|---|---|
| Today stays locked during week refreshes | **Broken** | The app keeps today's sessions, but any plan sync on a run day deletes today's watch workout ([D0](#d0)). Once any session today is done, a replan also deletes the rest of today's planned sessions ([D1](#d1)). A unit test asserts D1 on purpose, so that part is a product decision to settle. |
| AI sessions only land on selected future training days | **Enforced only by the proxy, which has a gap for runs** | [W6](#w6) — the on-device validators are never called, and the app only guards "tomorrow or later". The proxy's running check lets runs through on any day when this week has no running day left (S6). |
| Planned effort stays separate from the logged RPE | **Stored separately, but the actual RPE defaults to 7** | [W3](#w3) — saving without touching the slider logs RPE 7, so a light session looks like "effort above plan". |
| Streak, missed and deload logic is correct | **Partly** | Streak is recomputed from session history and is correct. Missed is too strict for strength ([W4](#w4)) and hits every run when Garmin isn't syncing ([W1](#w1)). The "next work auto-deloaded" promise is not kept locally ([W11](#w11)). |
| Garmin runs auto-match to planned runs | **Works, with gaps** | Matching is same-day and distance-based and refunds a wrongly applied miss. But the background sync only runs once Settings has set a flag ([W2](#w2)). The README says matched runs become "pending logs the athlete confirms", but the code completes them immediately and there is no way to add RPE or feel to a run ([W1](#w1)). |

---

## iOS app

### Crash

#### C1. A store that can't be opened crashes the app at launch, with no recovery — suspected

- **Where:** `FitnessApp/FitnessApp.swift:38-40`, `FitnessApp/Persistence.swift:37-42`
- **Scenario:** `ModelContainerFactory.make` tries the store and, on failure, retries with a "local" configuration. With CloudKit off (the default unless `EnableCloudKit` is passed) that retry is the same configuration and the same store file, so it fails the same way, and `FitnessApp.init` calls `fatalError`. A store that can't be migrated or is damaged therefore crashes the app on every launch until it is deleted. The `tmp-phone-store-backup-20260704/default.store.repaired` files in the repo suggest this has already happened once on the phone.
- **Fix:** On failure, move the store files aside (keep a timestamped backup), open a fresh store and show a "data was reset, backup kept" notice. Only retry with a different configuration when it really differs.

#### C2. App-active auto-plan reads model objects that the same task may just have deleted — suspected

- **Where:** `FitnessApp/AppShellView.swift:146-158`
- **Scenario:** `syncAutoPlanIfDue` first awaits `AutoPlanCoordinator.applyLatestServerPlan`, which can delete future `WorkoutSession`, `WorkoutBlock` and `SetPrescription` rows and save. It then builds `makeCoachRequest` from the view's `@Query` arrays (`sessions`, `prescriptions`, `logs`, `runLogs`). Those may still hold the deleted instances. Reading attributes of a deleted SwiftData model can trap ("backing data was detached"). At best the request carries the replaced plan. `refreshCoachReadAfterTraining` in the same file refetches for exactly this reason; this path doesn't.
- **Fix:** After the `await`, refetch sessions, prescriptions, logs, run logs and the race goal with `modelContext.fetch` before building the request.

### Data loss

<a id="d0"></a>
#### D0. Every plan sync on a run day deletes today's run from the watch — confirmed (traced in app and proxy, probed on the proxy)

- **Where:** `FitnessApp/CoachClient.swift:73-84` (`futurePlannedRunsForGarmin` leaves today out on purpose), `:187-193` (sync after every applied plan), `Proxy/src/garmin/garmin-sync.ts:127-133` (`mergePlanIntoState` deletes every recorded workout whose session is not in the request)
- **Scenario:** On day N−1 the run planned for day N is in the future, so it is pushed and the proxy records it in `user.workouts`. The proxy's nightly job builds a new plan every night (`Proxy/src/coach/auto-plan.ts:313-316` only skips when the local date and context hash both repeat). On the morning of day N the app applies that plan (`applyLatestServerPlan`) and calls `syncPlannedRuns`. The "desired workouts" it sends are runs from tomorrow on, because the comment says today's run "is locked during replans, so an existing watch workout stays valid". The proxy reads it the other way: today's session is not desired, so it queues the workout for deletion and marks it `deleted`. The athlete's structured workout for today disappears from the watch and from Garmin Connect, normally before they run. Post-training and manual replans on a run day do the same.
- **Fix:** Pick one contract. Either the app includes today's planned run in `workouts` (marked "keep", with its existing id) so the proxy keeps it, or the proxy never deletes records whose `payload.date` is today or earlier, using the user's time zone. Add a test on each side for "replan on a run day keeps today's watch workout".

<a id="d1"></a>
#### D1. A replan after any completed session today deletes the rest of today's plan, including today's run on the watch — confirmed

- **Where:** `FitnessApp/TrainingPlanStore.swift:822-832` (the cutoff), `:777-786` (new sessions only from tomorrow), `FitnessApp/LogWorkoutView.swift:187` (post-training trigger), `FitnessApp/CoachClient.swift:171,187-193` (stale ids pushed for deletion)
- **Scenario:** On a hybrid day with a strength session and a run, the athlete logs the strength session in the morning. `queueAutoPlanAfterTraining` triggers a `post_training` auto-plan. The proxy regenerates on pain, fatigue or RPE ≥ 9, or on an RPE delta of 2 or more, which [W3](#w3) makes common (`Proxy/src/coach/auto-plan.ts:330-355`). When it returns a new plan, `deleteFuturePlannedSessions` sees `hasCompletedTrainingToday == true` and moves the cutoff from tomorrow to today. It deletes every still-planned session today, across disciplines, so today's planned run is deleted. `shouldPersistGeneratedSession` then refuses to add anything for today. The deleted run's `garminWorkoutId` goes into `stalePushedIds`, and the proxy deletes the workout from the watch. Today's run vanishes from Today, Log and the watch. The same happens when last night's plan is applied after a morning run has already been completed by Garmin: today's strength session is deleted.
- **Note:** `FitnessAppTests/PersistenceResetTests.swift:210` (`testPersistAIPlanRemovesStaleTodayPlannedSessionAfterTrainingIsDone`) asserts this on purpose. It contradicts the README rule "keep today locked during week refreshes", so it needs a product decision, not just a code fix.
- **Fix:** Always use tomorrow as the replacement cutoff, so today is never touched by a refresh. If leftover sessions must be cleared, limit that to the same discipline as the completed session and never send today's run as stale to Garmin. Update the test to match the decision.

#### D2. A failed log save is silently dropped, and the sheet closes as if it worked — confirmed

- **Where:** `FitnessApp/LogWorkoutView.swift:184-191`
- **Scenario:** `save()` inserts the `PerformanceLog`, flips the session to completed or deload and updates `RankState`. If `modelContext.save()` throws, the `catch` does nothing and `dismiss()` runs anyway. The unsaved changes stay in the main context until the next `rollback()`. `performGarminSync`, `AutoPlanCoordinator.saveAtomically` and the reconcile step in `AppShellView.refreshTrainingPlanState` all roll back the whole context on any error, so a later failed Garmin sync quietly erases the workout log the athlete thinks is saved.
- **Fix:** On failure, call `modelContext.rollback()`, keep the sheet open and show the error so the athlete can retry.

### Wrong behaviour

<a id="w1"></a>
#### W1. Runs can't be completed without Garmin, so they all turn into misses — confirmed

- **Where:** `FitnessApp/TodayView.swift:95-99` (`RunPrescriptionCard` has no action), `FitnessApp/CalendarView.swift:146-154` (the preview is read-only), `FitnessApp/TrainingPlanStore.swift:98-104` (missed sweep), `:493-494` (Garmin logs always get `rpe = 0` and `feelScore = 3`)
- **Scenario:** No screen can mark a run done or log it by hand. There is no manual `RunLog` creation anywhere in the app outside the debug seed. A run only completes when the Garmin sync matches it. This fails when Garmin isn't connected, the background sync is off ([W2](#w2)), the sidecar is down, the watch wasn't worn, or the run covered less than 30% of the planned distance. In each case the run is marked missed one day later: −12 consistency, +25 penalty points, and a broken streak. Garmin-matched runs also can't get an RPE or "how it felt", so the run feel that should trigger a deload (`testVeryWeakRunFeelTriggersDeloadScoring`) can never come from real use. The README still describes a "pending log the athlete confirms" flow that no longer exists.
- **Fix:** Add a "Log run" action on run cards in Today and Log. It should write a manual `RunLog` and set completed or partial status through the same scoring path. Let the athlete add RPE and feel to a Garmin-completed run. Update the README.

<a id="w2"></a>
#### W2. Background Garmin sync waits for a flag that only the Settings screen sets — confirmed

- **Where:** `FitnessApp/AppShellView.swift:91`, `FitnessApp/SettingsView.swift:654,687` (the only places it is set to true), `:195,207,716` (cleared)
- **Scenario:** `syncGarminIfDue` returns early unless `@AppStorage("garminConnectionActive")` is true. Only the Garmin card in Profile sets it, after loading status or connecting. The README's setup is a one-time server-side `python main.py login`. If the athlete never opens Profile after a fresh install, or after "Wipe all data" (which sets it to false), the background sync never runs and every run falls into [W1](#w1).
- **Fix:** Have `AppShellView` fetch `/garmin/status` itself (throttled) and set the flag from the result. Or drop the flag and let `performGarminSync`'s `notLoggedIn` error decide.

<a id="w3"></a>
#### W3. The logged RPE defaults to 7 whatever the plan said — confirmed

- **Where:** `FitnessApp/LogWorkoutView.swift:30`, used at `:148-149`
- **Scenario:** The slider starts at 7. Planned RPE is stored separately (`plannedRPE`, snapshotted from the session), but if the athlete saves a light session (planned RPE 3) without touching the slider, the log says actual 7 and `rpeDelta` +4. That feeds `recent_effort_above_plan` and "repeated high effort" in the coach context. On device it also switches off `hasCleanProgressionSignal` (`CoachClient.swift:1285`) once two such logs exist, so the coach backs off progression for no real reason.
- **Fix:** Start the slider at `plannedRPEForLog` when there is one, or leave it unset and require one touch before "Save log" is enabled.

<a id="w4"></a>
#### W4. A strength session can't be logged after midnight and is marked missed — confirmed

- **Where:** `FitnessApp/TrainingPlanStore.swift:16-30` (due means today only), `:105` (strength is overdue at the start of the next day), `FitnessApp/TodayView.swift:171-175` (logging needs `.planned`), `FitnessApp/CalendarView.swift:146-154` (no log action)
- **Scenario:** The athlete trains at 22:30 and opens the app at 00:10 to log. The session is no longer "due", so it is gone from Today. On the next activation the sweep marks it missed with the penalty, and no screen can log a missed session. Runs get a one-day grace period and a refund path (`completeRunFromGarmin`); strength gets neither.
- **Fix:** Give strength the same grace day, or allow logging yesterday's planned or missed strength session from Today or Log, refunding the miss the way `completeRunFromGarmin` does.

<a id="w5"></a>
#### W5. The coach-read retry flag is written but never read — confirmed

- **Where:** flag defined at `FitnessApp/CoachClient.swift:1438`, written at `LogWorkoutView.swift:195,217,219`, `AppShellView.swift:131,133`, `SettingsView.swift:737`, `TrainingPlanStore.swift:254`. The staleness helpers `coachVerdictNeedsRefresh(...)` at `CoachView.swift:400-435` are never called in the app.
- **Scenario:** Log a workout while offline. The verdict request fails and the flag goes true, but nothing ever looks at it, so the coach read stays stale until the next training triggers another refresh. Runs imported through Profile → "Sync now" (`SettingsView.swift:734-738`) only set the flag, so unlike the background sync they never refresh the coach read.
- **Fix:** On app activation (or when Coach appears), check the flag or `coachVerdictNeedsRefresh` and call `generateVerdict`. Make "Sync now" call the same `refreshCoachReadAfterTraining` path as the background sync.

<a id="w6"></a>
#### W6. The on-device plan validation is dead code, so the server plan is saved unchecked — confirmed

- **Where:** `FitnessApp/CoachClient.swift:155-194` (`AutoPlanCoordinator.apply` saves straight away), `:1641` and `:1677` (`generatePlan` and `generateCombinedWeek`, the only users of `CoachPlanValidator` and `RunningWeekValidator`, have no callers)
- **Scenario:** Every plan path runs through `AutoPlanCoordinator`: manual "Create week schedule" (`CoachView.swift:117`), app-active (`AppShellView.swift:141,148,159`) and post-training (`LogWorkoutView.swift:236`). None of them validates. The only on-device guard is "date is tomorrow or later". A plan that puts sessions on rest days, more sessions than training days, or runs on non-running days (for example a stale nightly plan built from offsets for an older `weekStart`) is saved as is. The large `CoachValidationTests` suite tests code the app no longer runs.
- **Fix:** In `apply`, run `CoachPlanValidator` and `RunningWeekValidator` against the current profile and `generatedPlan.weekStart`, and skip (and report) a plan that fails. Or delete the dead validators and their tests on purpose, and state in the README that the proxy is the only gate.

#### W7. Changing training days doesn't replan or move reminders — suspected

- **Where:** `FitnessApp/SettingsView.swift:90-93`
- **Scenario:** The athlete changes training days from Mon/Wed/Fri to Tue/Thu/Sat. Only `profile.trainingDays` is saved. Strength sessions already planned on Wed and Fri stay, and reminders stay scheduled for them, until the proxy decides to regenerate (nightly, or app-active if its own dedupe lets it through). The same holds for running days and the long-run day.
- **Fix:** After saving, call `AutoPlanCoordinator.trigger(source: .manual, force: true)` with a fresh request, and reschedule reminders.

#### W8. A planned-run Garmin sync started while another is running drops the stale workout ids — suspected

- **Where:** `FitnessApp/CoachClient.swift:24` together with `:169-172,187-193`
- **Scenario:** `AutoPlanCoordinator.apply` has already deleted the replaced runs locally and saved before it calls `syncPlannedRuns`. If a sync is in flight (for example "Retry" from Profile), `syncPlannedRuns` returns `nil` straight away and `stalePushedIds` is thrown away. The app has no other record of those workout ids. The proxy limits the damage: `mergePlanIntoState` also deletes any workout it recorded whose session is no longer requested (`garmin-sync.ts:127-133`). So proxy-tracked workouts are only cleaned up late, at the next applied plan, and the replacements for the new plan aren't pushed until then. Workouts the proxy never recorded (pushed through the legacy `/garmin/push-workouts` route) stay orphaned.
- **Fix:** Await the in-flight sync and then run a new one, or keep a small persistent "sync pending" flag that the next app activation acts on.

#### W9. Reminders still fire for sessions that are already done — confirmed

- **Where:** `FitnessApp/NotificationScheduler.swift:34-52`. `LogWorkoutView.save` and `completeRunFromGarmin` never touch notifications.
- **Scenario:** The reminder is set for 09:00. The athlete logs the strength session at 07:00, or Garmin completes the morning run. At 09:00 the notification still says "… today — skip it and the score pays." A run and a strength session on the same day also give two notifications at the same minute.
- **Fix:** Remove the pending request `workout-<session id>` when a session is completed, missed or deleted. Optionally merge same-day sessions into one notification.

#### W10. After "Wipe all data", the first plan can be held back for 30 minutes — confirmed

- **Where:** `FitnessApp/SettingsView.swift:185-199` (`autoPlanLastContextSyncAt` is not reset), `FitnessApp/AppShellView.swift:140-143`
- **Scenario:** The athlete wipes data and re-onboards within 30 minutes of the last app-active trigger. `syncAutoPlanIfDue` sees the throttle and only calls `applyLatestServerPlan` for the new profile id, which has no server plan yet. Today shows "No AI plan yet" until the throttle runs out or the athlete taps "Create week schedule".
- **Fix:** Reset `autoPlanLastContextSyncAt` in `resetAllData`, and trigger a forced plan when onboarding completes.

<a id="w11"></a>
#### W11. "Next work auto-deloaded" is not done on the device — confirmed

- **Where:** `FitnessApp/TrainingEngine.swift:150` (the message), `FitnessApp/LogWorkoutView.swift:178-182` (writes a `CoachDecision` that nothing reads), and `TrainingEngine.generateWeek` (only called from tests)
- **Scenario:** The athlete logs pain 5. The session becomes `deload` and the outcome says the next work is auto-deloaded. Locally, nothing changes in the future planned sessions. The deload only happens if the post-training auto-plan call reaches the proxy and the proxy chooses to regenerate. Offline, or if the proxy skips, the next session stays at full planned load.
- **Fix:** If the auto-plan trigger fails or is skipped, scale down the next planned strength session(s) locally (the old `TrainingEngine` deload rules can do this). Otherwise reword the message.

### Cosmetic

#### X1. Deload records show up as "Latest AI plan" — confirmed

- **Where:** `FitnessApp/LogWorkoutView.swift:179-180`, `FitnessApp/CoachView.swift:23-25,523-526,199-200`
- **Scenario:** A pain log inserts a `CoachPlan(source: .rules)`. `CoachView.latestPlan` is just the newest `CoachPlan`, so the Plan card's "Latest AI plan" shows the deload time. When there is no verdict yet, the Coach read card shows the deload reason as if it were the plan summary.
- **Fix:** Filter `latestPlan` to `source == .ai`, or record deloads somewhere other than `CoachPlan`.

#### X2. Plan-request failures and the "busy" state are hidden — confirmed

- **Where:** `FitnessApp/CoachView.swift:98,126`, `FitnessApp/CoachClient.swift:111,129-131`
- **Scenario:** Tapping "Create week schedule" while a Garmin sync or auto-plan is running does nothing, with no feedback. Every error (missing `OPENAI_API_KEY`, proxy rejected the plan, timeout) turns into "I could not refresh the plan yet. Try again in a bit."
- **Fix:** Show a "busy" status, and pass `error.localizedDescription` through from `trigger`. `CoachClientError` already has good messages.

#### X3. Coach chat can show the answer above the question — suspected

- **Where:** `FitnessApp/CoachChatView.swift:164-166`
- **Scenario:** User messages get the device time. Coach replies get the server's `generatedAt`. Messages are sorted by `createdAt`, so if the phone's clock is ahead of the server by more than the round trip, the reply sorts before the question it answers. The "drop a user turn followed by a failed reply" logic in `chatTurns` also depends on that order.
- **Fix:** Store `Date()` on the device as `createdAt` and keep `generatedAt` only as metadata.

#### X4. Readiness sliders may not save VoiceOver changes — suspected

- **Where:** `FitnessApp/LogWorkoutView.swift:411-418,465-472`
- **Scenario:** The slider writes only to `draftValue` and commits to the bound value in `onEditingChanged(false)`. Accessibility increment and decrement go through the binding setter without editing-changed callbacks, so the label shows the new value while `rpe`, `painLevel` or `howFelt` keep the old one and that is what gets saved.
- **Fix:** Write `value` in the binding setter (keep the draft only to smooth dragging), or commit on `.onChange(of: draftValue)`.

#### X5. Progress shows old Garmin readiness as if it were current — confirmed

- **Where:** `FitnessApp/ProgressView.swift:47-48`
- **Scenario:** Today hides a snapshot older than yesterday (`TodayView.swift:39-48`). Progress always shows the newest snapshot, even weeks old, with no date.
- **Fix:** Apply the same freshness check, or label the strip with the snapshot date.

### Low priority

- **L1. A double tap on "Save log" can log twice — suspected.** `FitnessApp/LogWorkoutView.swift:129-191` has no guard on `session.status == .planned` or a "saving" flag. Two quick taps before the sheet closes insert two `PerformanceLog`s and score the session twice. Fix: disable the button after the first tap, and return early if the session is no longer planned.
- **L2. The local fallback planner puts a session on a rest day when only one day is selected — confirmed but dead code.** `FitnessApp/TrainingEngine.swift:99,110` forces at least 2 sessions. With one selected day, the second falls back to `index * 3` days, which is not a training day. The app doesn't call `generateWeek` today. This only matters if the offline fallback comes back.

---

## Proxy and Garmin sidecar

Server-side findings. "Probed" means the real module functions were run from a scratch script outside the repo, with stubbed dependencies and no network calls. The proxy half of [D0](#d0) was found here independently, and the probe reproduced it (`Sat sync … deleted on Garmin: ['100']`, where 100 was today's workout).

### Crash

#### S1. One bad read of the auto-plan state file can kill the proxy on every tick — confirmed path, rare trigger

- **Where:** `Proxy/src/server.ts:816-820` (`void runDueNightlyAutoPlans()` on a 15-minute interval), `Proxy/src/coach/auto-plan.ts:106-120,154-159` (`AutoPlanStore.read()` rethrows anything other than ENOENT, and JSON parse errors happen outside the per-user try)
- **Scenario:** If `.data/auto-plan-state.json` can't be read (EACCES, EMFILE, a partial write after a full disk), the promise rejection isn't handled and Node 24 exits the whole proxy. It happens again on the first tick after every restart.
- **Fix:** Add `.catch(log)` to the interval call and move `usersDueForNightly` inside the try. Treat a corrupt state file as empty, but keep a backup copy of it.

### Data loss

#### S2. A single Garmin hiccup turns a wellness metric into 0, which overwrites the good value on the phone — confirmed (traced, not run live)

- **Where:** `GarminService/main.py:399-428` (`fetch` returns `None` on one connection error or any other exception, and the row is still returned), `GarminService/garmin_mapping.py:170-192` (missing becomes `0`), `FitnessApp/TrainingPlanStore.swift:308-316` (the app overwrites every field)
- **Scenario:** Yesterday's row was stored with a sleep score of 82. On the next sync, one `get_sleep_data` call times out. A single connection error doesn't trip the circuit breaker (it needs two in a row), so the row comes back with `sleepScore: 0, sleepSeconds: 0` and the app replaces 82 with 0. Once that day drops out of the 7-day window it is never fetched again. "This watch has no readiness" (404) and "Garmin was flaky" look the same, which breaks the README rule "missing means no data, never zeros" at the level of single metrics.
- **Fix:** In the sidecar, treat only 204 and 404 as "no data". On any other failure, leave the row out or send `null` for that metric. In the app, never overwrite a stored non-zero value with 0.

#### S3. Garmin sync deletes a changed workout and also marks the same id as synced — confirmed (probed)

- **Where:** `Proxy/src/garmin/garmin-sync.ts:145-160`
- **Scenario:** A synced run's content changes while its `sessionId` stays the same (an edit, a migration, or the date string shifting after a time-zone change). The app still sends `existingGarminWorkoutId` with the old id. The proxy queues the old id for deletion (`:145-147`) and then saves the new record as `synced` with that same id (`:149-160`). The workout is deleted from Garmin while the app and proxy say it is on the watch, and nothing pushes it again. Probe: `edit sync: MON:synced:101 | deleted on Garmin: [..., '101']`.
- **Fix:** When the content hash changed, ignore an `existingGarminWorkoutId` that equals the old id or is pending deletion. Only adopt ids for sessions the proxy has no record of.

### Wrong behaviour

#### S4. Today's not-yet-done session counts as missed from midnight, so the coach says "Watch" every training morning — confirmed (probed)

- **Where:** `Proxy/src/coach/planner/build-coach-context.ts:129-145` (`due = scheduled <= now`), `Proxy/src/coach/planner/evaluate-coach-read.ts:55` (`missedSessions = missed + pending`)
- **Scenario:** The app stores every session at local midnight (`CoachClient.swift:1398`, `TrainingPlanStore.swift:749`), so today's session is "due" from 00:00. An existing test (`excludes future sessions from adherence scoring`) shows the intent was to exclude later-today work, but real app data never takes that path. Probe at 08:00 with 3 of 3 past sessions done and one planned today: adherence 75%, band and status `watch`, and a "start conservatively" read for an athlete who is fully on track.
- **Fix:** Count a session as due only when it is scheduled before today's local midnight (`< weekStart`). Report today's planned sessions as pending and keep them out of the score.

#### S5. The proxy routes have no authentication: the owner's Garmin data, OpenAI spend and plan state are open — confirmed in code, production impact suspected

- **Where:** `Proxy/src/server.ts:306-369` (Garmin routes take `userId` from the request, and an empty value falls back to the default user at `GarminService/main.py:93-99`, which is the owner's account through the root `tokens/garmin_tokens.json`), `server.ts:79-93` (`/plan/status` and `/plan/trigger` use whatever `userId` the client sends), `Proxy/src/model-selection.ts:23-30` (any model string is accepted), `Proxy/src/storage/lockin-auth.ts:15,35,44` (the HMAC secret falls back to a hardcoded `lockin-local-development-secret-change-me`; `LOCKIN_AUTH_SECRET` isn't documented; tokens never expire, see `lockin-api.ts:117-129`)
- **Scenario:** Anyone who can reach `https://lockin.elevenfactor.com` can call `GET /garmin/snapshot` with no `userId` and receive the owner's wellness data and 90 days of runs. They can also delete watch workouts or disconnect Garmin, run `/generate-week` with an expensive model on the owner's OpenAI key, and overwrite a known user's auto-plan. User scoping inside the `/v1` storage routes is correct.
- **Fix:** Require an app credential on every proxy route. Reject a missing or empty `userId` on Garmin routes instead of falling back to the default user. Allow-list the models. Refuse to serve `/v1` without `LOCKIN_AUTH_SECRET`, and add token expiry.

#### S6. The running validator lets runs land on non-running days when this week has no running day left — confirmed (probed)

- **Where:** `Proxy/src/coach/planner/validate-running-week.ts:10-12,47` (the selection is taken from `runningDayOffsets` only), prompt at `server.ts:996-997`
- **Scenario:** The athlete runs only on Saturdays, and today is Saturday. The app sends `runningDays: ["saturday"], runningDayOffsets: []`, because today's offset is filtered out. The validator reads that as "no days selected" and skips day placement, frequency and the minimum-run rules. Probe: easy, tempo and easy runs on offsets 1, 3 and 5 (all non-running days) were accepted. The opposite case is broken too. The app sends `[]` and `[]` to mean "no days picked, any day is fine" (the comment in `makeCoachRequest`), but the running `SKILL.md:65` tells the model to return zero runs when offsets are empty, and the validator accepts that empty week. This is a gap in the README rule "AI sessions only land on selected future training days", and the proxy is the only gate ([W6](#w6)).
- **Fix:** Decide "has a selection" from `running.runningDays.length > 0`, as the strength validator does with `trainingDays`. Selected days with no offset left this week then mean zero runs. Send an explicit "unconstrained" flag for an empty selection and align the SKILL text with it.

#### S7. The strength validator rejects a correct zero-session week when a progression was earned — confirmed (probed)

- **Where:** `Proxy/src/coach/planner/validate-week-plan.ts:337-346`
- **Scenario:** The only training day is today (for example, Saturday only, with a post-training trigger after the Saturday session), and the last clean log earned +1 pull-up. The allowed offsets are `[]` and the prompt asks for zero sessions, but the validator still demands a higher pull-up target. The repair step can't fix it, so `/generate-week-plan` returns 422 and automatic planning records a failure. Probe: `accepted:false, "Clean matched performance earned pull-up progression..."`. The same happens to any week whose few allowed sessions have no pull-up work.
- **Fix:** Skip the earned-progression check when no sessions are allowed, and arguably only enforce it when the plan contains goal work for that metric.

#### S8. A missed nightly plan is never caught up, and failed runs are never retried — confirmed (catch-up probed; retry and stuck state traced)

- **Where:** `Proxy/src/coach/auto-plan.ts:187` (overwrites `nextNightlyRunAt` with the next 01:30 before `decideAutoPlan` reads it at `:320`), `:247-252` (sets `nextRetryAt`, which nothing reads), `:154-159` and `server.ts:824-842` (the scheduler only looks at `nextNightlyRunAt`), `server.ts:828` (users in `generating` are skipped)
- **Scenario:**
  - (a) The proxy is down or redeploying at 01:30. At 08:00 the app sends `app_active`. The check sees tomorrow's timestamp, answers "queued for tonight", and pushes the missed run back a full day. The "Catching up the overnight plan refresh" branch can't be reached.
  - (b) A nightly OpenAI or validation failure sets `retrying` with a retry in 30 minutes, but no code acts on it, so the next attempt is the following night while the app says it will retry.
  - (c) A restart during generation leaves the user in `generating`, and every later tick skips them until an app trigger resets the status.
- **Fix:** Read the previous `nextNightlyRunAt` before overwriting it and decide on that value. Let the scheduler also pick up `retrying` users whose `nextRetryAt` has passed. Treat a `generating` status older than about 15 minutes as failed, or reset it on startup.

#### S9. Coach chat answers "no weather data" to questions that contain "train" — confirmed (probed)

- **Where:** `Proxy/src/coach/chat.ts:398-408` (`isUnsupportedQuestion`), `:418-420` (`matchesAny` uses `text.includes`)
- **Scenario:** "rain" matches inside "train", "training" and "strain". So "How is my training going?", "Should I skip training today?" and "Is my knee strain a problem?" all get the canned weather answer. So does the proxy's own follow-up prompt "What can I train around safely?" (`chat.ts:349`). The other keyword lists are plain substrings too, so "Spain" matches "pain" and "know" matches "now".
- **Fix:** Match whole words (for example `\b(rain|wind|weather|forecast)\b`) in every intent list.

#### S10. Coach chat stops working for good after one long pain answer — confirmed (probed)

- **Where:** `Proxy/src/coach/chat.ts:13,62-80` (rejects any history message over 1200 characters, including the coach's own), `:194-210` (`painAnswer` quotes the profile note, which can be up to 800 characters per `build-coach-context.ts:464-466`)
- **Scenario:** With a profile note of about 770 characters, a pain question produced a 1209-character answer. The app stores it and sends it back as history (`CoachChatView.swift:194-219`). From then on every turn fails with `400 chat message text must be 1200 characters or less`. The long message stays among the last 20 turns, so the chat stays broken.
- **Fix:** Truncate coach-role history messages on input instead of rejecting them, and keep generated answers under the limit by trimming the quoted note.

#### S11. A push timeout can leave duplicate workouts on the watch — suspected

- **Where:** `Proxy/src/garmin/garmin-client.ts:147,174-197` (60 s abort), `Proxy/src/garmin/garmin-sync.ts:222-227` (after an error every record goes to retry with no ids), `:88-95` (`retry-sync` resets `retrying` to `pending` straight away), `GarminService/main.py:483-524` (the sidecar keeps uploading after the proxy has given up), `:139` and `:232-274` (global locks, including one held through a whole SSO login)
- **Scenario:** Garmin is slow, or a `/connect` holds the client lock, so a push takes more than 60 s. The proxy records a timeout and no ids while the sidecar finishes creating and scheduling every workout. "Retry" creates them all again, leaving two copies, and the first set has no record left to delete it by.
- **Fix:** Make pushes idempotent. Tag each workout with its `sessionId` and, after a timeout, list Garmin workouts and adopt existing ones before creating new ones.

#### S12. Coach requests usually go out without Garmin readiness — suspected (mechanism confirmed; rate from local telemetry only)

- **Where:** `Proxy/src/server.ts:878-898` (`enrichWithGarmin` gets 10 s for 7 days), `GarminService/main.py:430-455`, `server.ts:133` (every chat message fetches again)
- **Scenario:** Seven days of wellness is 29 Garmin calls made one after another under a global lock, with no cache, so 10 s is only enough when each call takes under about 340 ms. On timeout the coach context goes out without Garmin data, so no HRV gate and no readiness flag, and nothing says so. In the local `.data/openai-usage.jsonl`, users who sometimes had Garmin data had none on 11/18, 13/26 and 18/25 of their coach calls. Some of those were nightly runs while the laptop slept, so the rate is only a rough guide. A six-question chat also makes about 170 Garmin calls, which invites the 429s that then cut real syncs short.
- **Fix:** Cache wellness per user per day, or reuse the app's last snapshot. Fetch only one or two days for enrichment. Log when the context is sent without Garmin data.

#### S13. Watch workouts for hard runs are about 15 minutes longer than planned — confirmed in code

- **Where:** `GarminService/garmin_mapping.py:303-320`
- **Scenario:** For long, tempo, interval and hill runs with a distance set, the main step uses the full planned distance, and a 10-minute warm-up plus a 5-minute cool-down are added on top. A 10 km tempo becomes about 12.5 km on the watch, with the pace target covering the full 10 km. The time-based branch already subtracts warm-up and cool-down to land near the planned duration. The distance branch doesn't, even though the running SKILL treats `distanceKm` as the whole session.
- **Fix:** Subtract the warm-up and cool-down distance from the main step, or leave them out when a total distance is given.

#### S14. Garmin MFA connect probably can't work with emailed codes — suspected

- **Where:** `GarminService/main.py:347-359`, `:252-260`
- **Scenario:** The first `/connect` call fails at `prompt_mfa`. The second call, which carries the code, starts a brand-new SSO login, so Garmin sends a new code while the sidecar submits the old one. The installed garminconnect 0.3.5 has `return_on_mfa=True` and `resume_login(state, code)` for exactly this two-request flow, and neither is used. Authenticator-app (TOTP) codes may still work.
- **Fix:** On the first call use `return_on_mfa=True` and keep the login state per user for a few minutes. On the second call run `resume_login(state, mfaCode)` and save the tokens.

#### S15. On the spring-forward day, tomorrow's session is reported as today — confirmed (probed)

- **Where:** `Proxy/src/coach/planner/build-coach-context.ts:167-173` (`endOfToday = weekStart + 24h`)
- **Scenario:** Sunday 2027-03-28 in Amsterdam has 23 hours, so Monday's session at local midnight falls inside "today". The probe gave `todaySessions: ['Monday Pull']` and a next action of "Complete Monday Pull as planned" on a rest day. The verdict and the chat's answers about today are wrong that day.
- **Fix:** End "today" at the next local midnight, using the time-zone helpers already in `auto-plan.ts`.

### Checked and found fine

- iOS and proxy field names and optionality match for `/generate-week`, `/generate-week-plan`, `/coach-verdict`, `/coach-chat`, `/plan/*` and `/garmin/status|snapshot|sync-plan|sync-status|retry-sync`.
- ISO dates with milliseconds from the proxy decode in the app: the chat UI test decodes one. A device on iOS 17 (the deployment target) wasn't checked.
- `/v1` storage routes scope every query by the token's user id.
- Wellness days the sidecar couldn't fetch, for example when throttled, are left out rather than zero-filled, and the app leaves them absent. The per-metric case is S2.
