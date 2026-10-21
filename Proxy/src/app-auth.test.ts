import assert from "node:assert/strict";
import test from "node:test";
import { appTokenFromEnv, isAuthorizedAppRequest } from "./app-auth";

function req(method: string, url: string, token?: string) {
  return { method, url, headers: token === undefined ? {} : { "x-lockin-app-token": token } };
}

test("without LOCKIN_APP_TOKEN every route stays open (S5)", () => {
  assert.equal(appTokenFromEnv({}), undefined);
  assert.equal(appTokenFromEnv({ LOCKIN_APP_TOKEN: "   " }), undefined);
  assert.equal(isAuthorizedAppRequest(req("GET", "/garmin/snapshot"), undefined), true);
});

test("with LOCKIN_APP_TOKEN every route but GET /health needs the header (S5)", () => {
  const token = appTokenFromEnv({ LOCKIN_APP_TOKEN: " s3cret-token " });
  assert.equal(token, "s3cret-token");

  assert.equal(isAuthorizedAppRequest(req("GET", "/health"), token), true);
  assert.equal(isAuthorizedAppRequest(req("POST", "/health"), token), false);
  for (const [method, url] of [
    ["GET", "/garmin/snapshot?userId=u1"],
    ["POST", "/generate-week"],
    ["GET", "/models"],
    ["GET", "/v1/me"],
    ["GET", "/nope"]
  ]) {
    assert.equal(isAuthorizedAppRequest(req(method, url), token), false, `${method} ${url} without token`);
    assert.equal(isAuthorizedAppRequest(req(method, url, "wrong"), token), false, `${method} ${url} wrong token`);
    assert.equal(isAuthorizedAppRequest(req(method, url, ""), token), false, `${method} ${url} empty token`);
    assert.equal(isAuthorizedAppRequest(req(method, url, "s3cret-token"), token), true, `${method} ${url} right token`);
  }
});

test("CORS preflights carry no custom headers and serve nothing, so they pass (S5)", () => {
  assert.equal(isAuthorizedAppRequest(req("OPTIONS", "/v1/me"), "s3cret-token"), true);
});

test("a repeated header never authorizes (S5)", () => {
  const request = { method: "GET", url: "/models", headers: { "x-lockin-app-token": ["s3cret-token", "x"] } };
  assert.equal(isAuthorizedAppRequest(request, "s3cret-token"), false);
});
