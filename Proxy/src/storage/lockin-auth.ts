import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export type PublicUser = {
  id: string;
  username: string;
  displayName: string;
};

export type AuthTokenPayload = {
  userId: string;
  username: string;
  issuedAt: string;
};

export const developmentAuthSecret = "lockin-local-development-secret-change-me";
const defaultSecret = developmentAuthSecret;

// Bearer tokens are valid this long after issuedAt; the user logs in again after.
export const AUTH_TOKEN_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
// Allowed clock skew for an issuedAt slightly in the future.
const ISSUED_AT_SKEW_MS = 5 * 60 * 1000;

/**
 * The HMAC secret for /v1 tokens: an explicit one, else LOCKIN_AUTH_SECRET,
 * else the built-in development secret — but never that one in production,
 * where anyone could forge tokens with it (null means "refuse to serve").
 */
export function resolveAuthSecret(explicit: string | undefined, env: NodeJS.ProcessEnv): string | null {
  const configured = explicit?.trim() || env.LOCKIN_AUTH_SECRET?.trim();
  if (configured) return configured;
  return env.NODE_ENV === "production" ? null : defaultSecret;
}

export function hashPassword(password: string, salt = randomBytes(16).toString("base64url")): {
  salt: string;
  hash: string;
} {
  return {
    salt,
    hash: scryptSync(password, salt, 64).toString("base64url")
  };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt).hash, "base64url");
  const expected = Buffer.from(expectedHash, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function signAuthToken(
  payload: AuthTokenPayload,
  secret = process.env.LOCKIN_AUTH_SECRET?.trim() || defaultSecret
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

export function verifyAuthToken(
  token: string,
  secret = process.env.LOCKIN_AUTH_SECRET?.trim() || defaultSecret,
  options: { now?: Date; maxAgeMs?: number } = {}
): AuthTokenPayload | null {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  const actual = Buffer.from(signature, "base64url");
  const expected = Buffer.from(expectedSignature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<AuthTokenPayload>;
    if (!parsed.userId || !parsed.username || !parsed.issuedAt) {
      return null;
    }
    const issuedAt = Date.parse(parsed.issuedAt);
    const now = (options.now ?? new Date()).getTime();
    if (
      !Number.isFinite(issuedAt) ||
      issuedAt > now + ISSUED_AT_SKEW_MS ||
      now - issuedAt > (options.maxAgeMs ?? AUTH_TOKEN_MAX_AGE_MS)
    ) {
      return null;
    }
    return {
      userId: parsed.userId,
      username: parsed.username,
      issuedAt: parsed.issuedAt
    };
  } catch {
    return null;
  }
}

