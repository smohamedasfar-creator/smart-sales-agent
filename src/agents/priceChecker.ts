import { z } from "zod";
import { searchCatalog, type CatalogItem } from "../catalog/catalog.js";
import type { Item } from "../db.js";
import type { AgentContext } from "./context.js";

// Price & Stock agent: matches each requested item to a line in the price list
// (Excel or Zoho) and checks whether there is enough stock.
// The search narrows the price list to a few candidates; Claude picks the right one.

const MatchResult = z.object({
  matches: z.array(
    z.object({
      item_id: z.number(),
      sku: z.string().nullable().describe("SKU of the matching candidate, or null if none of them is the same product"),
    }),
  ),
});

const SYSTEM = `You are the Price & Stock checker for a trading company.
For each requested item you get a few candidate products from our price list.
Pick the candidate that is the same product: same type and the same size, grade or specification.
If the customer's size or specification differs from every candidate, answer null; a wrong match leads to a wrong quote.
If the customer gave no brand, any brand of the right product matches.`;

export interface PriceCheckResult {
  /** Items we cannot supply from stock: not in the price list, or not enough stock. */
  needSupplier: Item[];
}

export async function checkPrices(ctx: AgentContext, enquiryId: number): Promise<PriceCheckResult> {
  const items = ctx.db.items(enquiryId);
  const catalog = await ctx.catalog.items();
  const candidates = new Map<number, CatalogItem[]>();
  for (const item of items) candidates.set(item.id, searchCatalog(catalog, item.description));

  const withCandidates = items.filter((item) => candidates.get(item.id)!.length > 0);
  const chosen = new Map<number, string | null>();
  if (withCandidates.length > 0) {
    const listing = withCandidates
      .map((item) => {
        const options = candidates
          .get(item.id)!
          .map((c) => `    - sku: ${c.sku} | ${c.name}${c.unit ? ` | unit: ${c.unit}` : ""}${c.category ? ` | ${c.category}` : ""}`)
          .join("\n");
        return `Item ${item.id}: ${item.quantity} ${item.unit ?? ""} ${item.description}\n  Candidates:\n${options}`;
      })
      .join("\n\n");
    const result = await ctx.llm.json({
      agent: "price-checker",
      system: SYSTEM,
      prompt: `<requested_items>\n${listing}\n</requested_items>\n\nReturn one match per item.`,
      schema: MatchResult,
      effort: "medium",
    });
    for (const match of result.matches) chosen.set(match.item_id, match.sku);
  }

  const needSupplier: Item[] = [];
  for (const item of items) {
    const sku = chosen.get(item.id) ?? null;
    const product = sku ? candidates.get(item.id)!.find((c) => c.sku === sku) : undefined;
    if (!product) {
      ctx.db.updateItem(item.id, { sku: null, matched_name: null, source: null, available: 0 });
      needSupplier.push({ ...item, available: 0 });
      continue;
    }
    // A price list without a stock column is treated as "always available".
    const inStock = product.stock === null || product.stock >= item.quantity;
    const fields = {
      sku: product.sku,
      matched_name: product.name,
      category: product.category,
      unit: item.unit ?? product.unit,
      list_price: product.price,
      cost: product.cost,
      available: inStock ? 1 : 0,
      source: inStock ? ("stock" as const) : null,
    };
    ctx.db.updateItem(item.id, fields);
    if (!inStock) needSupplier.push({ ...item, ...fields });
  }
  return { needSupplier };
}
