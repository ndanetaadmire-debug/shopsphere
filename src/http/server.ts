import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { OutOfStock } from "../inventory/reservations.js";
import { OrderConflict, type OrderService, PriceChanged } from "../orders/orderService.js";
import { verifyWebhookSignature } from "../payments/gateway.js";
import { PricingError, type Promotion, quote } from "../pricing/engine.js";
import type { Product } from "../catalog/types.js";

const Lines = z.array(z.object({ sku: z.string().min(1), quantity: z.number().int().min(1).max(99) })).min(1).max(50);

export function buildServer(deps: { orders: OrderService; catalog: Map<string, Product>; promotions: Promotion[]; webhookSecret: string }): FastifyInstance {
  const app = Fastify();

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, { raw: body as string, json: JSON.parse((body as string) || "{}") });
    } catch (e) {
      done(Object.assign(e as Error, { statusCode: 400 }), undefined);
    }
  });
  const json = (b: unknown) => (b as { json: unknown }).json;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid_request", issues: err.issues });
    if (err instanceof PricingError) return reply.code(422).send({ error: "pricing", message: err.message });
    if (err instanceof OutOfStock) return reply.code(409).send({ error: "out_of_stock", sku: err.sku, available: err.available });
    if (err instanceof PriceChanged) return reply.code(409).send({ error: "price_changed", expected: err.expected, actual: err.actual });
    if (err instanceof OrderConflict) return reply.code(409).send({ error: "conflict", message: err.message });
    return reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ error: "internal" });
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post("/v1/cart/quote", async (req) => {
    const b = z.object({ lines: Lines, couponCode: z.string().optional() }).parse(json(req.body));
    return quote({ ...b, catalog: deps.catalog, promotions: deps.promotions, shipping: { flatCents: 9_900, freeOverCents: 75_000 } });
  });

  app.post("/v1/orders", async (req, reply) => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8) return reply.code(400).send({ error: "Idempotency-Key header required" });
    const customerId = req.headers["x-customer-id"]; // from verified session in production
    if (typeof customerId !== "string") return reply.code(401).send({ error: "unauthenticated" });
    const b = z.object({ lines: Lines, couponCode: z.string().optional(), expectedTotalCents: z.number().int().nonnegative() }).parse(json(req.body));
    const order = await deps.orders.place({ ...b, customerId, idempotencyKey: key });
    return reply.code(201).send(order);
  });

  app.get("/v1/orders/:id", async (req, reply) => {
    const o = deps.orders.get((req.params as { id: string }).id);
    if (o.customerId !== req.headers["x-customer-id"]) return reply.code(404).send({ error: "not_found" });
    return o;
  });

  app.post("/webhooks/payments", async (req, reply) => {
    const { raw, json: body } = req.body as { raw: string; json: unknown };
    if (!verifyWebhookSignature(raw, req.headers["x-signature"] as string | undefined, deps.webhookSecret)) {
      return reply.code(401).send({ error: "bad signature" });
    }
    const w = z.object({
      eventId: z.string(), intentId: z.string(), orderId: z.string(), status: z.enum(["succeeded", "failed"]), amountCents: z.number().int(),
    }).parse(body);
    deps.orders.handlePaymentWebhook(w);
    return { received: true }; // always 200 for valid signatures so the PSP stops retrying
  });

  return app;
}
