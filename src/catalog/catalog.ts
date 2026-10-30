// A catalog is the price list: what you sell, at what price, and how much is in stock.
// Excel and Zoho both load their items into memory; the search below finds likely
// matches and the Price & Stock agent picks the right one.

export interface CatalogItem {
  sku: string;
  name: string;
  category: string | null;
  unit: string | null;
  /** Selling price from the price list, if it has one. */
  price: number | null;
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
  const haystack = normalize(`${item.name} ${item.sku} ${item.category ?? ""}`);
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
