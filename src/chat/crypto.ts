export type ChatIdentity = {
  ecdhPublicKey: string;
  signingPublicKey: string;
  ecdhPrivateKey: CryptoKey;
  signingPrivateKey: CryptoKey;
};

export type PublicIdentity = Pick<ChatIdentity, "ecdhPublicKey" | "signingPublicKey">;

export type EncryptedEnvelope = {
  clientMessageId: string;
  ciphertext: string;
  iv: string;
  salt: string;
  signature: string;
};

export type ChatMessage = EncryptedEnvelope & {
  id: string;
  conversationId: string;
  senderId: string;
  recipientId: string;
  senderEcdhPublicKey: string;
  senderSigningPublicKey: string;
  createdAt: string;
};

const encoder = new TextEncoder();

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(standard + "=".repeat((4 - standard.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function createChatIdentity(): Promise<ChatIdentity> {
  const ecdh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const ecdhPublicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", ecdh.publicKey)));
  const ecdhPrivateJwk = await crypto.subtle.exportKey("jwk", ecdh.privateKey);
  const ecdhPrivateKey = await crypto.subtle.importKey("jwk", ecdhPrivateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);

  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const signingPublicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", signing.publicKey)));
  const signingPrivateJwk = await crypto.subtle.exportKey("jwk", signing.privateKey);
  const signingPrivateKey = await crypto.subtle.importKey("jwk", signingPrivateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return { ecdhPublicKey, signingPublicKey, ecdhPrivateKey, signingPrivateKey };
}

export async function getFingerprint(identity: PublicIdentity): Promise<string> {
  const input = encoder.encode(`${identity.ecdhPublicKey}.${identity.signingPublicKey}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const hex = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
  return hex.match(/.{1,8}/g)?.join(" ") ?? hex;
}

function serializeEnvelope(fields: { clientMessageId: string; conversationId: string; senderId: string; recipientId: string; ciphertext: string; iv: string; salt: string }) {
  // Keep this field order in sync with server/chat-protocol.ts.
  return JSON.stringify([fields.clientMessageId, fields.conversationId, fields.senderId, fields.recipientId, fields.ciphertext, fields.iv, fields.salt]);
}

async function deriveMessageKey(privateKey: CryptoKey, otherPublicKey: string, salt: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>) {
  const peerKey = await crypto.subtle.importKey("spki", decodeBase64Url(otherPublicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedSecret = await crypto.subtle.deriveBits({ name: "ECDH", public: peerKey }, privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptMessage(input: {
  text: string;
  conversationId: string;
  senderId: string;
  recipientId: string;
  identity: ChatIdentity;
  recipient: PublicIdentity;
}): Promise<EncryptedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const info = encoder.encode(`chatigan-v1|${input.conversationId}|${input.senderId}|${input.recipientId}`);
  const key = await deriveMessageKey(input.identity.ecdhPrivateKey, input.recipient.ecdhPublicKey, salt, info);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(input.text));
  const ciphertext = encodeBase64Url(new Uint8Array(encrypted));
  const ivText = encodeBase64Url(iv);
  const saltText = encodeBase64Url(salt);
  const clientMessageId = crypto.randomUUID();
  const serialized = serializeEnvelope({ clientMessageId, conversationId: input.conversationId, senderId: input.senderId, recipientId: input.recipientId, ciphertext, iv: ivText, salt: saltText });
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, input.identity.signingPrivateKey, encoder.encode(serialized));
  return { clientMessageId, ciphertext, iv: ivText, salt: saltText, signature: encodeBase64Url(new Uint8Array(signature)) };
}

export async function decryptMessage(input: {
  message: ChatMessage;
  localUserId: string;
  identity: ChatIdentity;
  partner: PublicIdentity;
}): Promise<string> {
  const { message } = input;
  const senderPublicKey = await crypto.subtle.importKey("spki", decodeBase64Url(message.senderSigningPublicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signed = serializeEnvelope({
    clientMessageId: message.clientMessageId,
    conversationId: message.conversationId,
    senderId: message.senderId,
    recipientId: message.recipientId,
    ciphertext: message.ciphertext,
    iv: message.iv,
    salt: message.salt,
  });
  const signatureValid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, senderPublicKey, decodeBase64Url(message.signature), encoder.encode(signed));
  if (!signatureValid) throw new Error("Semnătura mesajului nu este validă.");

  const peerPublicKey = message.senderId === input.localUserId ? input.partner.ecdhPublicKey : message.senderEcdhPublicKey;
  const salt = decodeBase64Url(message.salt);
  const iv = decodeBase64Url(message.iv);
  const info = encoder.encode(`chatigan-v1|${message.conversationId}|${message.senderId}|${message.recipientId}`);
  const key = await deriveMessageKey(input.identity.ecdhPrivateKey, peerPublicKey, salt, info);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, decodeBase64Url(message.ciphertext));
  return new TextDecoder().decode(plaintext);
}
