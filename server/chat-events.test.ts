import assert from "node:assert/strict";
import test from "node:test";
import { ChatEventHub, type ChatEvent } from "./chat-events.js";

const event: ChatEvent = {
  type: "message",
  conversationId: "conversation-1",
  messageId: "message-1",
  senderId: "sender-1",
  recipientId: "recipient-1",
  createdAt: "2026-10-24T12:00:00.000Z",
};

test("chat events reach only the authenticated participants' subscriptions", () => {
  const hub = new ChatEventHub();
  const senderEvents: ChatEvent[] = [];
  const recipientEvents: ChatEvent[] = [];
  const unrelatedEvents: ChatEvent[] = [];
  hub.subscribe(event.senderId, (value) => senderEvents.push(value));
  hub.subscribe(event.recipientId, (value) => recipientEvents.push(value));
  hub.subscribe("unrelated-user", (value) => unrelatedEvents.push(value));

  hub.publish(event);

  assert.deepEqual(senderEvents, [event]);
  assert.deepEqual(recipientEvents, [event]);
  assert.deepEqual(unrelatedEvents, []);
});

test("closing a chat stream removes its listener exactly once", () => {
  const hub = new ChatEventHub();
  const received: ChatEvent[] = [];
  const close = hub.subscribe(event.recipientId, (value) => received.push(value));
  assert.equal(hub.subscriberCount(event.recipientId), 1);

  close();
  close();
  hub.publish(event);

  assert.equal(hub.subscriberCount(event.recipientId), 0);
  assert.deepEqual(received, []);
});

test("a failed stream listener does not stop delivery to other streams", () => {
  const hub = new ChatEventHub();
  const received: ChatEvent[] = [];
  hub.subscribe(event.recipientId, () => { throw new Error("closed stream"); });
  hub.subscribe(event.recipientId, (value) => received.push(value));

  hub.publish(event);

  assert.deepEqual(received, [event]);
});
