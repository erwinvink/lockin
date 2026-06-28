import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createLockinApiHandler } from "./lockin-api";
import { LockinStore, currentOwnerDisplayName, currentOwnerUsername } from "./lockin-store";

test("storage API registers Erwin vink, imports local data, and protects another account", async (t) => {
  const store = new LockinStore(":memory:");
  t.after(() => store.close());
  const handler = createLockinApiHandler(store, { authSecret: "test-secret" });
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) {
      res.writeHead(404).end();
    }
  });
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const baseURL = `http://127.0.0.1:${address.port}`;

  const erwinAuth = await postJSON(`${baseURL}/v1/auth/register`, {
    username: currentOwnerUsername,
    password: "correct horse battery staple",
    displayName: currentOwnerDisplayName
  });
  const otherAuth = await postJSON(`${baseURL}/v1/auth/register`, {
    username: "other",
    password: "correct horse battery staple",
    displayName: "Other Athlete"
  });

  await postJSON(`${baseURL}/v1/migrations/import-local-store`, {
    profile: { id: "local-profile", name: "Athlete" },
    sessions: [{ id: "session-1", scheduledDate: "2026-06-15T09:00:00.000Z", title: "Pull day" }]
  }, String(erwinAuth.token));

  const erwinBootstrap = await getJSON(`${baseURL}/v1/bootstrap`, String(erwinAuth.token));
  assert.equal(erwinBootstrap.profile.name, currentOwnerDisplayName);
  assert.equal(erwinBootstrap.sessions.length, 1);

  const otherBootstrap = await getJSON(`${baseURL}/v1/bootstrap`, String(otherAuth.token));
  assert.equal(otherBootstrap.profile, null);
  assert.equal(otherBootstrap.sessions.length, 0);

  const unauthorized = await fetch(`${baseURL}/v1/bootstrap`);
  assert.equal(unauthorized.status, 401);
});

async function postJSON(url: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    assert.fail(`${url} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json() as Record<string, unknown>;
}

async function getJSON(url: string, token: string): Promise<Record<string, any>> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    assert.fail(`${url} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json() as Record<string, any>;
}
