import assert from "node:assert/strict";
import test from "node:test";
import { signAuthToken, verifyAuthToken } from "./lockin-auth";

const day = 24 * 60 * 60 * 1000;

function tokenIssuedAt(issuedAt: string): string {
  return signAuthToken({ userId: "user-1", username: "erwin", issuedAt }, "test-secret");
}

test("a fresh token verifies", () => {
  const payload = verifyAuthToken(tokenIssuedAt("2026-10-01T00:00:00.000Z"), "test-secret", {
    now: new Date("2026-10-20T00:00:00.000Z")
  });
  assert.equal(payload?.userId, "user-1");
});

test("tokens expire 180 days after issuedAt (S5)", () => {
  const token = tokenIssuedAt("2026-01-01T00:00:00.000Z");
  const issued = Date.parse("2026-01-01T00:00:00.000Z");
  assert.ok(verifyAuthToken(token, "test-secret", { now: new Date(issued + 179 * day) }));
  assert.equal(verifyAuthToken(token, "test-secret", { now: new Date(issued + 181 * day) }), null);
});

test("tokens with an unreadable or future issuedAt are rejected (S5)", () => {
  const now = new Date("2026-10-20T00:00:00.000Z");
  assert.equal(verifyAuthToken(tokenIssuedAt("not a date"), "test-secret", { now }), null);
  assert.equal(verifyAuthToken(tokenIssuedAt("2026-10-21T00:00:00.000Z"), "test-secret", { now }), null);
});

test("a token signed with another secret is rejected", () => {
  assert.equal(verifyAuthToken(tokenIssuedAt(new Date().toISOString()), "other-secret"), null);
});
