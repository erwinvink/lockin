import type { IncomingMessage } from "node:http";

/** Largest request body the proxy reads. A full coach request is well under 200 KB. */
export const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

/** A problem with what the client sent: answered with 400 and this message. */
export class ClientInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientInputError";
  }
}

/** The body is over the limit: answered with 413. */
export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`request body must be ${Math.round(maxBytes / (1024 * 1024))} MB or less`);
    this.name = "RequestBodyTooLargeError";
  }
}

/**
 * Reads the body as UTF-8, rejecting with RequestBodyTooLargeError as soon
 * as it is (or declares to be) over `maxBytes`. The rest of an oversized body
 * is drained, not buffered, so the 413 can still be written.
 */
export function readRequestBody(req: IncomingMessage, maxBytes = MAX_REQUEST_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      reject(new RequestBodyTooLargeError(maxBytes));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      size += buffer.length;
      if (size > maxBytes) {
        settled = true;
        chunks.length = 0;
        reject(new RequestBodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** JSON.parse for a request body: invalid JSON is the client's problem (400), not a server fault. */
export function parseJSONBody(text: string): unknown {
  if (!text.trim()) {
    throw new ClientInputError("request body is required");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ClientInputError("request body must be valid JSON");
  }
}

export type ErrorResponse = { status: number; body: { error: string } };

export const INTERNAL_ERROR_MESSAGE = "The coach proxy hit an internal error. Try again in a moment.";

/**
 * The status and athlete-safe message for an error that reached the route
 * handler. Client mistakes keep their message; everything else is a 500 with
 * a generic message (the details go to the server log, not the client).
 */
export function errorResponseFor(error: unknown, isLegacyClientError: (error: unknown) => error is Error): ErrorResponse {
  if (error instanceof RequestBodyTooLargeError) {
    return { status: 413, body: { error: error.message } };
  }
  if (error instanceof ClientInputError || isLegacyClientError(error)) {
    return { status: 400, body: { error: (error as Error).message } };
  }
  return { status: 500, body: { error: INTERNAL_ERROR_MESSAGE } };
}
