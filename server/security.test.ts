import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response, NextFunction } from "express";
import { HttpError, originGuard, requireAdmin, requireAuth } from "./http.js";
import { createOpaqueToken, constantTimeStringEqual, isConfiguredThrottleSecret, loginThrottleKey, normalizePhone, sha256, validateNewPassword } from "./security.js";

test("phone normalization preserves the leading zero as text", () => {
  assert.equal(normalizePhone("0700 000 000"), "0700000000");
  assert.equal(normalizePhone("+40 (700) 000-000"), "+40700000000");
});


test("invalid phone numbers are rejected", () => {
  assert.throws(() => normalizePhone("abc"));
  assert.throws(() => normalizePhone("12345678"));
});

test("new passwords require at least twelve characters", () => {
  assert.throws(() => validateNewPassword("short"));
  assert.doesNotThrow(() => validateNewPassword("correct-horse-42"));
});

test("production throttle secrets reject short and copied placeholder values", () => {
  assert.equal(isConfiguredThrottleSecret(undefined), false);
  assert.equal(isConfiguredThrottleSecret("short"), false);
  assert.equal(isConfiguredThrottleSecret("replace-with-a-long-random-secret-value"), false);
  assert.equal(isConfiguredThrottleSecret("unpredictable-value-4a9b8c7d6e5f4321"), true);
});

test("opaque tokens are unique and only their digest is suitable for storage", () => {
  const first = createOpaqueToken();
  const second = createOpaqueToken();
  assert.notEqual(first, second);
  assert.notEqual(sha256(first), first);
  assert.equal(sha256(first).length, 64);
});

test("constant-time string comparison checks content and length", () => {
  assert.equal(constantTimeStringEqual("csrf-token", "csrf-token"), true);
  assert.equal(constantTimeStringEqual("csrf-token", "csrf-t0ken"), false);
  assert.equal(constantTimeStringEqual("short", "longer"), false);
});

test("throttle identifiers are keyed and do not expose phone or address", () => {
  const key = loginThrottleKey("0766100672", "127.0.0.1", "a-long-random-secret-value");
  assert.equal(key.length, 64);
  assert.equal(key.includes("0766100672"), false);
  assert.notEqual(key, loginThrottleKey("0766100672", "127.0.0.2", "a-long-random-secret-value"));
});

function guardError(guard: (req: Request, res: Response, next: NextFunction) => void, auth?: NonNullable<Request["auth"]>) {
  return new Promise<unknown>((resolve) => {
    guard({ auth } as Request, {} as Response, (error?: unknown) => resolve(error ?? null));
  });
}

async function checkOrigin(origin: string | undefined, nodeEnv: string, expectedOrigin: string) {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAppOrigin = process.env.APP_ORIGIN;
  process.env.NODE_ENV = nodeEnv;
  process.env.APP_ORIGIN = expectedOrigin;
  try {
    return await new Promise<unknown>((resolve) => {
      const req = { method: "POST", get: (name: string) => name.toLowerCase() === "origin" ? origin : undefined } as unknown as Request;
      originGuard(req, {} as Response, (error?: unknown) => resolve(error ?? null));
    });
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousAppOrigin;
  }
}

test("development origin guard accepts loopback preview ports and rejects remote origins", async () => {
  assert.equal(await checkOrigin("http://localhost:5174", "development", "http://localhost:5173"), null);
  assert.equal(await checkOrigin("http://127.0.0.1:4173", "development", "http://localhost:5173"), null);
  const remote = await checkOrigin("https://example.com", "development", "http://localhost:5173");
  assert.ok(remote instanceof HttpError);
  assert.equal(remote.code, "ORIGIN_REJECTED");
});

test("production origin guard accepts only the configured application origin", async () => {
  assert.equal(await checkOrigin("https://chat.example", "production", "https://chat.example"), null);
  const alternate = await checkOrigin("http://localhost:5174", "production", "https://chat.example");
  assert.ok(alternate instanceof HttpError);
  assert.equal(alternate.code, "ORIGIN_REJECTED");
  const missing = await checkOrigin(undefined, "production", "https://chat.example");
  assert.ok(missing instanceof HttpError);
  assert.equal(missing.code, "ORIGIN_REJECTED");
});

test("ordinary users and unauthenticated requests cannot pass the admin guard", async () => {
  const unauthenticated = await guardError(requireAdmin);
  assert.ok(unauthenticated instanceof HttpError);
  assert.equal(unauthenticated.status, 401);

  const ordinaryUser = await guardError(requireAdmin, {
    user: { id: "user-1", displayName: "Utilizator", phone: "0700000000", role: "USER", status: "ACTIVE", mustChangePassword: false },
    sessionId: "session-1", tokenHash: "token-hash", csrfTokenHash: "csrf-hash",
  });
  assert.ok(ordinaryUser instanceof HttpError);
  assert.equal(ordinaryUser.status, 403);
  assert.equal(ordinaryUser.code, "ADMIN_REQUIRED");
});

test("initial-password accounts are blocked from protected routes until changed", async () => {
  const initialAdmin = {
    user: { id: "admin-1", displayName: "Administrator", phone: "0766100672", role: "SUPER_ADMIN", status: "ACTIVE", mustChangePassword: true },
    sessionId: "session-1", tokenHash: "token-hash", csrfTokenHash: "csrf-hash",
  };
  const protectedRoute = await guardError(requireAuth, initialAdmin);
  assert.ok(protectedRoute instanceof HttpError);
  assert.equal(protectedRoute.status, 428);
  assert.equal(protectedRoute.code, "PASSWORD_CHANGE_REQUIRED");
});
