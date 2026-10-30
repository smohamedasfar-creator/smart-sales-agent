import { z } from "zod";
import type { Enquiry, Item, Supplier, SupplierRequest } from "../db.js";
import { UNTRUSTED_NOTE, within24h, type AgentContext } from "./context.js";

// Supplier Enquiry agent: asks suppliers for prices on items we cannot supply from
// stock, and reads their replies (WhatsApp or email) into costs.

function itemLine(item: Item): string {
  return `${item.quantity} ${item.unit ?? "pcs"} ${item.description}`;
}

const list = (text: string) =>
  (text ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);

/**
 * Suppliers to ask about an item: those who sell its brand; otherwise suppliers with no brands of their own
 * (matching its category when they list categories). A supplier set up for other brands is never asked.
 */
export function suppliersFor(all: Supplier[], item: Pick<Item, "brand" | "category">): Supplier[] {
  if (item.brand) {
    const byBrand = all.filter((supplier) => list(supplier.brands).includes(item.brand!.toLowerCase()));
    if (byBrand.length > 0) return byBrand;
  }
  const anyBrand = all.filter((supplier) => list(supplier.brands).length === 0);
  const category = item.category?.toLowerCase();
  const matching = anyBrand.filter((supplier) => {
    const categories = list(supplier.categories);
    return categories.length === 0 || (category !== undefined && categories.includes(category));
  });
  return matching.length > 0 ? matching : anyBrand;
}

async function sendToSupplier(ctx: AgentContext, supplier: Supplier, subject: string, body: string, items: Item[]) {
  const settings = ctx.db.getSettings();
  const now = ctx.db.now();
  const { whatsapp } = ctx.config;
  if (supplier.phone && (within24h(supplier.last_inbound_at, now) || !whatsapp.supplierTemplate)) {
    await ctx.whatsapp.sendText(supplier.phone, body);
    return "whatsapp" as const;
  }
  if (supplier.email && ctx.mailer) {
    await ctx.mailer.send(supplier.email, subject, body);
    return "email" as const;
  }
  if (supplier.phone) {
    // Outside the 24-hour window only an approved template can start the chat.
    const oneLine = items.map(itemLine).join("; ").slice(0, 900);
    await ctx.whatsapp.sendTemplate(supplier.phone, whatsapp.supplierTemplate, whatsapp.supplierTemplateLanguage, [
      oneLine,
      settings.businessName,
    ]);
    return "whatsapp" as const;
  }
  throw new Error(`Supplier ${supplier.name} has no phone or email`);
}

/** A brand's agent sends its price requests. Returns the names of the suppliers asked. */
export async function askSuppliers(ctx: AgentContext, enquiry: Enquiry, items: Item[], brand: string | null = null): Promise<string[]> {
  const settings = ctx.db.getSettings();
  const all = ctx.db.suppliers();
  const bySupplier = new Map<number, { supplier: Supplier; items: Item[] }>();
  for (const item of items) {
    for (const supplier of suppliersFor(all, item)) {
      const entry = bySupplier.get(supplier.id) ?? { supplier, items: [] };
      entry.items.push(item);
      bySupplier.set(supplier.id, entry);
    }
  }

  const asked: string[] = [];
  const ref = brand ? `E${enquiry.id}-${brand}` : `E${enquiry.id}`;
  for (const { supplier, items: supplierItems } of bySupplier.values()) {
    const lines = supplierItems.map((item, index) => `${index + 1}. ${itemLine(item)}`).join("\n");
    const body =
      `Hello ${supplier.name}, this is ${settings.businessName}.\n` +
      `Please share your best price (per unit) and availability${brand ? ` for ${brand}` : ""}:\n${lines}\n\n` +
      `Our ref: ${ref}. Thank you.`;
    try {
      const channel = await sendToSupplier(ctx, supplier, `Price enquiry ${ref} - ${settings.businessName}`, body, supplierItems);
      ctx.db.addSupplierRequest({
        enquiry_id: enquiry.id,
        supplier_id: supplier.id,
        channel,
        body,
        itemIds: supplierItems.map((item) => item.id),
      });
      asked.push(supplier.name);
    } catch (error) {
      ctx.log(`Could not ask supplier ${supplier.name}: ${(error as Error).message}`);
    }
  }
  return asked;
}

const SupplierReply = z.object({
  answered: z
    .boolean()
    .describe("true if the message gives prices or says items are unavailable; false for messages like 'ok, will check'"),
  quotes: z.array(
    z.object({
      item_id: z.number(),
      available: z.boolean(),
      unit_cost: z.number().nullable().describe("Price per single unit, before our margin. null if not given."),
      note: z.string().describe("Delivery time or other conditions the supplier gave, or an empty string"),
    }),
  ),
});

const SYSTEM = `You are the Supplier Enquiry agent for a trading company.
A supplier answered our price request. Read their message and record, for each item we asked about,
whether they have it and their price per single unit.
- If they quote a total for the line, divide by the quantity to get the unit price.
- Leave out items the message does not mention.
- If they offer a different but equivalent product, still record it and mention the difference in the note.
${UNTRUSTED_NOTE}`;

/** Reads a supplier's reply. Returns the ids of enquiries that now have every supplier answer they were waiting for. */
export async function handleSupplierReply(ctx: AgentContext, supplier: Supplier, text: string): Promise<number[]> {
  const requests = ctx.db.openSupplierRequests(supplier.id);
  if (requests.length === 0) {
    ctx.log(`Message from supplier ${supplier.name} with no open request; left for the owner.`);
    return [];
  }

  const asked = new Map<number, { item: Item; request: SupplierRequest }>();
  for (const request of requests) {
    for (const id of JSON.parse(request.item_ids) as number[]) {
      const item = ctx.db.getItem(id);
      if (item) asked.set(id, { item, request });
    }
  }
  const listing = [...asked.values()].map(({ item }) => `Item ${item.id}: ${itemLine(item)}`).join("\n");
  const result = await ctx.llm.json({
    agent: "supplier",
    system: SYSTEM,
    prompt: `<items_we_asked_about>\n${listing}\n</items_we_asked_about>\n\n<supplier_message>\n${text.slice(0, 8000)}\n</supplier_message>`,
    schema: SupplierReply,
    effort: "medium",
  });
  if (!result.answered) return [];

  for (const quote of result.quotes) {
    const entry = asked.get(quote.item_id);
    if (!entry || !quote.available || quote.unit_cost == null || quote.unit_cost <= 0) continue;
    // Keep the cheapest supplier when several answer for the same item.
    const current = ctx.db.getItem(quote.item_id)!;
    if (current.source === "supplier" && current.cost != null && current.cost <= quote.unit_cost) continue;
    ctx.db.updateItem(quote.item_id, {
      cost: quote.unit_cost,
      available: 1,
      source: "supplier",
      supplier_id: supplier.id,
    });
  }

  const finished = new Set<number>();
  for (const request of requests) {
    ctx.db.setSupplierRequestStatus(request.id, "answered", text);
    if (ctx.db.supplierRequests(request.enquiry_id).every((r) => r.status === "answered" || r.status === "timeout")) {
      finished.add(request.enquiry_id);
    }
  }
  return [...finished];
}
