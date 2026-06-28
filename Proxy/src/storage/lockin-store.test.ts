import assert from "node:assert/strict";
import test from "node:test";
import { LockinStore, currentOwnerDisplayName, currentOwnerUsername } from "./lockin-store";

test("local import keeps current data under Erwin vink and scopes rows by user", () => {
  const store = new LockinStore(":memory:");
  const erwin = store.registerUser({
    username: currentOwnerUsername,
    password: "correct horse battery staple",
    displayName: currentOwnerDisplayName
  });
  const other = store.registerUser({
    username: "other",
    password: "correct horse battery staple",
    displayName: "Other Athlete"
  });

  const imported = store.importLocalStore(erwin.id, {
    profile: { id: "profile-local", name: "Erwin", baselinePullUps: 5 },
    sessions: [
      { id: "session-1", scheduledDate: "2026-06-15T09:00:00.000Z", title: "Pull day", statusRaw: "planned" }
    ],
    strengthLogs: [
      { id: "log-1", sessionId: "session-1", completedAt: "2026-06-15T10:00:00.000Z", pullUps: 6 }
    ]
  });

  assert.equal(imported.profile?.name, currentOwnerDisplayName);
  assert.equal(imported.sessions.length, 1);
  assert.equal(imported.strengthLogs.length, 1);

  const otherBootstrap = store.bootstrap(other.id);
  assert.equal(otherBootstrap.profile, null);
  assert.equal(otherBootstrap.sessions.length, 0);
  assert.equal(otherBootstrap.strengthLogs.length, 0);

  store.close();
});

test("sync mutations are idempotent and pull returns only this user's changes", () => {
  const store = new LockinStore(":memory:");
  const erwin = store.registerUser({
    username: currentOwnerUsername,
    password: "correct horse battery staple",
    displayName: currentOwnerDisplayName
  });
  const other = store.registerUser({
    username: "other",
    password: "correct horse battery staple",
    displayName: "Other Athlete"
  });

  const pushed = store.pushMutations(erwin.id, [
    {
      clientMutationId: "m-1",
      model: "sessions",
      op: "upsert",
      id: "session-1",
      data: { title: "Easy run", scheduledDate: "2026-06-17T07:00:00.000Z" }
    }
  ]);
  const repeated = store.pushMutations(erwin.id, [
    {
      clientMutationId: "m-1",
      model: "sessions",
      op: "upsert",
      id: "session-1",
      data: { title: "Should not replace", scheduledDate: "2026-06-18T07:00:00.000Z" }
    }
  ]);

  assert.deepEqual(repeated.applied, pushed.applied);
  assert.equal(store.bootstrap(erwin.id).sessions[0]?.title, "Easy run");
  assert.equal(store.pullChanges(erwin.id, 0).changes.length, 1);
  assert.equal(store.pullChanges(other.id, 0).changes.length, 0);

  store.close();
});

test("current week endpoint includes sessions in the requested week only", () => {
  const store = new LockinStore(":memory:");
  const user = store.registerUser({
    username: currentOwnerUsername,
    password: "correct horse battery staple",
    displayName: currentOwnerDisplayName
  });

  store.importLocalStore(user.id, {
    profile: { id: "profile-local", name: "Athlete" },
    sessions: [
      { id: "session-in", scheduledDate: "2026-06-15T09:00:00.000Z", title: "This week" },
      { id: "session-out", scheduledDate: "2026-06-23T09:00:00.000Z", title: "Next week" }
    ],
    setPrescriptions: [
      { id: "set-1", sessionId: "session-in", exerciseRaw: "pullUp" },
      { id: "set-2", sessionId: "session-out", exerciseRaw: "pushUp" }
    ]
  });

  const week = store.currentWeek(user.id, "2026-06-15T00:00:00.000Z");
  assert.deepEqual(week.sessions.map((session) => session.id), ["session-in"]);
  assert.deepEqual(week.setPrescriptions.map((item) => item.id), ["set-1"]);

  store.close();
});

