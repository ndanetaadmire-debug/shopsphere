import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/http/server.js";
import { catalog, promotions, setup } from "./fixtures.js";

const SECRET = "whsec";
const sign = (body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;

describe("HTTP", () => {
  it("quote → order → signed webhook → paid", async () => {
    const s = setup();
    const app = buildServer({ orders: s.orders, catalog, promotions, webhookSecret: SECRET });
    const quote = (await app.inject({ method: "POST", url: "/v1/cart/quote", payload: { lines: [{ sku: "HOOD", quantity: 1 }] } })).json();

    const noKey = await app.inject({ method: "POST", url: "/v1/orders", headers: { "x-customer-id": "c1" }, payload: { lines: [{ sku: "HOOD", quantity: 1 }], expectedTotalCents: quote.totalCents } });
    expect(noKey.statusCode).toBe(400);

    const res = await app.inject({
      method: "POST", url: "/v1/orders", headers: { "x-customer-id": "c1", "idempotency-key": "checkout-123" },
      payload: { lines: [{ sku: "HOOD", quantity: 1 }], expectedTotalCents: quote.totalCents },
    });
    expect(res.statusCode).toBe(201);
    const order = res.json();

    expect((await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers: { "x-customer-id": "intruder" } })).statusCode).toBe(404);

    const body = JSON.stringify({ eventId: "evt_1", intentId: order.paymentIntentId, orderId: order.id, status: "succeeded", amountCents: quote.totalCents });
    expect((await app.inject({ method: "POST", url: "/webhooks/payments", headers: { "content-type": "application/json", "x-signature": "t=1,v1=00" }, payload: body })).statusCode).toBe(401);
    const stale = sign(body, Math.floor(Date.now() / 1000) - 3600);
    expect((await app.inject({ method: "POST", url: "/webhooks/payments", headers: { "content-type": "application/json", "x-signature": stale }, payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/webhooks/payments", headers: { "content-type": "application/json", "x-signature": sign(body) }, payload: body })).statusCode).toBe(200);

    expect((await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers: { "x-customer-id": "c1" } })).json().status).toBe("paid");
  });

  it("maps domain errors to precise status codes", async () => {
    const s = setup(0);
    const app = buildServer({ orders: s.orders, catalog, promotions, webhookSecret: SECRET });
    const h = { "x-customer-id": "c1", "idempotency-key": "checkout-999" };
    expect((await app.inject({ method: "POST", url: "/v1/orders", headers: h, payload: { lines: [{ sku: "MUG", quantity: 1 }], expectedTotalCents: 1 } })).json().error).toBe("price_changed");
    const r = await app.inject({ method: "POST", url: "/v1/orders", headers: h, payload: { lines: [{ sku: "MUG", quantity: 1 }], expectedTotalCents: 18_900 + 9_900 } });
    expect(r.json()).toMatchObject({ error: "out_of_stock", sku: "MUG", available: 0 });
    expect((await app.inject({ method: "POST", url: "/v1/cart/quote", payload: { lines: [{ sku: "X", quantity: 1 }] } })).statusCode).toBe(422);
  });
});
