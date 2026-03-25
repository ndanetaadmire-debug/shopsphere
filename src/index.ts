import { Inventory } from "./inventory/reservations.js";
import { OrderService } from "./orders/orderService.js";
import { Outbox } from "./outbox/outbox.js";
import { FakeGateway } from "./payments/gateway.js";
import { buildServer } from "./http/server.js";
import type { Product } from "./catalog/types.js";

const catalog = new Map<string, Product>([
  ["TEE-BLK-M", { sku: "TEE-BLK-M", title: "Organic tee, black, M", priceCents: 34_900, category: "apparel" }],
  ["MUG-01", { sku: "MUG-01", title: "Stoneware mug", priceCents: 18_900, category: "home" }],
]);
const inventory = new Inventory();
for (const sku of catalog.keys()) inventory.restock(sku, 25);

const outbox = new Outbox();
const orders = new OrderService({ catalog, promotions: [], inventory, payments: new FakeGateway(), outbox, now: Date.now });
const app = buildServer({ orders, catalog, promotions: [], webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET ?? "dev-secret" });

setInterval(() => {
  orders.expireStale();
  void outbox.relay(async (m) => app.log.info({ topic: m.topic, id: m.id }, "event"), Date.now);
}, 60_000).unref();

await app.listen({ port: Number(process.env.PORT ?? 8080), host: "0.0.0.0" });
