import type { Item, Settings } from "../db.js";

// Pricing & Margin agent. This one is plain code, not Claude: prices must be exact
// and repeatable, so margins, rounding and tax are calculated, never generated.

export interface QuoteLine {
  itemId: number;
  name: string;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  lineTotal: number;
  zohoSku: string | null;
}

export interface PricedQuote {
  lines: QuoteLine[];
  /** Items we could not price (not available, or no price or cost known). */
  unavailable: Item[];
  subtotal: number;
  tax: number;
  total: number;
}

// toPrecision first, so 4.025 (stored as 4.02499999...) rounds to 4.03 like a calculator.
const round2 = (value: number) => Math.round(Number((value * 100).toPrecision(12))) / 100;

export function marginPercent(settings: Settings, customerPhone: string, category: string | null): number {
  const { margin } = settings;
  if (customerPhone in margin.byCustomer) return margin.byCustomer[customerPhone];
  if (category) {
    const key = Object.keys(margin.byCategory).find((name) => name.toLowerCase() === category.toLowerCase());
    if (key) return margin.byCategory[key];
  }
  return margin.defaultPercent;
}

function roundUp(value: number, step: number): number {
  if (step <= 0) return round2(value);
  // The small epsilon stops 12.000000001 from rounding up to the next step.
  return round2(Math.ceil(value / step - 1e-9) * step);
}

/** Returns the unit selling price for an item, or null when it cannot be priced. */
export function unitPrice(item: Item, settings: Settings, customerPhone: string): number | null {
  if (item.available !== 1) return null;
  if (item.source === "stock" && settings.margin.priceBasis === "list" && item.list_price != null && item.list_price > 0) {
    return round2(item.list_price);
  }
  if (item.cost != null && item.cost > 0) {
    const percent = marginPercent(settings, customerPhone, item.category);
    return roundUp(item.cost * (1 + percent / 100), settings.margin.roundTo);
  }
  if (item.list_price != null && item.list_price > 0) return round2(item.list_price);
  return null;
}

/**
 * Prices that look wrong and must be checked by the owner before the quote goes out, even when approval is off.
 * A supplier's price is read by AI from their message, so a typo or a misleading message must never reach a customer unseen.
 */
export function priceWarnings(items: Item[], priced: PricedQuote): string[] {
  const warnings: string[] = [];
  for (const item of items) {
    if (item.source !== "supplier" || item.cost == null || !(item.list_price && item.list_price > 0)) continue;
    if (item.cost < item.list_price * 0.3 || item.cost > item.list_price * 3) {
      warnings.push(`${item.matched_name ?? item.description}: supplier cost ${item.cost} is far from the price list's ${item.list_price}`);
    }
  }
  for (const line of priced.lines) {
    if (!(line.unitPrice > 0)) warnings.push(`${line.name}: unit price is ${line.unitPrice}`);
    if (line.quantity > 10_000) warnings.push(`${line.name}: quantity ${line.quantity} is unusually large`);
  }
  return warnings;
}

export function priceItems(items: Item[], settings: Settings, customerPhone: string): PricedQuote {
  const lines: QuoteLine[] = [];
  const unavailable: Item[] = [];
  for (const item of items) {
    const price = unitPrice(item, settings, customerPhone);
    if (price === null) {
      unavailable.push(item);
      continue;
    }
    lines.push({
      itemId: item.id,
      name: item.matched_name ?? item.description,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: price,
      lineTotal: round2(price * item.quantity),
      zohoSku: item.source === "stock" ? item.sku : null,
    });
  }
  const subtotal = round2(lines.reduce((sum, line) => sum + line.lineTotal, 0));
  const tax = round2((subtotal * settings.taxPercent) / 100);
  return { lines, unavailable, subtotal, tax, total: round2(subtotal + tax) };
}
