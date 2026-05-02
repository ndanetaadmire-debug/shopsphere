import { describe, expect, it } from "vitest";
import { apportion, PricingError, quote } from "../src/pricing/engine.js";
import { catalog, promotions } from "./fixtures.js";

const ship = { flatCents: 9_900, freeOverCents: 75_000 };
const q = (lines: Array<[string, number]>, couponCode?: string) =>
  quote({ lines: lines.map(([sku, quantity]) => ({ sku, quantity })), catalog, promotions, couponCode, shipping: ship });

describe("pricing engine", () => {
  it("applies the best line promotion and charges shipping under the threshold", () => {
    const r = q([["TEE", 1]]);
    expect(r.lines[0]).toMatchObject({ discountCents: 6_980, netCents: 27_920, appliedPromotions: ["APPAREL20"] });
    expect(r.shippingCents).toBe(9_900);
    expect(r.totalCents).toBe(27_920 + 9_900);
  });

  it("buy 2 get 1 free, merging duplicate lines", () => {
    const r = q([["MUG", 2], ["MUG", 1]]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ quantity: 3, discountCents: 18_900 });
  });

  it("apportions a cart coupon so line totals sum exactly to the order", () => {
    const r = q([["TEE", 1], ["HOOD", 1], ["MUG", 1]], "welcome");
    expect(r.appliedPromotions).toContain("WELCOME100");
    expect(r.lines.reduce((s, l) => s + l.netCents, 0) + r.shippingCents).toBe(r.totalCents);
    expect(r.lines.reduce((s, l) => s + l.discountCents, 0)).toBe(r.discountCents);
    expect(r.shippingCents).toBe(0); // over the free-shipping threshold
  });

  it("extracts 15% VAT from inclusive prices and respects exemptions", () => {
    const r = q([["MUG", 1], ["BOOK", 1]]);
    const mug = r.lines.find((l) => l.sku === "MUG")!;
    expect(mug.vatCents).toBe(Math.round((18_900 * 15) / 115));
    expect(r.lines.find((l) => l.sku === "BOOK")!.vatCents).toBe(0);
  });

  it("rejects unknown SKUs, bad quantities and bad coupons", () => {
    expect(() => q([["NOPE", 1]])).toThrow(PricingError);
    expect(() => q([["TEE", 0]])).toThrow(PricingError);
    expect(() => q([["TEE", 1]], "FAKE")).toThrow(/Coupon/);
  });

  it("apportion never loses or invents a cent", () => {
    for (const [total, weights] of [[100, [1, 1, 1]], [10_000, [27_920, 63_920, 18_900]], [1, [5, 5]], [0, [3, 4]]] as const) {
      const parts = apportion(total, [...weights]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});
