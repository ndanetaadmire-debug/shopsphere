/** Prices are integer cents, VAT-inclusive, as South African consumer law requires for display. */
export interface Product {
  sku: string;
  title: string;
  priceCents: number;
  category: string;
  vatExempt?: boolean;
}

export interface CartLine {
  sku: string;
  quantity: number;
}
