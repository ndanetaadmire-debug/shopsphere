import { describe, expect, it } from "vitest";
import { OutOfStock } from "../src/inventory/reservations.js";
import { PriceChanged } from "../src/orders/orderService.js";
import { setup } from "./fixtures.js";

const TEE_TOTAL = 27_920 + 9_900;
const place = (o: ReturnType<typeof setup>["orders"], key = "key-00001", qty = 1, customer = "c1") =>
  o.place({ customerId: customer, lines: [{ sku: "TEE", quantity: qty }], expectedTotalCents: qty === 1 ? TEE_TOTAL : -1, idempotencyKey: key });

describe("checkout saga", () => {
  it("reserve → pay → commit, with outbox events", async () => {
    const s = setup();
    const order = await place(s.orders);
    expect(order.status).toBe("awaiting_payment");
    expect(s.inventory.available("TEE")).toBe(4);
    s.orders.handlePaymentWebhook({ eventId: "e1", intentId: order.paymentIntentId, orderId: order.id, status: "succeeded", amountCents: TEE_TOTAL });
    expect(order.status).toBe("paid");
    expect(s.inventory.available("TEE")).toBe(4);
    expect(s.outbox.all().map((m) => m.topic)).toEqual(["order.placed", "order.paid"]);
  });

  it("is idempotent on retries and webhook redelivery", async () => {
    const s = setup();
    const a = await place(s.orders);
    const b = await place(s.orders);
    expect(a.id).toBe(b.id);
    expect(s.inventory.available("TEE")).toBe(4);
    const hook = { eventId: "e1", intentId: a.paymentIntentId, orderId: a.id, status: "succeeded" as const, amountCents: TEE_TOTAL };
    s.orders.handlePaymentWebhook(hook);
    s.orders.handlePaymentWebhook(hook);
    expect(s.outbox.all().filter((m) => m.topic === "order.paid")).toHaveLength(1);
  });

  it("never oversells: the last unit goes to exactly one buyer", async () => {
    const s = setup(1);
    const results = await Promise.allSettled([place(s.orders, "key-aaaaa", 1, "a"), place(s.orders, "key-bbbbb", 1, "b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(OutOfStock);
  });

  it("refuses to charge a price the customer didn't see", async () => {
    const s = setup();
    await expect(s.orders.place({ customerId: "c", lines: [{ sku: "TEE", quantity: 1 }], expectedTotalCents: 34_900, idempotencyKey: "key-x0000" }))
      .rejects.toBeInstanceOf(PriceChanged);
    expect(s.inventory.available("TEE")).toBe(5); // nothing reserved
  });

  it("releases stock on payment failure and on abandoned checkout", async () => {
    const s = setup();
    const failed = await place(s.orders, "key-fail0");
    s.orders.handlePaymentWebhook({ eventId: "f", intentId: failed.paymentIntentId, orderId: failed.id, status: "failed", amountCents: TEE_TOTAL });
    expect(failed.status).toBe("payment_failed");
    const abandoned = await place(s.orders, "key-aband");
    s.advance(11 * 60_000);
    expect(s.orders.expireStale()).toEqual([abandoned.id]);
    expect(s.inventory.available("TEE")).toBe(5);
  });

  it("late payment after expiry: re-reserves if possible, otherwise auto-refunds", async () => {
    const s = setup(1);
    const o = await place(s.orders, "key-late0", 1, "a");
    s.advance(11 * 60_000);
    s.orders.expireStale();
    const rival = await place(s.orders, "key-rival", 1, "b"); // stock now held by someone else
    s.orders.handlePaymentWebhook({ eventId: "late", intentId: o.paymentIntentId, orderId: o.id, status: "succeeded", amountCents: TEE_TOTAL });
    expect(o.status).toBe("refunded");
    expect(s.payments.refunds).toEqual([{ intentId: o.paymentIntentId, amountCents: TEE_TOTAL }]);
    expect(rival.status).toBe("awaiting_payment");
  });

  it("flags amount mismatches instead of fulfilling", async () => {
    const s = setup();
    const o = await place(s.orders);
    s.orders.handlePaymentWebhook({ eventId: "m", intentId: o.paymentIntentId, orderId: o.id, status: "succeeded", amountCents: 100 });
    expect(o.status).toBe("awaiting_payment");
    expect(s.outbox.all().some((m) => m.topic === "order.payment_mismatch")).toBe(true);
  });

  it("cancelling a paid order refunds and restocks (compensation)", async () => {
    const s = setup();
    const o = await place(s.orders);
    s.orders.handlePaymentWebhook({ eventId: "e", intentId: o.paymentIntentId, orderId: o.id, status: "succeeded", amountCents: TEE_TOTAL });
    await s.orders.cancel(o.id, "customer changed mind");
    expect(o.status).toBe("refunded");
    expect(s.inventory.available("TEE")).toBe(5);
  });

  it("releases the hold if the payment provider is down", async () => {
    const s = setup();
    s.payments.createIntent = async () => { throw new Error("PSP 503"); };
    await expect(place(s.orders)).rejects.toThrow("PSP 503");
    expect(s.inventory.available("TEE")).toBe(5);
  });
});

describe("outbox relay", () => {
  it("publishes in order and stops at the first failure for retry", async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.outbox.add("t", { i }, 0);
    let calls = 0;
    const r1 = await s.outbox.relay(async () => { if (++calls === 2) throw new Error("broker down"); }, () => 1);
    expect(r1).toEqual({ published: 1, failed: 1 });
    const r2 = await s.outbox.relay(async () => {}, () => 2);
    expect(r2).toEqual({ published: 2, failed: 0 });
  });
});
