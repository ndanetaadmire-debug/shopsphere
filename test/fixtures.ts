import type { Product } from "../src/catalog/types.js";
import { Inventory } from "../src/inventory/reservations.js";
import { OrderService } from "../src/orders/orderService.js";
import { Outbox } from "../src/outbox/outbox.js";
import { FakeGateway } from "../src/payments/gateway.js";
import type { Promotion } from "../src/pricing/engine.js";

export const catalog = new Map<string, Product>([
  ["TEE", { sku: "TEE", title: "Tee", priceCents: 34_900, category: "apparel" }],
  ["HOOD", { sku: "HOOD", title: "Hoodie", priceCents: 79_900, category: "apparel" }],
  ["MUG", { sku: "MUG", title: "Mug", priceCents: 18_900, category: "home" }],
  ["BOOK", { sku: "BOOK", title: "Book", priceCents: 25_000, category: "books", vatExempt: true }],
]);

export const promotions: Promotion[] = [
  { id: "APPAREL20", kind: "percent_off_category", category: "apparel", percent: 20 },
  { id: "MUG3FOR2", kind: "buy_x_get_y", sku: "MUG", buy: 2, free: 1 },
  { id: "WELCOME100", kind: "cart_fixed_off", minSubtotalCents: 50_000, offCents: 10_000, code: "WELCOME" },
];

export function setup(stock = 5) {
  let now = 1_800_000_000_000;
  const inventory = new Inventory(() => now);
  for (const sku of catalog.keys()) inventory.restock(sku, stock);
  const payments = new FakeGateway();
  const outbox = new Outbox();
  const orders = new OrderService({ catalog, promotions, inventory, payments, outbox, now: () => now });
  return { inventory, payments, outbox, orders, advance: (ms: number) => (now += ms), now: () => now };
}
