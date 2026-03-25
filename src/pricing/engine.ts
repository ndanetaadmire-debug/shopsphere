import type { CartLine, Product } from "../catalog/types.js";

export const VAT_RATE = 0.15;

export type Promotion =
  | { id: string; kind: "percent_off_category"; category: string; percent: number }
  | { id: string; kind: "buy_x_get_y"; sku: string; buy: number; free: number }
  | { id: string; kind: "cart_fixed_off"; minSubtotalCents: number; offCents: number; code: string };

export interface PricedLine {
  sku: string;
  title: string;
  quantity: number;
  unitCents: number;
  grossCents: number;
  discountCents: number;
  netCents: number;
  vatCents: number;
  appliedPromotions: string[];
}

export interface Quote {
  lines: PricedLine[];
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  totalCents: number;
  vatCents: number;
  appliedPromotions: string[];
}

export interface PricingInput {
  lines: CartLine[];
  catalog: Map<string, Product>;
  promotions: Promotion[];
  couponCode?: string;
  shipping: { flatCents: number; freeOverCents: number };
}

export class PricingError extends Error {}

/**
 * Deterministic pricing. Pure function: same inputs → same quote, so the price the
 * customer saw at checkout can be recomputed and verified when the order is placed.
 *
 * Rules:
 *  - Line promotions first (best single promotion per line, never stacked), then cart-level coupons.
 *  - Cart discounts are apportioned across lines by value using largest-remainder, so line totals
 *    always sum exactly to the order total (no lost or invented cents on invoices or refunds).
 *  - VAT is extracted from inclusive prices per line: vat = net × 15/115.
 */
export function quote(input: PricingInput): Quote {
  const merged = mergeLines(input.lines);
  const lines: PricedLine[] = merged.map(({ sku, quantity }) => {
    const p = input.catalog.get(sku);
    if (!p) throw new PricingError(`Unknown SKU ${sku}`);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new PricingError(`Invalid quantity for ${sku}`);
    const gross = p.priceCents * quantity;
    const best = bestLinePromotion(p, quantity, input.promotions);
    return {
      sku, title: p.title, quantity, unitCents: p.priceCents, grossCents: gross,
      discountCents: best?.off ?? 0, netCents: gross - (best?.off ?? 0), vatCents: 0,
      appliedPromotions: best ? [best.id] : [],
    };
  });

  const applied = new Set(lines.flatMap((l) => l.appliedPromotions));
  const afterLine = sum(lines.map((l) => l.netCents));

  const coupon = input.couponCode
    ? input.promotions.find((p): p is Extract<Promotion, { kind: "cart_fixed_off" }> => p.kind === "cart_fixed_off" && p.code.toLowerCase() === input.couponCode!.toLowerCase())
    : undefined;
  if (input.couponCode && !coupon) throw new PricingError("Coupon not recognised");
  if (coupon && afterLine >= coupon.minSubtotalCents) {
    const off = Math.min(coupon.offCents, afterLine);
    const shares = apportion(off, lines.map((l) => l.netCents));
    lines.forEach((l, i) => {
      l.discountCents += shares[i]!;
      l.netCents -= shares[i]!;
      if (shares[i]! > 0) l.appliedPromotions.push(coupon.id);
    });
    applied.add(coupon.id);
  }

  for (const l of lines) {
    const exempt = input.catalog.get(l.sku)?.vatExempt;
    l.vatCents = exempt ? 0 : Math.round((l.netCents * VAT_RATE) / (1 + VAT_RATE));
  }

  const subtotal = sum(lines.map((l) => l.grossCents));
  const discount = sum(lines.map((l) => l.discountCents));
  const net = subtotal - discount;
  const shipping = lines.length === 0 || net >= input.shipping.freeOverCents ? 0 : input.shipping.flatCents;
  const shippingVat = Math.round((shipping * VAT_RATE) / (1 + VAT_RATE));
  return {
    lines, subtotalCents: subtotal, discountCents: discount, shippingCents: shipping,
    totalCents: net + shipping, vatCents: sum(lines.map((l) => l.vatCents)) + shippingVat,
    appliedPromotions: [...applied],
  };
}

function bestLinePromotion(p: Product, qty: number, promos: Promotion[]): { id: string; off: number } | undefined {
  let best: { id: string; off: number } | undefined;
  for (const promo of promos) {
    let off = 0;
    if (promo.kind === "percent_off_category" && promo.category === p.category) {
      off = Math.round((p.priceCents * qty * promo.percent) / 100);
    } else if (promo.kind === "buy_x_get_y" && promo.sku === p.sku) {
      const group = promo.buy + promo.free;
      off = Math.floor(qty / group) * promo.free * p.priceCents;
    }
    if (off > 0 && (!best || off > best.off)) best = { id: promo.id, off };
  }
  return best;
}

/** Split `total` across `weights` proportionally; integer result that sums exactly to `total`. */
export function apportion(total: number, weights: number[]): number[] {
  const W = sum(weights);
  if (W === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / W);
  const floors = raw.map(Math.floor);
  let remainder = total - sum(floors);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder-- <= 0) break;
    floors[i]!++;
  }
  return floors;
}

function mergeLines(lines: CartLine[]): CartLine[] {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.sku, (m.get(l.sku) ?? 0) + l.quantity);
  return [...m].map(([sku, quantity]) => ({ sku, quantity }));
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
