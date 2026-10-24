import type { RequestHandler } from "express";
import { db } from "./db.js";
import { sha256 } from "./security.js";

export const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-chatigan_session" : "chatigan_session";
export const CSRF_COOKIE = "chatigan_csrf";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function setSessionCookies(res: import("express").Response, token: string, csrfToken: string) {
  const secure = process.env.NODE_ENV === "production";
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
  res.cookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

export function clearSessionCookies(res: import("express").Response) {
  const secure = process.env.NODE_ENV === "production";
  for (const name of [SESSION_COOKIE, CSRF_COOKIE]) {
    res.clearCookie(name, { path: "/", secure, sameSite: name === CSRF_COOKIE ? "strict" : "lax" });
  }
}

export const attachSession: RequestHandler = (req, _res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || typeof token !== "string") return next();
  void db.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  }).then((session) => {
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.status !== "ACTIVE") return next();
    req.auth = {
      user: {
        id: session.user.id,
        displayName: session.user.displayName,
        phone: session.user.phone,
        role: session.user.role,
        status: session.user.status,
        mustChangePassword: session.user.mustChangePassword,
      },
      sessionId: session.id,
      tokenHash: session.tokenHash,
      csrfTokenHash: session.csrfTokenHash,
    };
    next();
  }).catch(next);
};
