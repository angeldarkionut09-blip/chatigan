import type { ErrorRequestHandler, Request, RequestHandler } from "express";
import type { User } from "@prisma/client";
import { constantTimeStringEqual, sha256 } from "./security.js";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export interface AuthContext {
  user: Pick<User, "id" | "displayName" | "phone" | "role" | "status" | "mustChangePassword">;
  sessionId: string;
  tokenHash: string;
  csrfTokenHash: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export const asyncRoute = (handler: (req: Request, res: import("express").Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    void handler(req, res).catch(next);
  };

export const originGuard: RequestHandler = (req, _res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  const expected = process.env.APP_ORIGIN ?? "http://localhost:5173";
  if (!origin) {
    if (process.env.NODE_ENV === "production") return next(new HttpError(403, "Origine lipsă.", "ORIGIN_REJECTED"));
    return next();
  }
  if (origin === expected) return next();
  if (process.env.NODE_ENV !== "production") {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return next();
    } catch {
      // Invalid Origin values remain rejected below.
    }
  }
  if (origin !== expected) return next(new HttpError(403, "Origine nepermisă.", "ORIGIN_REJECTED"));
  next();
};

function authError(req: Request, allowPasswordChange: boolean): HttpError | null {
  if (!req.auth) return new HttpError(401, "Autentificarea este necesară.", "UNAUTHENTICATED");
  if (req.auth.user.status !== "ACTIVE") return new HttpError(403, "Contul este suspendat.", "ACCOUNT_SUSPENDED");
  if (!allowPasswordChange && req.auth.user.mustChangePassword) {
    return new HttpError(428, "Schimbă parola înainte să continui.", "PASSWORD_CHANGE_REQUIRED");
  }
  return null;
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const error = authError(req, false);
  if (error) return next(error);
  next();
};

// Used only by /me and /password so a newly bootstrapped account can reach the
// forced password-change flow while all other authenticated routes stay gated.
export const requirePasswordChangeAuth: RequestHandler = (req, _res, next) => {
  const error = authError(req, true);
  if (error) return next(error);
  next();
};

export const requireAdmin: RequestHandler = (req, _res, next) => {
  const error = authError(req, false);
  if (error) return next(error);
  if (req.auth!.user.role !== "SUPER_ADMIN") return next(new HttpError(403, "Accesul administratorului este necesar.", "ADMIN_REQUIRED"));
  next();
};

export const csrfGuard: RequestHandler = (req, _res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.path === "/api/auth/login" || !req.auth) return next();
  const cookieToken = req.cookies?.chatigan_csrf;
  const headerToken = req.get("x-csrf-token");
  if (!cookieToken || !headerToken || !constantTimeStringEqual(sha256(cookieToken), req.auth.csrfTokenHash) || !constantTimeStringEqual(cookieToken, headerToken)) {
    return next(new HttpError(403, "Verificarea de securitate a eșuat.", "CSRF_REJECTED"));
  }
  next();
};

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: { code: error.code ?? "REQUEST_FAILED", message: error.message } });
    return;
  }
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 500;
  if (process.env.NODE_ENV !== "production") {
    const safeError = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown server error";
    console.error(`[api] ${safeError}`);
  }
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: { code: "INTERNAL_ERROR", message: status >= 500 ? "A apărut o eroare internă." : "Cererea nu a putut fi procesată." },
  });
};
