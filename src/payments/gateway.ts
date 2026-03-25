import { createHmac, timingSafeEqual } from "node:crypto";

export interface PaymentIntent {
  id: string;
  orderId: string;
  amountCents: number;
  status: "requires_payment" | "succeeded" | "failed";
}

/** Port to a card/EFT provider (Yoco, Peach, Stripe). Calls carry an idempotency key. */
export interface PaymentGateway {
  createIntent(orderId: string, amountCents: number, idempotencyKey: string): Promise<PaymentIntent>;
  refund(intentId: string, amountCents: number, idempotencyKey: string): Promise<{ id: string }>;
}

export interface PaymentWebhook {
  intentId: string;
  orderId: string;
  status: "succeeded" | "failed";
  amountCents: number;
  eventId: string;
}

export function verifyWebhookSignature(rawBody: string, signature: string | undefined, secret: string, toleranceSec = 300, now = Date.now()): boolean {
  // Header format: t=<unix>,v1=<hex hmac of "t.body">  (timestamped to block replays)
  if (!signature) return false;
  const parts = Object.fromEntries(signature.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Deterministic fake used by tests and local demos. */
export class FakeGateway implements PaymentGateway {
  readonly intents = new Map<string, PaymentIntent>();
  readonly refunds: Array<{ intentId: string; amountCents: number }> = [];
  private readonly byKey = new Map<string, PaymentIntent>();

  async createIntent(orderId: string, amountCents: number, key: string) {
    const prior = this.byKey.get(key);
    if (prior) return prior;
    const intent: PaymentIntent = { id: `pi_${this.intents.size + 1}`, orderId, amountCents, status: "requires_payment" };
    this.intents.set(intent.id, intent);
    this.byKey.set(key, intent);
    return intent;
  }

  async refund(intentId: string, amountCents: number, key: string) {
    if (!this.byKey.has(key)) {
      this.byKey.set(key, this.intents.get(intentId)!);
      this.refunds.push({ intentId, amountCents });
    }
    return { id: `re_${key}` };
  }
}
