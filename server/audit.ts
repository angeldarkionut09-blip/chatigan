import type { Prisma, User } from "@prisma/client";
import { db } from "./db.js";

type AuditClient = Prisma.TransactionClient | typeof db;

export async function writeAudit(
  client: AuditClient,
  actorId: string | null,
  action: string,
  subjectType?: string,
  subjectId?: string,
  details?: Record<string, unknown>,
) {
  const safeDetails = details ? JSON.stringify(details) : undefined;
  return client.auditLog.create({
    data: { actorId, action, subjectType, subjectId, details: safeDetails },
  });
}

export function publicUser(user: User) {
  return {
    id: user.id,
    displayName: user.displayName,
    phone: user.phone,
    role: user.role,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };
}
