import { randomUUID } from "node:crypto";
import type { CartLine, Product } from "../catalog/types.js";
import type { Inventory } from "../inventory/reservations.js";
import type { Outbox } from "../outbox/outbox.js";
import type { PaymentGateway, PaymentWebhook } from "../payments/gateway.js";
import { type Promotion, type Quote, quote } from "../pricing/engine.js";

export type OrderStatus = "awaiting_payment" | "paid" | "payment_failed" | "expired" | "cancelled" | "refunded";

export interface Order {
  id: string;
  customerId: string;
  status: OrderStatus;
  quote: Quote;
  reservationId: string;
  paymentIntentId: string;
  createdAt: number;
  history: Array<{ at: number; status: OrderStatus; note?: string }>;
}

export class PriceChanged extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`Price changed from ${expected} to ${actual}; please review your cart`);
  }
}
export class OrderConflict extends Error {}

export interface OrderDeps {
  catalog: Map<string, Product>;
  promotions: Promotion[];
  inventory: Inventory;
  payments: PaymentGateway;
  outbox: Outbox;
  now: () => number;
  shipping?: { flatCents: number; freeOverCents: number };
}

/**
 * Checkout saga:
 *
 *   price ─▶ verify customer-seen total ─▶ reserve stock ─▶ create payment intent ─▶ AWAITING_PAYMENT
 *      webhook succeeded ─▶ commit stock ─▶ PAID
 *      webhook failed     ─▶ release stock ─▶ PAYMENT_FAILED
 *      hold expires        ─▶ release stock ─▶ EXPIRED
 *      cancel after PAID   ─▶ refund + restock (compensation) ─▶ REFUNDED
 *
 * Each step that touches the outside world is idempotent, and every state change emits an outbox event.
 */
export class OrderService {
  private readonly orders = new Map<string, Order>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly processedWebhooks = new Set<string>();

  constructor(private readonly d: OrderDeps) {}

  async place(input: { customerId: string; lines: CartLine[]; couponCode?: string; expectedTotalCents: number; idempotencyKey: string }): Promise<Order> {
    const scopedKey = `${input.customerId}:${input.idempotencyKey}`;
    const prior = this.byIdempotencyKey.get(scopedKey);
    if (prior) return this.orders.get(prior)!;

    const q = quote({
      lines: input.lines, catalog: this.d.catalog, promotions: this.d.promotions, couponCode: input.couponCode,
      shipping: this.d.shipping ?? { flatCents: 9_900, freeOverCents: 75_000 },
    });
    // Never charge a different amount from what the customer saw.
    if (q.totalCents !== input.expectedTotalCents) throw new PriceChanged(input.expectedTotalCents, q.totalCents);

    const orderId = `ord_${randomUUID()}`;
    const reservation = this.d.inventory.reserve(orderId, q.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })));
    let intentId: string;
    try {
      intentId = (await this.d.payments.createIntent(orderId, q.totalCents, `intent:${orderId}`)).id;
    } catch (err) {
      this.d.inventory.release(reservation.id); // compensate: don't strand stock if the PSP is down
      throw err;
    }

    const now = this.d.now();
    const order: Order = {
      id: orderId, customerId: input.customerId, status: "awaiting_payment", quote: q, reservationId: reservation.id,
      paymentIntentId: intentId, createdAt: now, history: [{ at: now, status: "awaiting_payment" }],
    };
    this.orders.set(orderId, order);
    this.byIdempotencyKey.set(scopedKey, orderId);
    this.d.outbox.add("order.placed", { orderId, totalCents: q.totalCents, customerId: input.customerId }, now);
    return order;
  }

  /** Payment provider webhooks arrive at-least-once and possibly out of order. */
  handlePaymentWebhook(w: PaymentWebhook): Order | undefined {
    if (this.processedWebhooks.has(w.eventId)) return this.orders.get(w.orderId);
    const order = this.orders.get(w.orderId);
    if (!order || order.paymentIntentId !== w.intentId) return undefined;
    this.processedWebhooks.add(w.eventId);

    if (w.status === "succeeded") {
      if (w.amountCents !== order.quote.totalCents) {
        this.transition(order, order.status, `amount mismatch: paid ${w.amountCents}, expected ${order.quote.totalCents}; flagged for review`);
        this.d.outbox.add("order.payment_mismatch", { orderId: order.id }, this.d.now());
        return order;
      }
      if (order.status === "expired") {
        // Paid after the hold lapsed: try to re-reserve; if stock is gone, refund automatically.
        try {
          const r = this.d.inventory.reserve(order.id, order.quote.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })));
          order.reservationId = r.id;
        } catch {
          void this.d.payments.refund(order.paymentIntentId, w.amountCents, `refund:${order.id}`);
          this.transition(order, "refunded", "paid after expiry, stock no longer available");
          this.d.outbox.add("order.refunded", { orderId: order.id, reason: "late_payment_no_stock" }, this.d.now());
          return order;
        }
      } else if (order.status !== "awaiting_payment") {
        return order;
      }
      this.d.inventory.commit(order.reservationId);
      this.transition(order, "paid");
      this.d.outbox.add("order.paid", { orderId: order.id, totalCents: order.quote.totalCents }, this.d.now());
    } else if (order.status === "awaiting_payment") {
      this.d.inventory.release(order.reservationId);
      this.transition(order, "payment_failed");
      this.d.outbox.add("order.payment_failed", { orderId: order.id }, this.d.now());
    }
    return order;
  }

  /** Sweeper: run every minute. Releases stock for abandoned checkouts. */
  expireStale(holdMs = 10 * 60_000): string[] {
    const expired: string[] = [];
    for (const o of this.orders.values()) {
      if (o.status === "awaiting_payment" && this.d.now() - o.createdAt >= holdMs) {
        this.d.inventory.release(o.reservationId);
        this.transition(o, "expired");
        this.d.outbox.add("order.expired", { orderId: o.id }, this.d.now());
        expired.push(o.id);
      }
    }
    return expired;
  }

  async cancel(orderId: string, reason: string): Promise<Order> {
    const o = this.get(orderId);
    if (o.status === "awaiting_payment") {
      this.d.inventory.release(o.reservationId);
      this.transition(o, "cancelled", reason);
    } else if (o.status === "paid") {
      await this.d.payments.refund(o.paymentIntentId, o.quote.totalCents, `refund:${o.id}`);
      for (const l of o.quote.lines) this.d.inventory.restock(l.sku, l.quantity);
      this.transition(o, "refunded", reason);
    } else {
      throw new OrderConflict(`Order is ${o.status}`);
    }
    this.d.outbox.add(`order.${o.status}`, { orderId, reason }, this.d.now());
    return o;
  }

  get(orderId: string): Order {
    const o = this.orders.get(orderId);
    if (!o) throw new OrderConflict("Order not found");
    return o;
  }

  private transition(o: Order, status: OrderStatus, note?: string) {
    o.status = status;
    o.history.push({ at: this.d.now(), status, ...(note ? { note } : {}) });
  }
}
