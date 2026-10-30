import type { Enquiry } from "../db.js";
import { transcript, UNTRUSTED_NOTE, within24h, type AgentContext } from "./context.js";

// Follow-up agent: reminds customers who have not answered a quote, and chases
// suppliers who have not answered a price request.

const HOUR = 3_600_000;

function hoursSince(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / HOUR;
}

async function followUpCustomer(ctx: AgentContext, enquiry: Enquiry): Promise<void> {
  const settings = ctx.db.getSettings();
  const customer = ctx.db.getCustomer(enquiry.customer_id)!;
  const now = ctx.db.now();
  const { whatsapp } = ctx.config;
  const last = enquiry.followups_sent + 1 === settings.followupHours.length;

  if (within24h(customer.last_inbound_at, now)) {
    const text = await ctx.llm.text({
      agent: "followup",
      system: `You write short, polite WhatsApp follow-ups for ${settings.businessName}. Tone: ${settings.tone}
Reply in the customer's language. Do not repeat the full quote, do not change any price, and do not pressure the customer.
Write only the message text.
${UNTRUSTED_NOTE}`,
      prompt: `${transcript(ctx.db.recentMessages(customer.id, 15), customer)}\n\nWe sent quote ${enquiry.quote_ref} and the customer has not replied. ${
        last ? "This is our last follow-up: let them know we are here whenever they are ready." : "Ask if they had a chance to look at it, or if they need any changes."
      }`,
      effort: "low",
    });
    await ctx.whatsapp.sendText(customer.phone, text);
    ctx.db.addOutbound(customer.id, enquiry.id, text);
  } else if (whatsapp.followupTemplate) {
    // Outside the 24-hour window only an approved template can be sent.
    await ctx.whatsapp.sendTemplate(customer.phone, whatsapp.followupTemplate, whatsapp.followupTemplateLanguage, [
      customer.name ?? "there",
      enquiry.quote_ref ?? "",
    ]);
    ctx.db.addOutbound(customer.id, enquiry.id, `[template ${whatsapp.followupTemplate}] quote ${enquiry.quote_ref}`);
  } else {
    ctx.log(`Follow-up for enquiry ${enquiry.id} skipped: over 24 hours and WHATSAPP_FOLLOWUP_TEMPLATE is not set.`);
  }
  ctx.db.countFollowup(enquiry.id);
}

export async function runCustomerFollowups(ctx: AgentContext): Promise<void> {
  const settings = ctx.db.getSettings();
  const now = ctx.db.now();
  for (const enquiry of ctx.db.enquiriesByStatus("quoted")) {
    const due = settings.followupHours[enquiry.followups_sent];
    if (due === undefined || !enquiry.quoted_at) continue;
    const customer = ctx.db.getCustomer(enquiry.customer_id)!;
    // A reply from the customer after the quote means the conversation is active; no reminder needed.
    if (customer.last_inbound_at && customer.last_inbound_at > enquiry.quoted_at) continue;
    if (hoursSince(enquiry.quoted_at, now) < due) continue;
    try {
      await followUpCustomer(ctx, enquiry);
    } catch (error) {
      ctx.log(`Follow-up for enquiry ${enquiry.id} failed: ${(error as Error).message}`);
    }
  }
}

/** Reminds slow suppliers once, then gives up. Returns enquiries that have no supplier left to wait for. */
export async function runSupplierChecks(ctx: AgentContext): Promise<number[]> {
  const settings = ctx.db.getSettings();
  const now = ctx.db.now();
  const finished = new Set<number>();
  for (const request of ctx.db.openSupplierRequests()) {
    const age = hoursSince(request.sent_at, now);
    if (age >= settings.supplierGiveUpHours) {
      ctx.db.setSupplierRequestStatus(request.id, "timeout");
      const all = ctx.db.supplierRequests(request.enquiry_id);
      if (all.every((r) => r.status === "answered" || r.status === "timeout")) finished.add(request.enquiry_id);
    } else if (request.status === "sent" && age >= settings.supplierReminderHours) {
      const supplier = ctx.db.getSupplier(request.supplier_id)!;
      const text = `Hello ${supplier.name}, a gentle reminder about our price enquiry E${request.enquiry_id}. Could you share your prices when possible? Thank you.`;
      try {
        if (request.channel === "email" && supplier.email && ctx.mailer) {
          await ctx.mailer.send(supplier.email, `Reminder: price enquiry E${request.enquiry_id}`, `${text}\n\n${request.body}`);
        } else if (supplier.phone && within24h(supplier.last_inbound_at, now)) {
          await ctx.whatsapp.sendText(supplier.phone, text);
        }
      } catch (error) {
        ctx.log(`Reminder to supplier ${supplier.name} failed: ${(error as Error).message}`);
      }
      ctx.db.setSupplierRequestStatus(request.id, "reminded");
    }
  }
  return [...finished];
}
