import { randomUUID } from "node:crypto";

export class OutOfStock extends Error {
  constructor(readonly sku: string, readonly requested: number, readonly available: number) {
    super(`Only ${available} of ${sku} available`);
  }
}

export interface Reservation {
  id: string;
  orderId: string;
  items: Array<{ sku: string; quantity: number }>;
  expiresAt: number;
  state: "held" | "committed" | "released";
}

/**
 * Inventory with short-lived reservations.
 *
 * Checkout holds stock for a few minutes while the customer pays. Holds are
 * all-or-nothing across lines, expire on their own (abandoned carts give stock
 * back), and only become permanent on payment. `available = onHand − held`.
 *
 * In Postgres the same logic is a single statement per SKU:
 *   UPDATE stock SET held = held + $q WHERE sku = $s AND on_hand - held >= $q
 * whose row count tells you whether you got it — no read-then-write race.
 */
export class Inventory {
  private readonly onHand = new Map<string, number>();
  private readonly held = new Map<string, number>();
  private readonly reservations = new Map<string, Reservation>();

  constructor(private readonly now: () => number = Date.now, private readonly holdMs = 10 * 60_000) {}

  restock(sku: string, quantity: number): void {
    this.onHand.set(sku, (this.onHand.get(sku) ?? 0) + quantity);
  }

  available(sku: string): number {
    this.expireStale();
    return (this.onHand.get(sku) ?? 0) - (this.held.get(sku) ?? 0);
  }

  reserve(orderId: string, items: Array<{ sku: string; quantity: number }>): Reservation {
    this.expireStale();
    const existing = [...this.reservations.values()].find((r) => r.orderId === orderId && r.state === "held");
    if (existing) return existing; // idempotent per order

    for (const { sku, quantity } of items) {
      const avail = (this.onHand.get(sku) ?? 0) - (this.held.get(sku) ?? 0);
      if (avail < quantity) throw new OutOfStock(sku, quantity, Math.max(0, avail));
    }
    // Check-all-then-apply is atomic here because JS is single-threaded between awaits.
    for (const { sku, quantity } of items) this.held.set(sku, (this.held.get(sku) ?? 0) + quantity);
    const r: Reservation = { id: `res_${randomUUID()}`, orderId, items, expiresAt: this.now() + this.holdMs, state: "held" };
    this.reservations.set(r.id, r);
    return r;
  }

  commit(reservationId: string): void {
    const r = this.mustGet(reservationId);
    if (r.state === "committed") return;
    if (r.state === "released") throw new Error("Reservation expired or released");
    for (const { sku, quantity } of r.items) {
      this.held.set(sku, this.held.get(sku)! - quantity);
      this.onHand.set(sku, this.onHand.get(sku)! - quantity);
    }
    r.state = "committed";
  }

  release(reservationId: string): void {
    const r = this.mustGet(reservationId);
    if (r.state !== "held") return;
    for (const { sku, quantity } of r.items) this.held.set(sku, this.held.get(sku)! - quantity);
    r.state = "released";
  }

  get(reservationId: string): Reservation | undefined {
    this.expireStale();
    return this.reservations.get(reservationId);
  }

  private expireStale(): void {
    const t = this.now();
    for (const r of this.reservations.values()) if (r.state === "held" && r.expiresAt <= t) this.release(r.id);
  }

  private mustGet(id: string): Reservation {
    const r = this.reservations.get(id);
    if (!r) throw new Error(`Unknown reservation ${id}`);
    return r;
  }
}
