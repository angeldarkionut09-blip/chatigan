import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { writeAudit } from "../audit.js";
import { asyncRoute, HttpError, requireAuth } from "../http.js";

const router = Router();
const reportSchema = z.object({
  category: z.enum(["ABUSE", "HARASSMENT", "SPAM", "SAFETY", "OTHER"]),
  summary: z.string().trim().min(8).max(500),
  targetUserId: z.string().max(64).optional(),
});

router.post("/", requireAuth, asyncRoute(async (req, res) => {
  if (req.auth!.user.role !== "SUPER_ADMIN") {
    const maintenance = await db.appSetting.findUnique({ where: { key: "maintenanceMode" } });
    if (maintenance?.value === "true") throw new HttpError(503, "Raportările sunt temporar indisponibile în timpul mentenanței.", "MAINTENANCE_MODE");
  }
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "Alege categoria și adaugă un rezumat între 8 și 500 de caractere. Nu include textul mesajelor private.", "INVALID_REPORT");
  if (parsed.data.targetUserId && parsed.data.targetUserId === req.auth!.user.id) {
    throw new HttpError(400, "Nu poți raporta propriul cont.", "INVALID_REPORT_TARGET");
  }
  const report = await db.$transaction(async (tx) => {
    const created = await tx.report.create({
      data: {
        category: parsed.data.category,
        summary: parsed.data.summary,
        submitterId: req.auth!.user.id,
        targetUserId: parsed.data.targetUserId,
      },
    });
    await writeAudit(tx, req.auth!.user.id, "REPORT.SUBMITTED", "Report", created.id, { category: created.category });
    return created;
  });
  res.status(201).json({ id: report.id, status: report.status, createdAt: report.createdAt });
}));

export default router;
