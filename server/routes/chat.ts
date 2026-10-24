import { Router, type Request } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { asyncRoute, HttpError, requireAuth } from "../http.js";
import { isP256PublicKey, serializeSignedEnvelope, verifyEnvelopeSignature } from "../chat-protocol.js";
import { chatEventHub } from "../chat-events.js";

const router = Router();
const publicKeySchema = z.string().min(80).max(600).regex(/^[A-Za-z0-9_-]+$/);
const identitySchema = z.object({ ecdhPublicKey: publicKeySchema, signingPublicKey: publicKeySchema });
const SEND_WINDOW_MS = 60_000;
const SEND_LIMIT_PER_WINDOW = 60;
const MAX_CHAT_STREAMS_PER_USER = 8;
const CHAT_STREAM_HEARTBEAT_MS = 20_000;
const sendWindows = new Map<string, { startedAt: number; count: number }>();
const messageSchema = z.object({
  clientMessageId: z.string().uuid(),
  ciphertext: z.string().min(16).max(22_000).regex(/^[A-Za-z0-9_-]+$/),
  iv: z.string().length(16).regex(/^[A-Za-z0-9_-]+$/),
  salt: z.string().length(22).regex(/^[A-Za-z0-9_-]+$/),
  signature: z.string().length(86).regex(/^[A-Za-z0-9_-]+$/),
});

router.use(requireAuth, (req, _res, next) => {
  if (req.auth!.user.role !== "USER") return next(new HttpError(403, "Chatul este disponibil numai conturilor obișnuite.", "CHAT_USER_REQUIRED"));
  next();
});

function routeId(req: Request): string {
  const value = req.params.id;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  throw new HttpError(400, "Identificatorul conversației nu este valid.", "INVALID_ID");
}

function pairFor(userA: string, userB: string) {
  const userLowId = userA.localeCompare(userB) <= 0 ? userA : userB;
  const userHighId = userA.localeCompare(userB) <= 0 ? userB : userA;
  return { userLowId, userHighId, pairKey: `${userLowId}:${userHighId}` };
}

router.get("/events", asyncRoute(async (req, res) => {
  const userId = req.auth!.user.id;
  if (chatEventHub.subscriberCount(userId) >= MAX_CHAT_STREAMS_PER_USER) {
    throw new HttpError(429, "Ai prea multe conexiuni de chat deschise.", "CHAT_STREAM_LIMITED");
  }
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  const unsubscribe = chatEventHub.subscribe(userId, (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  res.flushHeaders();
  res.write(": connected\n\n");
  let closed = false;
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      unsubscribe();
      clearInterval(heartbeat);
      return;
    }
    void db.session.findFirst({
      where: {
        id: req.auth!.sessionId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        user: { status: "ACTIVE" },
      },
      select: { id: true },
    }).then((session) => {
      if (session) {
        if (!res.writableEnded && !res.destroyed) res.write(": keep-alive\n\n");
        return;
      }
      if (!closed) {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        if (!res.writableEnded) res.end();
      }
    }).catch(() => {
      if (!closed) {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        if (!res.writableEnded) res.end();
      }
    });
  }, CHAT_STREAM_HEARTBEAT_MS);
  heartbeat.unref();
  res.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  });
}));

router.get("/identity", asyncRoute(async (req, res) => {
  const user = await db.user.findUnique({
    where: { id: req.auth!.user.id },
    select: { chatPublicKey: true, chatSigningPublicKey: true },
  });
  if (!user) throw new HttpError(401, "Autentificarea este necesară.", "UNAUTHENTICATED");
  res.setHeader("Cache-Control", "no-store");
  res.json({ identity: user.chatPublicKey && user.chatSigningPublicKey ? {
    ecdhPublicKey: user.chatPublicKey,
    signingPublicKey: user.chatSigningPublicKey,
  } : null });
}));

router.post("/identity", asyncRoute(async (req, res) => {
  const parsed = identitySchema.safeParse(req.body);
  if (!parsed.success || !isP256PublicKey(parsed.data.ecdhPublicKey) || !isP256PublicKey(parsed.data.signingPublicKey)) {
    throw new HttpError(400, "Cheile publice nu sunt chei P-256 valide.", "INVALID_CHAT_IDENTITY");
  }
  const userId = req.auth!.user.id;
  const prior = await db.user.findUnique({ where: { id: userId }, select: { chatPublicKey: true, chatSigningPublicKey: true } });
  if (!prior) throw new HttpError(401, "Autentificarea este necesară.", "UNAUTHENTICATED");
  if (prior.chatPublicKey || prior.chatSigningPublicKey) {
    if (prior.chatPublicKey === parsed.data.ecdhPublicKey && prior.chatSigningPublicKey === parsed.data.signingPublicKey) {
      return res.json({ ok: true, unchanged: true });
    }
    throw new HttpError(409, "Acest cont are deja o identitate criptografică. Cheia nu poate fi înlocuită automat.", "CHAT_IDENTITY_EXISTS");
  }
  const updated = await db.user.updateMany({
    where: { id: userId, chatPublicKey: null, chatSigningPublicKey: null },
    data: { chatPublicKey: parsed.data.ecdhPublicKey, chatSigningPublicKey: parsed.data.signingPublicKey },
  });
  if (!updated.count) throw new HttpError(409, "Identitatea a fost inițializată în altă sesiune. Reîncarcă pagina.", "CHAT_IDENTITY_EXISTS");
  res.status(201).json({ ok: true });
}));

router.get("/contacts", asyncRoute(async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  if (query.length < 2) return res.json({ contacts: [] });
  const contacts = await db.user.findMany({
    where: {
      id: { not: req.auth!.user.id },
      status: "ACTIVE",
      role: "USER",
      chatPublicKey: { not: null },
      chatSigningPublicKey: { not: null },
      displayName: { contains: query },
    },
    select: { id: true, displayName: true, chatPublicKey: true, chatSigningPublicKey: true },
    orderBy: { displayName: "asc" },
    take: 20,
  });
  res.setHeader("Cache-Control", "no-store");
  res.json({ contacts: contacts.map((contact) => ({
    id: contact.id,
    displayName: contact.displayName,
    ecdhPublicKey: contact.chatPublicKey,
    signingPublicKey: contact.chatSigningPublicKey,
  })) });
}));

router.get("/conversations", asyncRoute(async (req, res) => {
  const userId = req.auth!.user.id;
  const conversations = await db.conversation.findMany({
    where: {
      OR: [{ userLowId: userId }, { userHighId: userId }],
      userLow: { status: "ACTIVE", role: "USER" },
      userHigh: { status: "ACTIVE", role: "USER" },
    },
    include: {
      userLow: { select: { id: true, displayName: true, chatPublicKey: true, chatSigningPublicKey: true } },
      userHigh: { select: { id: true, displayName: true, chatPublicKey: true, chatSigningPublicKey: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  res.setHeader("Cache-Control", "no-store");
  res.json({ conversations: conversations.map((conversation) => {
    const partner = conversation.userLowId === userId ? conversation.userHigh : conversation.userLow;
    return {
      id: conversation.id,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      partner: {
        id: partner.id,
        displayName: partner.displayName,
        ecdhPublicKey: partner.chatPublicKey,
        signingPublicKey: partner.chatSigningPublicKey,
      },
      lastMessage: conversation.messages[0] ?? null,
    };
  }) });
}));

router.post("/conversations", asyncRoute(async (req, res) => {
  const parsed = z.object({ userId: z.string().min(1).max(64) }).safeParse(req.body);
  if (!parsed.success || parsed.data.userId === req.auth!.user.id) {
    throw new HttpError(400, "Alege un alt utilizator pentru conversație.", "INVALID_CHAT_PARTNER");
  }
  const [me, partner] = await Promise.all([
    db.user.findUnique({ where: { id: req.auth!.user.id }, select: { id: true, status: true, chatPublicKey: true, chatSigningPublicKey: true } }),
    db.user.findUnique({ where: { id: parsed.data.userId }, select: { id: true, role: true, status: true, chatPublicKey: true, chatSigningPublicKey: true } }),
  ]);
  if (!me || me.status !== "ACTIVE") throw new HttpError(401, "Autentificarea este necesară.", "UNAUTHENTICATED");
  if (!partner || partner.role !== "USER" || partner.status !== "ACTIVE") throw new HttpError(404, "Utilizatorul nu este disponibil.", "CHAT_CONTACT_UNAVAILABLE");
  if (!me.chatPublicKey || !me.chatSigningPublicKey || !partner.chatPublicKey || !partner.chatSigningPublicKey) {
    throw new HttpError(409, "Ambii utilizatori trebuie să inițializeze chatul pe dispozitivul lor.", "CHAT_IDENTITY_NOT_READY");
  }
  const pair = pairFor(me.id, partner.id);
  const conversation = await db.conversation.upsert({
    where: { pairKey: pair.pairKey },
    create: pair,
    update: {},
    select: { id: true, createdAt: true, updatedAt: true },
  });
  res.status(201).json({ conversation: { ...conversation, partner: { id: partner.id } } });
}));

router.get("/conversations/:id/messages", asyncRoute(async (req, res) => {
  const conversationId = routeId(req);
  const userId = req.auth!.user.id;
  const conversation = await db.conversation.findFirst({
    where: {
      id: conversationId,
      OR: [
        { userLowId: userId, userHigh: { role: "USER", status: "ACTIVE" } },
        { userHighId: userId, userLow: { role: "USER", status: "ACTIVE" } },
      ],
    },
    select: { id: true },
  });
  if (!conversation) throw new HttpError(404, "Conversația nu a fost găsită.", "CONVERSATION_NOT_FOUND");
  const beforeId = typeof req.query.beforeId === "string" ? req.query.beforeId.slice(0, 64) : undefined;
  let cursor: { id: string } | undefined;
  if (beforeId) {
    const exists = await db.message.findFirst({ where: { id: beforeId, conversationId }, select: { id: true } });
    if (!exists) throw new HttpError(400, "Cursorul mesajelor nu este valid.", "INVALID_MESSAGE_CURSOR");
    cursor = { id: exists.id };
  }
  const messages = await db.message.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(cursor ? { cursor, skip: 1 } : {}),
    take: 50,
    select: {
      id: true, clientMessageId: true, conversationId: true, senderId: true, recipientId: true,
      ciphertext: true, iv: true, salt: true, signature: true,
      senderEcdhPublicKey: true, senderSigningPublicKey: true, createdAt: true,
    },
  });
  res.setHeader("Cache-Control", "no-store");
  res.json({ messages: messages.reverse(), hasMore: messages.length === 50 });
}));

router.post("/conversations/:id/messages", asyncRoute(async (req, res) => {
  const conversationId = routeId(req);
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "Mesajul criptat nu are formatul acceptat.", "INVALID_ENCRYPTED_MESSAGE");
  const senderId = req.auth!.user.id;
  const conversation = await db.conversation.findFirst({
    where: {
      id: conversationId,
      OR: [
        { userLowId: senderId, userHigh: { role: "USER", status: "ACTIVE" } },
        { userHighId: senderId, userLow: { role: "USER", status: "ACTIVE" } },
      ],
    },
    select: { id: true, userLowId: true, userHighId: true },
  });
  if (!conversation) throw new HttpError(404, "Conversația nu a fost găsită.", "CONVERSATION_NOT_FOUND");
  const recipientId = conversation.userLowId === senderId ? conversation.userHighId : conversation.userLowId;
  const [sender, recipient, prior] = await Promise.all([
    db.user.findUnique({ where: { id: senderId }, select: { status: true, chatPublicKey: true, chatSigningPublicKey: true } }),
    db.user.findUnique({ where: { id: recipientId }, select: { role: true, status: true } }),
    db.message.findUnique({ where: { clientMessageId: parsed.data.clientMessageId } }),
  ]);
  if (!sender || sender.status !== "ACTIVE" || !recipient || recipient.role !== "USER" || recipient.status !== "ACTIVE") {
    throw new HttpError(403, "Un participant nu mai are acces la conversație.", "CHAT_PARTICIPANT_UNAVAILABLE");
  }
  if (!sender.chatPublicKey || !sender.chatSigningPublicKey || !isP256PublicKey(sender.chatPublicKey) || !isP256PublicKey(sender.chatSigningPublicKey)) {
    throw new HttpError(409, "Identitatea criptografică a expeditorului nu este disponibilă.", "CHAT_IDENTITY_NOT_READY");
  }
  if (prior) {
    if (prior.senderId === senderId && prior.conversationId === conversationId) return res.status(200).json({ message: prior });
    throw new HttpError(409, "Identificatorul mesajului a fost deja folosit.", "MESSAGE_ID_REUSED");
  }
  const now = Date.now();
  const window = sendWindows.get(senderId);
  if (!window || now - window.startedAt >= SEND_WINDOW_MS) sendWindows.set(senderId, { startedAt: now, count: 1 });
  else if (window.count >= SEND_LIMIT_PER_WINDOW) throw new HttpError(429, "Ai trimis prea multe mesaje. Așteaptă un minut și încearcă din nou.", "CHAT_RATE_LIMITED");
  else window.count += 1;
  if (sendWindows.size > 10_000) {
    for (const [id, entry] of sendWindows) if (now - entry.startedAt >= SEND_WINDOW_MS) sendWindows.delete(id);
  }
  const signedFields = {
    clientMessageId: parsed.data.clientMessageId,
    conversationId,
    senderId,
    recipientId,
    ciphertext: parsed.data.ciphertext,
    iv: parsed.data.iv,
    salt: parsed.data.salt,
  };
  if (!verifyEnvelopeSignature(sender.chatSigningPublicKey, parsed.data.signature, serializeSignedEnvelope(signedFields))) {
    throw new HttpError(400, "Semnătura mesajului nu este validă.", "INVALID_MESSAGE_SIGNATURE");
  }
  const message = await db.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        ...parsed.data,
        conversationId,
        senderId,
        recipientId,
        senderEcdhPublicKey: sender.chatPublicKey!,
        senderSigningPublicKey: sender.chatSigningPublicKey!,
      },
    });
    await tx.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
    return created;
  });
  chatEventHub.publish({
    type: "message",
    conversationId,
    messageId: message.id,
    senderId,
    recipientId,
    createdAt: message.createdAt.toISOString(),
  });
  res.status(201).json({ message });
}));

export default router;
