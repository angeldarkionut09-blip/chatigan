export type ChatEvent = {
  type: "message";
  conversationId: string;
  messageId: string;
  senderId: string;
  recipientId: string;
  createdAt: string;
};

type ChatEventListener = (event: ChatEvent) => void;

/** Process-local event fanout for the single-instance persistent-volume deployment. */
export class ChatEventHub {
  private readonly listeners = new Map<string, Set<ChatEventListener>>();

  subscribe(userId: string, listener: ChatEventListener): () => void {
    const subscribers = this.listeners.get(userId) ?? new Set<ChatEventListener>();
    subscribers.add(listener);
    this.listeners.set(userId, subscribers);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      subscribers.delete(listener);
      if (subscribers.size === 0) this.listeners.delete(userId);
    };
  }

  publish(event: ChatEvent): void {
    for (const userId of new Set([event.senderId, event.recipientId])) {
      for (const listener of [...(this.listeners.get(userId) ?? [])]) {
        try {
          listener(event);
        } catch {
          // A closed stream must not prevent delivery to another active stream.
        }
      }
    }
  }

  subscriberCount(userId: string): number {
    return this.listeners.get(userId)?.size ?? 0;
  }
}

export const chatEventHub = new ChatEventHub();
