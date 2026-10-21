import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const APP_TOKEN_HEADER = "x-lockin-app-token";

type AppRequest = { method?: string; url?: string; headers: IncomingHttpHeaders };

/** LOCKIN_APP_TOKEN, or undefined when unset/blank (proxy stays open). */
export function appTokenFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const token = env.LOCKIN_APP_TOKEN?.trim();
  return token ? token : undefined;
}

/**
 * When an app token is configured, every request except GET /health must
 * carry it in X-Lockin-App-Token. CORS preflights (OPTIONS) can't carry
 * custom headers and serve no data, so they pass.
 */
export function isAuthorizedAppRequest(req: AppRequest, expectedToken: string | undefined): boolean {
  if (!expectedToken) return true;
  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "GET" && path === "/health") return true;
  if (req.method === "OPTIONS") return true;

  const provided = req.headers[APP_TOKEN_HEADER];
  if (typeof provided !== "string" || provided.length === 0) return false;
  return constantTimeEqual(provided, expectedToken);
}

// Hash both sides first so the comparison takes the same time whatever the
// lengths, then compare the digests in constant time.
function constantTimeEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(a, b);
}
