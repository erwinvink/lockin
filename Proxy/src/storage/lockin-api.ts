import type { IncomingMessage, ServerResponse } from "node:http";
import { signAuthToken, verifyAuthToken, type PublicUser } from "./lockin-auth";
import { LockinAuthError, LockinInputError, LockinStore } from "./lockin-store";

export function createLockinApiHandler(
  store: LockinStore,
  options: { authSecret?: string } = {}
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/v1/")) {
      return false;
    }

    if (req.method === "OPTIONS") {
      writeJSON(res, 204, null);
      return true;
    }

    try {
      if (req.method === "POST" && url.pathname === "/v1/auth/register") {
        const body = await readJSON(req);
        const user = store.registerUser({
          username: stringFrom(body.username),
          password: stringFrom(body.password),
          displayName: stringFrom(body.displayName)
        });
        writeJSON(res, 201, authResponse(user, options.authSecret));
        return true;
      }

      if (req.method === "POST" && url.pathname === "/v1/auth/login") {
        const body = await readJSON(req);
        const user = store.authenticateUser({
          username: stringFrom(body.username),
          password: stringFrom(body.password)
        });
        writeJSON(res, 200, authResponse(user, options.authSecret));
        return true;
      }

      const user = authenticateRequest(req, store, options.authSecret);

      if (req.method === "GET" && url.pathname === "/v1/me") {
        writeJSON(res, 200, { user });
        return true;
      }

      if (req.method === "GET" && url.pathname === "/v1/bootstrap") {
        writeJSON(res, 200, store.bootstrap(user.id));
        return true;
      }

      if (req.method === "POST" && url.pathname === "/v1/migrations/import-local-store") {
        writeJSON(res, 200, store.importLocalStore(user.id, await readJSON(req)));
        return true;
      }

      if (req.method === "GET" && url.pathname === "/v1/sync/pull") {
        writeJSON(res, 200, store.pullChanges(user.id, Number(url.searchParams.get("since") ?? 0)));
        return true;
      }

      if (req.method === "POST" && url.pathname === "/v1/sync/push") {
        const body = await readJSON(req);
        writeJSON(res, 200, store.pushMutations(user.id, body.mutations));
        return true;
      }

      if (req.method === "GET" && url.pathname === "/v1/week/current") {
        writeJSON(res, 200, store.currentWeek(user.id, url.searchParams.get("weekStart") ?? undefined));
        return true;
      }

      if (req.method === "PATCH" && url.pathname === "/v1/profile") {
        writeJSON(res, 200, { profile: store.updateProfile(user.id, await readJSON(req)) });
        return true;
      }

      if (req.method === "GET" && url.pathname === "/v1/plan/status") {
        writeJSON(res, 200, store.planStatus(user.id));
        return true;
      }

      if (req.method === "GET" && url.pathname === "/v1/sync/status") {
        writeJSON(res, 200, store.syncStatus(user.id));
        return true;
      }

      writeJSON(res, 404, { error: "Not found" });
      return true;
    } catch (error) {
      if (error instanceof LockinInputError) {
        writeJSON(res, 400, { error: error.message });
        return true;
      }
      if (error instanceof LockinAuthError) {
        writeJSON(res, 401, { error: error.message });
        return true;
      }
      writeJSON(res, 500, { error: error instanceof Error ? error.message : "Unknown storage error" });
      return true;
    }
  };
}

function authResponse(user: PublicUser, authSecret?: string): { user: PublicUser; token: string } {
  return {
    user,
    token: signAuthToken(
      { userId: user.id, username: user.username, issuedAt: new Date().toISOString() },
      authSecret
    )
  };
}

function authenticateRequest(req: IncomingMessage, store: LockinStore, authSecret?: string): PublicUser {
  const authorization = req.headers.authorization ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  const payload = token ? verifyAuthToken(token, authSecret) : null;
  if (!payload) {
    throw new LockinAuthError("missing or invalid bearer token");
  }
  const user = store.userById(payload.userId);
  if (!user) {
    throw new LockinAuthError("user not found");
  }
  return user;
}

async function readJSON(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req);
  if (!body.trim()) {
    return {};
  }
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LockinInputError("JSON object body is required");
  }
  return parsed as Record<string, unknown>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function writeJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "content-type": "application/json"
  });
  res.end(body === null ? "" : JSON.stringify(body));
}

function stringFrom(value: unknown): string {
  return typeof value === "string" ? value : "";
}

