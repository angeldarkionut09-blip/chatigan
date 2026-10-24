import "dotenv/config";
import argon2 from "argon2";
import { db } from "./db.js";
import { ARGON2_OPTIONS, normalizePhone } from "./security.js";
import { writeAudit } from "./audit.js";

const BOOTSTRAP_LOCK = "admin.bootstrap.completed";

async function bootstrap() {
  const existingLock = await db.systemState.findUnique({ where: { key: BOOTSTRAP_LOCK } });
  if (existingLock) {
    console.log("Bootstrap-ul administratorului a fost deja finalizat; nu s-au făcut modificări.");
    return;
  }
  const displayName = process.env.ADMIN_BOOTSTRAP_NAME?.trim();
  const rawPhone = process.env.ADMIN_BOOTSTRAP_PHONE;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!displayName || !rawPhone || !password) {
    throw new Error("Configurează ADMIN_BOOTSTRAP_NAME, ADMIN_BOOTSTRAP_PHONE și ADMIN_BOOTSTRAP_PASSWORD în mediul securizat.");
  }
  if (displayName.length > 80 || password.length < 8 || password.length > 128) {
    throw new Error("Numele sau parola inițială nu respectă limitele permise.");
  }
  const phone = normalizePhone(rawPhone);
  const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);
  const result = await db.$transaction(async (tx) => {
    const lock = await tx.systemState.findUnique({ where: { key: BOOTSTRAP_LOCK } });
    if (lock) return "already-completed" as const;

    const existing = await tx.user.findUnique({ where: { phone } });
    if (existing && existing.role !== "SUPER_ADMIN") {
      throw new Error("Numărul este deja asociat unui cont obișnuit; bootstrap-ul nu îi schimbă rolul.");
    }

    if (!existing) {
      const admin = await tx.user.create({
        data: {
          displayName,
          phone,
          passwordHash,
          role: "SUPER_ADMIN",
          status: "ACTIVE",
          mustChangePassword: true,
        },
      });
      await writeAudit(tx, admin.id, "ADMIN_BOOTSTRAP_COMPLETED", "User", admin.id, { source: "environment" });
    }

    await tx.systemState.create({ data: { key: BOOTSTRAP_LOCK, value: "true" } });
    return existing ? "existing-admin" as const : "created" as const;
  });

  if (result === "created") console.log("Contul administratorului a fost creat. Schimbarea parolei este obligatorie la prima autentificare.");
  else console.log("Contul administratorului exista deja; parola și rolul au rămas neschimbate.");
}

bootstrap()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Bootstrap-ul a eșuat.";
    console.error(`[admin:bootstrap] ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => db.$disconnect());
