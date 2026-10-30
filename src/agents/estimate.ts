import type { Customer, Enquiry } from "../db.js";
import { money, type AgentContext } from "./context.js";
import type { PricedQuote } from "./pricing.js";

// Estimate agent: writes the quotation message and, when Zoho is connected,
// creates the estimate in Zoho so it is in your books.

export interface Quote {
  ref: string;
  body: string;
  total: number;
  zohoEstimateId: string | null;
}

export async function createQuote(
  ctx: AgentContext,
  enquiry: Enquiry,
  customer: Customer,
  priced: PricedQuote,
): Promise<Quote> {
  const settings = ctx.db.getSettings();
  let ref = enquiry.quote_ref ?? ctx.db.nextQuoteNumber();
  let zohoEstimateId: string | null = null;

  if (ctx.zoho) {
    try {
      const catalog = await ctx.catalog.items();
      const zohoIds = new Map(catalog.filter((c) => c.zohoItemId).map((c) => [c.sku, c.zohoItemId!]));
      const customerId = await ctx.zoho.customerId(customer.phone, customer.name);
      const estimate = await ctx.zoho.createEstimate(
        customerId,
        priced.lines.map((line) => ({
          zohoItemId: line.zohoSku ? zohoIds.get(line.zohoSku) : undefined,
          name: line.name,
          quantity: line.quantity,
          rate: line.unitPrice,
          unit: line.unit,
        })),
        settings.quoteValidityDays,
        ref,
      );
      zohoEstimateId = estimate.id;
      ref = estimate.number;
    } catch (error) {
      ctx.log(`Zoho estimate failed for enquiry ${enquiry.id}, quoting without it: ${(error as Error).message}`);
    }
  }

  const lines = priced.lines.map(
    (line, index) =>
      `${index + 1}. ${line.name}\n   ${line.quantity} ${line.unit ?? "pcs"} x ${money(line.unitPrice, settings)} = ${money(line.lineTotal, settings)}`,
  );
  const parts = [`*Quotation ${ref}*`, settings.businessName, "", ...lines, ""];
  if (priced.tax > 0) {
    parts.push(`Subtotal: ${money(priced.subtotal, settings)}`, `VAT ${settings.taxPercent}%: ${money(priced.tax, settings)}`);
  }
  parts.push(`*Total: ${money(priced.total, settings)}*`);
  if (priced.unavailable.length > 0) {
    parts.push("", "Not available at the moment:", ...priced.unavailable.map((item) => `- ${item.description}`));
  }
  parts.push("", `Valid for ${settings.quoteValidityDays} days. Reply *YES* to confirm the order.`);

  ctx.db.setQuote(enquiry.id, ref, priced.total, zohoEstimateId);
  return { ref, body: parts.join("\n"), total: priced.total, zohoEstimateId };
}
