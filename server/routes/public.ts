import { Router } from "express";
import { db } from "../db.js";
import { asyncRoute } from "../http.js";

const router = Router();

router.get("/config", asyncRoute(async (_req, res) => {
  const stored = await db.appSetting.findMany({ where: { key: { in: ["maintenanceMode", "groupsEnabled"] } } });
  const config = { registrationEnabled: false, maintenanceMode: false, groupsEnabled: true };
  for (const item of stored) {
    if (item.key !== "maintenanceMode" && item.key !== "groupsEnabled") continue;
    try {
      const value: unknown = JSON.parse(item.value);
      if (typeof value === "boolean") config[item.key] = value;
    } catch {
      // Keep the safe default when stored configuration is malformed.
    }
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(config);
}));

export default router;
