import assert from "node:assert/strict";
import test from "node:test";
import { createChatIdentity, decryptMessage, encryptMessage, type ChatMessage } from "../src/chat/crypto.js";
import { isP256PublicKey, serializeSignedEnvelope, verifyEnvelopeSignature } from "./chat-protocol.js";

test("two participants encrypt and decrypt a signed message without server-side plaintext", async () => {
  const alice = await createChatIdentity();
  const bob = await createChatIdentity();
  assert.equal(isP256PublicKey(alice.ecdhPublicKey), true);
  assert.equal(isP256PublicKey(alice.signingPublicKey), true);

  const fields = { conversationId: "conversation-1", senderId: "alice", recipientId: "bob" };
  const encrypted = await encryptMessage({
    ...fields,
    text: "Mesaj privat",
    identity: alice,
    recipient: { ecdhPublicKey: bob.ecdhPublicKey, signingPublicKey: bob.signingPublicKey },
  });
  const signed = serializeSignedEnvelope({ ...fields, ...encrypted });
  assert.equal(verifyEnvelopeSignature(alice.signingPublicKey, encrypted.signature, signed), true);
  assert.equal(encrypted.ciphertext.includes("Mesaj privat"), false);

  const message: ChatMessage = {
    ...encrypted,
    ...fields,
    id: "message-1",
    senderEcdhPublicKey: alice.ecdhPublicKey,
    senderSigningPublicKey: alice.signingPublicKey,
    createdAt: new Date().toISOString(),
  };
  const plaintext = await decryptMessage({
    message,
    localUserId: "bob",
    identity: bob,
    partner: { ecdhPublicKey: alice.ecdhPublicKey, signingPublicKey: alice.signingPublicKey },
  });
  assert.equal(plaintext, "Mesaj privat");
});

test("the signature rejects envelope changes", async () => {
  const alice = await createChatIdentity();
  const bob = await createChatIdentity();
  const fields = { conversationId: "conversation-2", senderId: "alice", recipientId: "bob" };
  const encrypted = await encryptMessage({
    ...fields,
    text: "Nu modifica",
    identity: alice,
    recipient: { ecdhPublicKey: bob.ecdhPublicKey, signingPublicKey: bob.signingPublicKey },
  });
  const replacement = encrypted.ciphertext[0] === "A" ? "B" : "A";
  const tampered = serializeSignedEnvelope({ ...fields, ...encrypted, ciphertext: `${replacement}${encrypted.ciphertext.slice(1)}` });
  assert.equal(verifyEnvelopeSignature(alice.signingPublicKey, encrypted.signature, tampered), false);
  const replayWithNewId = serializeSignedEnvelope({ ...fields, ...encrypted, clientMessageId: "00000000-0000-4000-8000-000000000001" });
  assert.equal(verifyEnvelopeSignature(alice.signingPublicKey, encrypted.signature, replayWithNewId), false);
});
