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

const defaultSecret = "lockin-local-development-secret-change-me";

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
  secret = process.env.LOCKIN_AUTH_SECRET ?? defaultSecret
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

export function verifyAuthToken(
  token: string,
  secret = process.env.LOCKIN_AUTH_SECRET ?? defaultSecret
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
    return {
      userId: parsed.userId,
      username: parsed.username,
      issuedAt: parsed.issuedAt
    };
  } catch {
    return null;
  }
}

