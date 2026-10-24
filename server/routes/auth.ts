import { Router } from "express";
import argon2 from "argon2";
import { z } from "zod";
import { db } from "../db.js";
import { writeAudit, publicUser } from "../audit.js";
import { HttpError, asyncRoute, requireAuth, requirePasswordChangeAuth } from "../http.js";
import { ARGON2_OPTIONS, createOpaqueToken, isConfiguredThrottleSecret, loginThrottleKey, normalizePhone, sha256, validateNewPassword, verifyPassword } from "../security.js";
import { clearSessionCookies, SESSION_TTL_MS, setSessionCookies } from "../session.js";

const router = Router();
const loginSchema = z.object({ phone: z.string().min(1).max(32), password: z.string().min(1).max(128) });
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(1).max(128) });
const dummyHashPromise = argon2.hash(createOpaqueToken(), ARGON2_OPTIONS);
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

async function registerFailure(key: string, now = new Date()) {
  const prior = await db.loginThrottle.findUnique({ where: { key } });
  if (prior?.blockedUntil && prior.blockedUntil > now) return true;
  const withinWindow = !!prior && now.getTime() - prior.windowStartedAt.getTime() < WINDOW_MS;
  const failedCount = withinWindow ? (prior?.failedCount ?? 0) + 1 : 1;
  const windowStartedAt = withinWindow ? prior!.windowStartedAt : now;
  const blockedUntil = failedCount >= MAX_FAILURES ? new Date(now.getTime() + WINDOW_MS) : null;
  await db.loginThrottle.upsert({
    where: { key },
    create: { key, failedCount, windowStartedAt, blockedUntil },
    update: { failedCount, windowStartedAt, blockedUntil },
  });
  return !!blockedUntil;
}

router.post("/login", asyncRoute(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "Introdu numărul de telefon și parola.", "INVALID_LOGIN");
  const throttleSecret = process.env.LOGIN_THROTTLE_SECRET;
  if (!isConfiguredThrottleSecret(throttleSecret)) throw new HttpError(503, "Autentificarea nu este configurată.", "AUTH_NOT_CONFIGURED");

  let phone = "invalid";
  let phoneIsValid = true;
  try {
    phone = normalizePhone(parsed.data.phone);
  } catch {
    phoneIsValid = false;
  }
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const key = loginThrottleKey(phoneIsValid ? phone : `invalid:${parsed.data.phone.slice(0, 32)}`, ip, throttleSecret);
  const now = new Date();
  const throttle = await db.loginThrottle.findUnique({ where: { key } });
  if (throttle?.blockedUntil && throttle.blockedUntil > now) {
    throw new HttpError(429, "Prea multe încercări. Reîncearcă mai târziu.", "LOGIN_THROTTLED");
  }

  const user = phoneIsValid ? await db.user.findUnique({ where: { phone } }) : null;
  const hash = user?.passwordHash ?? await dummyHashPromise;
  const passwordMatches = await verifyPassword(hash, parsed.data.password);
  if (!user || !phoneIsValid || !passwordMatches || user.status !== "ACTIVE") {
    const blocked = await registerFailure(key, now);
    throw new HttpError(blocked ? 429 : 401, blocked ? "Prea multe încercări. Reîncearcă mai târziu." : "Numărul sau parola nu sunt corecte.", blocked ? "LOGIN_THROTTLED" : "INVALID_CREDENTIALS");
  }

  await db.loginThrottle.deleteMany({ where: { key } });
  const sessionToken = createOpaqueToken();
  const csrfToken = createOpaqueToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const updatedUser = await db.$transaction(async (tx) => {
    const account = await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
    await tx.session.create({
      data: {
        tokenHash: sha256(sessionToken),
        csrfTokenHash: sha256(csrfToken),
        userId: user.id,
        userAgent: req.get("user-agent")?.slice(0, 180),
        expiresAt,
      },
    });
    await writeAudit(tx, user.id, "AUTH.LOGIN_SUCCEEDED", "User", user.id);
    return account;
  });
  setSessionCookies(res, sessionToken, csrfToken);
  res.json({ user: publicUser(updatedUser) });
}));

router.get("/me", requirePasswordChangeAuth, asyncRoute(async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.auth!.user.id } });
  if (!user) throw new HttpError(401, "Autentificarea este necesară.", "UNAUTHENTICATED");
  res.json({ user: publicUser(user) });
}));

router.post("/password", requirePasswordChangeAuth, asyncRoute(async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "Verifică parola curentă și parola nouă.", "INVALID_PASSWORD_CHANGE");
  try {
    validateNewPassword(parsed.data.newPassword);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Parola nouă nu este acceptată.", "PASSWORD_POLICY");
  }

  const user = await db.user.findUnique({ where: { id: req.auth!.user.id } });
  if (!user || !(await verifyPassword(user.passwordHash, parsed.data.currentPassword))) {
    throw new HttpError(401, "Parola curentă nu este corectă.", "INVALID_CURRENT_PASSWORD");
  }
  const passwordHash = await argon2.hash(parsed.data.newPassword, ARGON2_OPTIONS);
  const now = new Date();
  const updated = await db.$transaction(async (tx) => {
    const account = await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false },
    });
    await tx.session.updateMany({
      where: { userId: user.id, id: { not: req.auth!.sessionId }, revokedAt: null },
      data: { revokedAt: now },
    });
    await writeAudit(tx, user.id, "AUTH.PASSWORD_CHANGED", "User", user.id);
    return account;
  });
  res.json({ user: publicUser(updated) });
}));

router.post("/logout", asyncRoute(async (req, res) => {
  if (req.auth) await db.session.updateMany({ where: { id: req.auth.sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  clearSessionCookies(res);
  res.status(204).end();
}));

router.post("/logout-all", requireAuth, asyncRoute(async (req, res) => {
  await db.session.updateMany({ where: { userId: req.auth!.user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await writeAudit(db, req.auth!.user.id, "AUTH.SESSIONS_REVOKED", "User", req.auth!.user.id);
  clearSessionCookies(res);
  res.status(204).end();
}));

export default router;
