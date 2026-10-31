import type { Customer, Enquiry } from "../db.js";
import { money, type AgentContext } from "./context.js";
import { NO_BRAND, type PricedQuote } from "./pricing.js";

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
      const customerId = await ctx.zoho.customerId(customer.phone, customer.name, customer.company);
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
      // Shown to the owner, so a Zoho setting that needs fixing doesn't go unnoticed.
      const reason = (error as Error).message.slice(0, 400);
      ctx.log(`Zoho estimate failed for enquiry ${enquiry.id}, quoting without it: ${reason}`);
      ctx.db.addActivity(enquiry.id, customer.id, "Estimate", `Zoho didn't create the estimate, so the quote goes as a WhatsApp message. Zoho said: ${reason}`);
      ctx.db.addAlert(`Zoho estimate not created for E${enquiry.id}. Zoho said: ${reason}`);
    }
  }

  // Lines grouped by brand, numbered straight through.
  const brands = [...new Set(priced.lines.map((line) => line.brand))];
  const lines: string[] = [];
  let n = 0;
  for (const brand of brands) {
    if (brands.length > 1 || brand !== NO_BRAND) lines.push(`*${brand}*`);
    for (const line of priced.lines.filter((l) => l.brand === brand)) {
      lines.push(`${++n}. ${line.name}\n   ${line.quantity} ${line.unit ?? "pcs"} x ${money(line.unitPrice, settings)} = ${money(line.lineTotal, settings)}`);
    }
    lines.push("");
  }
  const place = customer.emirate ? `${customer.emirate}${customer.area ? ` (${customer.area})` : ""}` : null;
  const to = [customer.name, customer.company, place].filter(Boolean).join(", ");
  const parts = [
    `*Quotation ${ref}*`,
    settings.businessName + (settings.trn ? ` · TRN ${settings.trn}` : ""),
    ...(to ? [`To: ${to}`] : []),
    ...(customer.trn && customer.trn !== "none" ? [`Customer TRN: ${customer.trn}`] : []),
    "",
    ...lines,
  ];
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
