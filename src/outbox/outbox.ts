/**
 * Transactional outbox. Domain changes and the events describing them are
 * written in the same transaction; a relay publishes them afterwards with
 * at-least-once delivery. Consumers dedupe by `id`. This avoids the classic
 * "order saved but confirmation email never sent" (or the reverse) failure.
 */
export interface OutboxMessage {
  id: string;
  topic: string;
  payload: unknown;
  createdAt: number;
  publishedAt?: number;
  attempts: number;
}

export class Outbox {
  private readonly messages: OutboxMessage[] = [];
  private seq = 0;

  add(topic: string, payload: unknown, at: number): OutboxMessage {
    const m = { id: `evt_${++this.seq}`, topic, payload, createdAt: at, attempts: 0 };
    this.messages.push(m);
    return m;
  }

  pending(): OutboxMessage[] {
    return this.messages.filter((m) => !m.publishedAt);
  }

  all(): readonly OutboxMessage[] {
    return this.messages;
  }

  /** Relay: publish pending messages in order; failures stay pending for the next run. */
  async relay(publish: (m: OutboxMessage) => Promise<void>, now: () => number): Promise<{ published: number; failed: number }> {
    let published = 0;
    let failed = 0;
    for (const m of this.pending()) {
      m.attempts++;
      try {
        await publish(m);
        m.publishedAt = now();
        published++;
      } catch {
        failed++;
        break; // preserve per-stream ordering: stop at the first failure
      }
    }
    return { published, failed };
  }
}
