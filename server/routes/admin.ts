import { Router, type Request } from "express";
import argon2 from "argon2";
import { z } from "zod";
import { db } from "../db.js";
import { writeAudit, publicUser } from "../audit.js";
import { asyncRoute, HttpError, requireAdmin } from "../http.js";
import { ARGON2_OPTIONS, normalizePhone, sha256, validateNewPassword } from "../security.js";

const router = Router();
const userCreateSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  phone: z.string().min(1).max(32),
  temporaryPassword: z.string().min(12).max(128),
});
const statusSchema = z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) });
const reportStatusSchema = z.object({ status: z.enum(["REVIEWING", "RESOLVED", "DISMISSED", "OPEN"]) });
const groupCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).default(""),
  visibility: z.enum(["PRIVATE", "INVITE_ONLY", "PUBLIC"]).default("PRIVATE"),
});
const groupPatchSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  visibility: z.enum(["PRIVATE", "INVITE_ONLY", "PUBLIC"]).optional(),
}).refine((value) => Object.keys(value).length > 0);
const settingsSchema = z.object({
  maintenanceMode: z.boolean().optional(),
  groupsEnabled: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0);

const DEFAULT_SETTINGS = {
  maintenanceMode: false,
  groupsEnabled: true,
};

function routeId(req: Request): string {
  const value = req.params.id;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  throw new HttpError(400, "Identificatorul cererii nu este valid.", "INVALID_ID");
}

router.use(requireAdmin);

router.get("/overview", asyncRoute(async (_req, res) => {
  const [totalUsers, activeUsers, suspendedUsers, openReports, activeGroups, activeSessions, newUsers] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { status: "ACTIVE", role: "USER" } }),
    db.user.count({ where: { status: "SUSPENDED" } }),
    db.report.count({ where: { status: { in: ["OPEN", "REVIEWING"] } } }),
    db.chatGroup.count({ where: { status: "ACTIVE" } }),
    db.session.count({ where: { revokedAt: null, expiresAt: { gt: new Date() }, user: { status: "ACTIVE" } } }),
    db.user.count({ where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } }),
  ]);
  res.json({ totalUsers, activeUsers, suspendedUsers, openReports, activeGroups, activeSessions, newUsers });
}));

router.get("/users", asyncRoute(async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  const status = typeof req.query.status === "string" && ["ACTIVE", "SUSPENDED"].includes(req.query.status) ? req.query.status : undefined;
  const page = Math.max(1, Math.min(500, Number(req.query.page) || 1));
  const pageSize = 25;
  const where = {
    ...(status ? { status } : {}),
    ...(query ? { OR: [{ displayName: { contains: query } }, { phone: { contains: query } }] } : {}),
  };
  const [users, total] = await Promise.all([
    db.user.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    db.user.count({ where }),
  ]);
  res.json({ users: users.map(publicUser), total, page, pageSize });
}));

router.post("/users", asyncRoute(async (req, res) => {
  const parsed = userCreateSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "Completează numele, telefonul și o parolă temporară de cel puțin 12 caractere.", "INVALID_USER");
  let phone: string;
  try {
    phone = normalizePhone(parsed.data.phone);
    validateNewPassword(parsed.data.temporaryPassword);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Datele contului nu sunt valide.", "INVALID_USER");
  }
  const passwordHash = await argon2.hash(parsed.data.temporaryPassword, ARGON2_OPTIONS);
  try {
    const user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          displayName: parsed.data.displayName,
          phone,
          passwordHash,
          role: "USER",
          status: "ACTIVE",
          mustChangePassword: true,
        },
      });
      await writeAudit(tx, req.auth!.user.id, "USER.CREATED", "User", created.id, { status: "ACTIVE" });
      return created;
    });
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      throw new HttpError(409, "Există deja un cont cu acest număr de telefon.", "PHONE_ALREADY_USED");
    }
    throw error;
  }
}));

router.patch("/users/:id/status", asyncRoute(async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "Starea contului nu este validă.", "INVALID_STATUS");
  const target = await db.user.findUnique({ where: { id: routeId(req) } });
  if (!target) throw new HttpError(404, "Contul nu a fost găsit.", "USER_NOT_FOUND");
  if (target.role === "SUPER_ADMIN") throw new HttpError(403, "Contul principal de administrator nu poate fi suspendat din acest panou.", "PRIMARY_ADMIN_PROTECTED");
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: target.id }, data: { status: parsed.data.status } });
    if (parsed.data.status === "SUSPENDED") {
      await tx.session.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await writeAudit(tx, req.auth!.user.id, `USER.${parsed.data.status}`, "User", target.id, { previousStatus: target.status });
  });
  res.json({ ok: true });
}));

router.post("/users/:id/require-password-change", asyncRoute(async (req, res) => {
  const target = await db.user.findUnique({ where: { id: routeId(req) } });
  if (!target) throw new HttpError(404, "Contul nu a fost găsit.", "USER_NOT_FOUND");
  if (target.role === "SUPER_ADMIN") throw new HttpError(403, "Schimbarea parolei administratorului se face din contul acestuia.", "PRIMARY_ADMIN_PROTECTED");
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: target.id }, data: { mustChangePassword: true } });
    await tx.session.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await writeAudit(tx, req.auth!.user.id, "USER.PASSWORD_CHANGE_REQUIRED", "User", target.id);
  });
  res.status(204).end();
}));

router.delete("/users/:id/sessions", asyncRoute(async (req, res) => {
  const target = await db.user.findUnique({ where: { id: routeId(req) }, select: { id: true } });
  if (!target) throw new HttpError(404, "Contul nu a fost găsit.", "USER_NOT_FOUND");
  const result = await db.$transaction(async (tx) => {
    const revoked = await tx.session.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await writeAudit(tx, req.auth!.user.id, "USER.SESSIONS_REVOKED", "User", target.id, { count: revoked.count });
    return revoked;
  });
  res.json({ revoked: result.count });
}));

router.get("/reports", asyncRoute(async (req, res) => {
  const status = typeof req.query.status === "string" && ["OPEN", "REVIEWING", "RESOLVED", "DISMISSED"].includes(req.query.status) ? req.query.status : undefined;
  const reports = await db.report.findMany({
    where: status ? { status } : undefined,
    include: { submitter: { select: { id: true, displayName: true, phone: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json({ reports });
}));

router.patch("/reports/:id/status", asyncRoute(async (req, res) => {
  const parsed = reportStatusSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "Starea raportării nu este validă.", "INVALID_REPORT_STATUS");
  const report = await db.report.findUnique({ where: { id: routeId(req) }, select: { id: true, status: true } });
  if (!report) throw new HttpError(404, "Raportarea nu a fost găsită.", "REPORT_NOT_FOUND");
  await db.$transaction(async (tx) => {
    await tx.report.update({ where: { id: report.id }, data: { status: parsed.data.status } });
    await writeAudit(tx, req.auth!.user.id, `REPORT.${parsed.data.status}`, "Report", report.id, { previousStatus: report.status });
  });
  res.status(204).end();
}));

router.get("/groups", asyncRoute(async (req, res) => {
  const groups = await db.chatGroup.findMany({
    where: typeof req.query.status === "string" && ["ACTIVE", "SUSPENDED"].includes(req.query.status) ? { status: req.query.status } : undefined,
    orderBy: { createdAt: "desc" },
  });
  res.json({ groups });
}));

router.post("/groups", asyncRoute(async (req, res) => {
  const parsed = groupCreateSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "Verifică numele, descrierea și vizibilitatea grupului.", "INVALID_GROUP");
  const group = await db.$transaction(async (tx) => {
    const created = await tx.chatGroup.create({ data: parsed.data });
    await writeAudit(tx, req.auth!.user.id, "GROUP.CREATED", "Group", created.id, { visibility: created.visibility });
    return created;
  });
  res.status(201).json({ group });
}));

router.patch("/groups/:id", asyncRoute(async (req, res) => {
  const parsed = groupPatchSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "Nu există setări valide de actualizat.", "INVALID_GROUP_UPDATE");
  const prior = await db.chatGroup.findUnique({ where: { id: routeId(req) } });
  if (!prior) throw new HttpError(404, "Grupul nu a fost găsit.", "GROUP_NOT_FOUND");
  const group = await db.$transaction(async (tx) => {
    const updated = await tx.chatGroup.update({ where: { id: prior.id }, data: parsed.data });
    await writeAudit(tx, req.auth!.user.id, "GROUP.UPDATED", "Group", prior.id, parsed.data);
    return updated;
  });
  res.json({ group });
}));

router.get("/settings", asyncRoute(async (_req, res) => {
  const stored = await db.appSetting.findMany();
  const settings: Record<string, boolean> = { ...DEFAULT_SETTINGS };
  for (const item of stored) {
    if (item.key in settings) {
      try {
        const parsed: unknown = JSON.parse(item.value);
        if (typeof parsed === "boolean") settings[item.key] = parsed;
      } catch {
        // Ignore invalid persisted values and retain the safe default.
      }
    }
  }
  res.json({ settings, note: "Cheile API și parolele serviciilor rămân în variabilele secrete ale deploymentului." });
}));

router.patch("/settings", asyncRoute(async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "Setările trimise nu sunt valide.", "INVALID_SETTINGS");
  await db.$transaction(async (tx) => {
    for (const [key, value] of Object.entries(parsed.data)) {
      if (typeof value !== "boolean") continue;
      await tx.appSetting.upsert({
        where: { key },
        create: { key, value: JSON.stringify(value) },
        update: { value: JSON.stringify(value) },
      });
    }
    await writeAudit(tx, req.auth!.user.id, "SETTINGS.UPDATED", "AppSetting", undefined, parsed.data);
  });
  res.status(204).end();
}));

router.get("/sessions", asyncRoute(async (req, res) => {
  const sessions = await db.session.findMany({
    where: { revokedAt: null, expiresAt: { gt: new Date() }, user: { status: "ACTIVE" } },
    include: { user: { select: { id: true, displayName: true, phone: true, role: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json({ sessions: sessions.map((session) => ({
    id: session.id,
    userId: session.userId,
    user: session.user,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    userAgent: session.userAgent,
    isCurrent: session.tokenHash === req.auth!.tokenHash,
  })) });
}));

router.delete("/sessions/:id", asyncRoute(async (req, res) => {
  const target = await db.session.findUnique({ where: { id: routeId(req) }, select: { id: true, userId: true, revokedAt: true } });
  if (!target) throw new HttpError(404, "Sesiunea nu a fost găsită.", "SESSION_NOT_FOUND");
  await db.$transaction(async (tx) => {
    await tx.session.update({ where: { id: target.id }, data: { revokedAt: target.revokedAt ?? new Date() } });
    await writeAudit(tx, req.auth!.user.id, "SESSION.REVOKED", "Session", target.id, { userId: target.userId });
  });
  res.status(204).end();
}));

router.get("/audit", asyncRoute(async (req, res) => {
  const page = Math.max(1, Math.min(500, Number(req.query.page) || 1));
  const pageSize = 40;
  const [events, total] = await Promise.all([
    db.auditLog.findMany({
      include: { actor: { select: { id: true, displayName: true, phone: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.auditLog.count(),
  ]);
  res.json({ events, total, page, pageSize });
}));

router.get("/system", asyncRoute(async (_req, res) => {
  let database = "healthy";
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    database = "unavailable";
  }
  res.json({
    app: "ChaTiganu Admin",
    environment: process.env.NODE_ENV ?? "development",
    node: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
    database,
    integrations: [
      { key: "smsOtp", label: "SMS / OTP", credentialsPresent: Boolean(process.env.SMS_PROVIDER_URL && process.env.SMS_PROVIDER_API_KEY), state: "not_connected" },
      { key: "email", label: "Email", credentialsPresent: Boolean(process.env.MAIL_PROVIDER_URL && process.env.MAIL_PROVIDER_API_KEY), state: "not_connected" },
    ],
    privacy: "API-ul administrativ nu expune mesaje, chei de criptare sau corpuri de conversații.",
  });
}));

export default router;
