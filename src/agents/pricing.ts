import type { Customer, Item, Settings } from "../db.js";

// Pricing & Margin agent. This one is plain code, not Claude: prices must be exact
// and repeatable, so margins, levels, rounding and tax are calculated, never generated.

/** Who the quote is for: their kind of price list price and the level the quote is priced at. */
export interface Buyer {
  phone: string;
  type: "customer" | "reseller";
  /** 1 = best price. */
  level: number;
  /** True when a new customer's first order is priced at the first-order level. */
  firstOrder?: boolean;
}

export interface QuoteLine {
  itemId: number;
  name: string;
  brand: string;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  lineTotal: number;
  zohoSku: string | null;
  /** How the price was worked out, for the owner (never shown to the customer). */
  how: string;
}

export interface PricedQuote {
  lines: QuoteLine[];
  /** Items we could not price (not available, or no price or cost known). */
  unavailable: Item[];
  subtotal: number;
  tax: number;
  total: number;
}

export const NO_BRAND = "No brand";

// toPrecision first, so 4.025 (stored as 4.02499999...) rounds to 4.03 like a calculator.
const round2 = (value: number) => Math.round(Number((value * 100).toPrecision(12))) / 100;

function findKey<T>(map: Record<string, T>, name: string | null): string | undefined {
  return name ? Object.keys(map).find((key) => key.toLowerCase() === name.toLowerCase()) : undefined;
}

/** The customer's own level, and the level this quote is priced at (better on a new customer's first order). */
export function buyerFor(settings: Settings, customer: Pick<Customer, "phone" | "type" | "level">, hasOrdered: boolean): Buyer {
  const count = Math.max(1, settings.levels.length);
  const own = Math.min(Math.max(1, customer.level ?? settings.newCustomerLevel), count);
  const firstOrder = settings.firstOrderOffer && !hasOrdered && settings.firstOrderLevel < own;
  return { phone: customer.phone, type: customer.type ?? "customer", level: firstOrder ? settings.firstOrderLevel : own, firstOrder };
}

/** The margin for an item and where it came from: the customer's own, the item's, its category's, its brand's, or the default. */
export function marginFor(settings: Settings, buyer: Buyer, item: Pick<Item, "category" | "brand" | "margin_customer" | "margin_reseller">) {
  const { margin } = settings;
  if (buyer.phone in margin.byCustomer) return { percent: margin.byCustomer[buyer.phone], from: "customer margin" };
  const own = buyer.type === "reseller" ? item.margin_reseller : item.margin_customer;
  if (own != null) return { percent: own, from: "item margin" };
  const category = findKey(margin.byCategory, item.category);
  if (category) return { percent: margin.byCategory[category], from: `${category} margin` };
  const brand = findKey(margin.byBrand ?? {}, item.brand);
  if (brand) return { percent: margin.byBrand[brand], from: `${brand} margin` };
  return { percent: margin.defaultPercent, from: "default margin" };
}

/** How much more than Level 1 a level pays for an item: its category's figure if set, otherwise the level's own. */
export function levelUplift(settings: Settings, item: Pick<Item, "category">, level: number): { percent: number; byCategory: boolean } {
  const category = findKey(settings.levelByCategory, item.category);
  const own = category ? settings.levelByCategory[category]?.[String(level)] : undefined;
  if (own != null) return { percent: Number(own), byCategory: true };
  return { percent: Number(settings.levels[level - 1]?.uplift ?? 0), byCategory: false };
}

function roundUp(value: number, step: number): number {
  if (step <= 0) return round2(value);
  // The small epsilon stops 12.000000001 from rounding up to the next step.
  return round2(Math.ceil(value / step - 1e-9) * step);
}

/** The best (Level 1) price: the price list's price for this kind of buyer, or cost plus margin. */
function basePrice(item: Item, settings: Settings, buyer: Buyer): { price: number; how: string } | null {
  if (item.available !== 1) return null;
  const reseller = buyer.type === "reseller";
  const own = reseller ? item.reseller_price : item.list_price;
  const other = reseller ? item.list_price : item.reseller_price;
  const label = reseller ? "reseller price" : "customer price";
  if (item.source === "stock" && settings.margin.priceBasis === "list" && own != null && own > 0) {
    return { price: round2(own), how: `${label} from the list` };
  }
  if (item.cost != null && item.cost > 0) {
    const margin = marginFor(settings, buyer, item);
    return { price: roundUp(item.cost * (1 + margin.percent / 100), settings.margin.roundTo), how: `cost ${item.cost} + ${margin.percent}% ${margin.from}` };
  }
  if (own != null && own > 0) return { price: round2(own), how: `${label} from the list` };
  if (other != null && other > 0) return { price: round2(other), how: `${reseller ? "customer" : "reseller"} price from the list` };
  return null;
}

/** The price for this buyer and how it was worked out: the best price plus the buyer's level. */
export function priceDetail(item: Item, settings: Settings, buyer: Buyer): { price: number; how: string } | null {
  const base = basePrice(item, settings, buyer);
  if (!base) return null;
  const name = settings.levels[buyer.level - 1]?.name ?? `Level ${buyer.level}`;
  const offer = buyer.firstOrder ? " (first-order offer)" : "";
  const uplift = levelUplift(settings, item, buyer.level);
  if (!uplift.percent) return { price: base.price, how: `${base.how}; ${name}${offer}` };
  return {
    price: roundUp(base.price * (1 + uplift.percent / 100), settings.margin.roundTo),
    how: `${base.how}; ${name} +${uplift.percent}%${uplift.byCategory ? ` (${item.category} rate)` : ""}${offer}`,
  };
}

/** Returns the unit selling price for an item, or null when it cannot be priced. */
export function unitPrice(item: Item, settings: Settings, buyer: Buyer): number | null {
  return priceDetail(item, settings, buyer)?.price ?? null;
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

export function priceItems(items: Item[], settings: Settings, buyer: Buyer): PricedQuote {
  const lines: QuoteLine[] = [];
  const unavailable: Item[] = [];
  for (const item of items) {
    const detail = priceDetail(item, settings, buyer);
    if (detail === null) {
      unavailable.push(item);
      continue;
    }
    lines.push({
      itemId: item.id,
      name: item.matched_name ?? item.description,
      brand: item.brand ?? NO_BRAND,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: detail.price,
      lineTotal: round2(detail.price * item.quantity),
      zohoSku: item.source === "stock" ? item.sku : null,
      how: detail.how,
    });
  }
  const subtotal = round2(lines.reduce((sum, line) => sum + line.lineTotal, 0));
  const tax = round2((subtotal * settings.taxPercent) / 100);
  return { lines, unavailable, subtotal, tax, total: round2(subtotal + tax) };
}
