import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";

export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function normalizePhone(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/[\s().-]/g, "");
  if (!/^\+?\d{9,15}$/.test(normalized)) {
    throw new Error("Numărul de telefon trebuie să conțină între 9 și 15 cifre.");
  }
  return normalized;
}

export function validateNewPassword(value: string): void {
  if (value.length < 12 || value.length > 128) {
    throw new Error("Parola nouă trebuie să aibă între 12 și 128 de caractere.");
  }
}

export function isConfiguredThrottleSecret(value: string | undefined): value is string {
  return !!value && value.length >= 32 && !/(?:replace|change[-_ ]?me|placeholder|inlocuieste)/i.test(value);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function loginThrottleKey(phone: string, ip: string, secret: string): string {
  return createHmac("sha256", secret).update(`${phone}\u0000${ip}`).digest("hex");
}

export async function verifyPassword(hash: string, candidate: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, candidate);
  } catch {
    return false;
  }
}
