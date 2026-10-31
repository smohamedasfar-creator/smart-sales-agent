// A catalog is the price list: what you sell, at what price, and how much is in stock.
// Excel and Zoho both load their items into memory; the search below finds likely
// matches and the Price & Stock agent picks the right one.

export interface CatalogItem {
  sku: string;
  name: string;
  category: string | null;
  /** Brand, from a Brand column or the sheet's name; null when unknown. */
  brand?: string | null;
  unit: string | null;
  /** Selling price to end customers, if the price list has one. */
  price: number | null;
  /** Selling price to resellers, if the price list has one. */
  resellerPrice?: number | null;
  /** The item's own margins in percent, if the price list has them. */
  marginCustomer?: number | null;
  marginReseller?: number | null;
  /** Remarks such as a minimum order quantity. */
  remark?: string | null;
  /** Purchase cost, if the price list has one. */
  cost: number | null;
  /** Quantity in stock; null when the price list does not track stock. */
  stock: number | null;
  /** Zoho's own item id, used when creating Zoho estimates. */
  zohoItemId?: string;
}

export interface Catalog {
  items(): Promise<CatalogItem[]>;
}

// Sizes become one token ("4 inch", '4"' and "4in" all become "4inch"), so a 4" pipe
// that is 6 m long does not look like a 6" pipe.
const UNIT_WORDS: [RegExp, string][] = [
  [/(\d)\s*(?:"|''|”|inches|inch|in)(?![a-z])/g, "$1inch "],
  [/(\d)\s*(?:millimetres|millimeters|mm)(?![a-z])/g, "$1mm "],
  [/(\d)\s*(?:metres|meters|mtrs|mtr|m)(?![a-z])/g, "$1m "],
  [/(\d)\s*(?:kgs|kg)(?![a-z])/g, "$1kg "],
];

export function normalize(text: string): string[] {
  let value = text.toLowerCase();
  for (const [pattern, replacement] of UNIT_WORDS) value = value.replace(pattern, replacement);
  return value
    .replace(/[^a-z0-9./]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 0);
}

function score(queryTokens: string[], item: CatalogItem): number {
  const haystack = normalize(`${item.name} ${item.sku} ${item.brand ?? ""} ${item.category ?? ""}`);
  let total = 0;
  for (const token of queryTokens) {
    const numeric = /\d/.test(token);
    if (haystack.includes(token)) total += numeric ? 3 : 2;
    // A bare "4" still matches "4inch", but less strongly than an exact size.
    else if (/^\d+(\.\d+)?$/.test(token) && haystack.some((word) => new RegExp(`^${token.replace(".", "\\.")}[a-z]+$`).test(word))) total += 2;
    else if (!numeric && token.length >= 3 && haystack.some((word) => word.startsWith(token) || token.startsWith(word))) total += 1;
  }
  return total;
}

/** The brand the customer named in a description, if the price list has it. */
export function brandIn(items: CatalogItem[], description: string): string | null {
  const words = ` ${normalize(description).join(" ")} `;
  const brands = [...new Set(items.map((i) => i.brand).filter((b): b is string => Boolean(b)))];
  return brands.find((brand) => words.includes(` ${normalize(brand).join(" ")} `)) ?? null;
}

/**
 * Products that fit a request about equally well: the same kind of product (the customer's words, not sizes, match
 * as well as the best match's do) and nearly the best score. More than one means we should ask which one.
 */
export function closeMatches(items: CatalogItem[], description: string, limit = 12): CatalogItem[] {
  const brand = brandIn(items, description);
  const list = searchCatalog(items, description, limit).filter((c) => !brand || c.brand === brand);
  if (list.length < 2) return list;
  const query = normalize(description);
  const words = query.filter((t) => !/\d/.test(t));
  const bestWords = Math.max(...list.map((c) => score(words, c)));
  const kind = list.filter((c) => score(words, c) >= Math.max(1, bestWords - 1));
  const best = Math.max(...kind.map((c) => score(query, c)));
  return kind.filter((c) => score(query, c) >= best - 1);
}

/** Returns the catalog items that look most like the description, best first. */
export function searchCatalog(items: CatalogItem[], description: string, limit = 8): CatalogItem[] {
  const tokens = normalize(description);
  return items
    .map((item) => ({ item, score: score(tokens, item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}
