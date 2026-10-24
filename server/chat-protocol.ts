import { createPublicKey, verify } from "node:crypto";

export type SignedEnvelopeFields = {
  clientMessageId: string;
  conversationId: string;
  senderId: string;
  recipientId: string;
  ciphertext: string;
  iv: string;
  salt: string;
};

/** Keep this field order in sync with src/chat/crypto.ts. */
export function serializeSignedEnvelope(fields: SignedEnvelopeFields): string {
  return JSON.stringify([
    fields.clientMessageId,
    fields.conversationId,
    fields.senderId,
    fields.recipientId,
    fields.ciphertext,
    fields.iv,
    fields.salt,
  ]);
}

export function isP256PublicKey(value: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(value, "base64url"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch {
    return false;
  }
}

export function verifyEnvelopeSignature(publicKeyText: string, signatureText: string, serialized: string): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeyText, "base64url"),
      format: "der",
      type: "spki",
    });
    if (publicKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") return false;
    const signature = Buffer.from(signatureText, "base64url");
    if (signature.length !== 64) return false;
    return verify("sha256", Buffer.from(serialized, "utf8"), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    return false;
  }
}
