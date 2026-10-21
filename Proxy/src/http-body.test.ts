import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import test from "node:test";
import {
  ClientInputError,
  INTERNAL_ERROR_MESSAGE,
  RequestBodyTooLargeError,
  errorResponseFor,
  parseJSONBody,
  readRequestBody
} from "./http-body";

function fakeRequest(chunks: Array<string | Buffer>, headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(Readable.from(chunks), { headers }) as unknown as IncomingMessage;
}

const noLegacyErrors = (error: unknown): error is Error => false;

test("reads a UTF-8 body, even when a character is split across chunks", async () => {
  const euro = Buffer.from("€", "utf8");
  const body = await readRequestBody(fakeRequest([Buffer.from("{\"note\":\"5 "), euro.subarray(0, 1), euro.subarray(1), Buffer.from("\"}")]));
  assert.equal(body, "{\"note\":\"5 €\"}");
});

test("rejects a body over the limit, declared or streamed", async () => {
  await assert.rejects(readRequestBody(fakeRequest(["{}"], { "content-length": "11" }), 10), RequestBodyTooLargeError);
  await assert.rejects(readRequestBody(fakeRequest(["12345", "67890", "1"]), 10), RequestBodyTooLargeError);
  assert.equal(await readRequestBody(fakeRequest(["12345", "67890"]), 10), "1234567890");
});

test("treats invalid or empty JSON as a client error", () => {
  assert.deepEqual(parseJSONBody("{\"ok\":true}"), { ok: true });
  assert.throws(() => parseJSONBody("{\"ok\":"), (error: unknown) => error instanceof ClientInputError && /valid JSON/.test(error.message));
  assert.throws(() => parseJSONBody("  "), (error: unknown) => error instanceof ClientInputError && /required/.test(error.message));
});

test("maps errors to 413, 400, or a generic 500", () => {
  assert.deepEqual(errorResponseFor(new RequestBodyTooLargeError(2 * 1024 * 1024), noLegacyErrors), {
    status: 413,
    body: { error: "request body must be 2 MB or less" }
  });
  assert.deepEqual(errorResponseFor(new ClientInputError("messages array is required"), noLegacyErrors), {
    status: 400,
    body: { error: "messages array is required" }
  });
  const legacy = (error: unknown): error is Error => error instanceof Error && error.message.startsWith("source must be");
  assert.equal(errorResponseFor(new Error("source must be manual"), legacy).status, 400);

  const fault = errorResponseFor(new Error("ENOENT: /srv/app/.data/secret-path.json"), noLegacyErrors);
  assert.equal(fault.status, 500);
  assert.equal(fault.body.error, INTERNAL_ERROR_MESSAGE);
  assert.equal(errorResponseFor("not even an error", noLegacyErrors).status, 500);
});

test("an oversized upload gets a 413 response instead of a dropped connection", async () => {
  const server = createServer(async (req, res) => {
    try {
      await readRequestBody(req, 1024);
      res.writeHead(200).end("{}");
    } catch (error) {
      const response = errorResponseFor(error, noLegacyErrors);
      res.setHeader("connection", "close");
      res.writeHead(response.status, { "content-type": "application/json" }).end(JSON.stringify(response.body));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/coach-chat" }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      // Chunked, no content-length: the limit is hit while streaming.
      for (let index = 0; index < 8; index += 1) req.write("x".repeat(512));
      req.end();
    });
    assert.equal(result.status, 413);
    assert.match(result.body, /request body must be/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
