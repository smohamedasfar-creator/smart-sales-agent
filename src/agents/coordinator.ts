import { z } from "zod";
import type { InboundEmail } from "../channels/email.js";
import type { InboundMessage, OwnerReply } from "../channels/whatsapp.js";
import { samePhone, type Customer, type Enquiry } from "../db.js";
import { money, transcript, UNTRUSTED_NOTE, type AgentContext } from "./context.js";
import { createQuote } from "./estimate.js";
import { runCustomerFollowups, runSupplierChecks } from "./followup.js";
import { gatherRequirements } from "./gatherer.js";
import { checkPrices } from "./priceChecker.js";
import { priceItems, priceWarnings } from "./pricing.js";
import { writeReply } from "./reception.js";
import { askSuppliers, handleSupplierReply } from "./supplier.js";

// Coordinator agent: receives every incoming message, works out what the customer
// wants, and hands the work to the right agent. It also runs the timed jobs
// (follow-ups, supplier reminders, checking supplier email).

const Intent = z.object({
  intent: z.enum([
    "new_enquiry",
    "add_details",
    "accept_quote",
    "decline_quote",
    "question",
    "human_request",
    "personal",
    "other",
  ]),
});

const CLASSIFY_SYSTEM = `You are the Coordinator of a trading company's WhatsApp sales team.
Classify the customer's latest message (the last "Customer" lines of the conversation):
- new_enquiry: asks for prices or availability of products, and there is no open enquiry, or it is clearly a separate new request.
- add_details: adds or changes products, quantities, sizes or brands for the open enquiry, or answers our questions about them.
- accept_quote: agrees to the quote we sent (e.g. "yes", "ok go ahead", "confirm", "send it").
- decline_quote: says no to the quote, or that they bought elsewhere.
- question: asks about something else (delivery, payment, location, an item in the quote) without changing the products.
- human_request: asks to talk to a person, or is angry or complaining.
- personal: a personal or social message from family, friends or someone the owner knows (family news, invitations, jokes, "how are you bro"), not about buying anything.
- other: greetings, thanks and anything else.
${UNTRUSTED_NOTE}`;

export class Coordinator {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(readonly ctx: AgentContext) {}

  /** Runs jobs for the same customer or supplier one at a time, in the order they arrive. */
  private serial(key: string, job: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(job).catch((error) => this.ctx.log(`Job ${key} failed: ${(error as Error).stack ?? error}`));
    this.queues.set(key, next);
    void next.then(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    return next;
  }

  // Incoming messages

  onWhatsApp(message: InboundMessage): Promise<void> {
    return this.serial(message.from, async () => {
      if (message.from === this.ctx.ownerPhone) {
        // The owner messages the business number to keep WhatsApp's 24-hour window open for alerts.
        this.ctx.log(`Message from the owner: ${message.text}`);
        return;
      }
      const contact = this.ctx.db.getSettings().personalContacts.find((c) => samePhone(c.phone, message.from));
      if (contact) {
        // Family and friends: the agents don't read or answer, and they are not added as customers.
        this.ctx.log(`Personal message from ${contact.name || message.from}; left for the owner.`);
        return;
      }
      const supplier = this.ctx.db.supplierByPhone(message.from);
      if (supplier) {
        this.ctx.db.supplierMessaged(supplier.id);
        const finished = await handleSupplierReply(this.ctx, supplier, message.text);
        for (const enquiryId of finished) void this.queueAfterSuppliers(enquiryId);
        return;
      }
      const customer = this.ctx.db.upsertCustomer(message.from, message.name);
      if (!this.ctx.db.addInbound(customer.id, message.text, message.id)) return;
      await this.handleCustomer(customer);
    });
  }

  /**
   * The owner answered a chat from the WhatsApp Business app on their phone. The agents step back from that chat
   * (so the customer never gets two answers) until the owner lets them continue from the dashboard.
   */
  onOwnerReply(reply: OwnerReply): Promise<void> {
    return this.serial(reply.to, async () => {
      const { db } = this.ctx;
      if (db.getSettings().personalContacts.some((c) => samePhone(c.phone, reply.to))) return;
      if (db.supplierByPhone(reply.to)) return;
      const customer = db.upsertCustomer(reply.to, null);
      const enquiry = db.openEnquiry(customer.id) ?? db.createEnquiry(customer.id);
      db.addOutbound(customer.id, enquiry.id, reply.text);
      db.attachMessages(customer.id, enquiry.id);
      if (enquiry.status !== "needs_human") {
        db.setStatus(enquiry.id, "needs_human", "You replied from your phone");
        this.ctx.log(`Owner replied to ${customer.name ?? customer.phone} from the phone; the agents stay quiet in this chat.`);
      }
    });
  }

  onSupplierEmail(email: InboundEmail): Promise<void> {
    return this.serial(`email:${email.from}`, async () => {
      const supplier = this.ctx.db.supplierByEmail(email.from);
      if (!supplier) return;
      const finished = await handleSupplierReply(this.ctx, supplier, `Subject: ${email.subject}\n\n${email.text}`);
      for (const enquiryId of finished) void this.queueAfterSuppliers(enquiryId);
    });
  }

  private async handleCustomer(customer: Customer): Promise<void> {
    const { db } = this.ctx;
    let enquiry = db.openEnquiry(customer.id) ?? null;
    if (enquiry?.status === "needs_human") {
      // The owner is handling this chat; the agents stay quiet.
      db.attachMessages(customer.id, enquiry.id);
      return;
    }

    try {
      const { intent } = await this.ctx.llm.json({
        agent: "coordinator",
        system: CLASSIFY_SYSTEM,
        prompt: `${transcript(db.recentMessages(customer.id, 12), customer)}\n\nOpen enquiry: ${
          enquiry ? `status ${enquiry.status}${enquiry.quote_ref ? `, quote ${enquiry.quote_ref} sent` : ""}` : "none"
        }.`,
        schema: Intent,
        effort: "low",
      });
      this.ctx.log(`Customer ${customer.phone}: ${intent}`);

      if (intent === "personal") {
        // Looks like family or a friend: stay quiet and let the owner decide.
        await this.notifyOwner(
          `${customer.name ?? customer.phone} sent a message that looks personal, so the agents didn't reply. If they are family or a friend, add +${customer.phone} to your personal contacts in Settings.`,
        );
        return;
      }

      if (intent === "human_request") {
        enquiry ??= db.createEnquiry(customer.id);
        db.attachMessages(customer.id, enquiry.id);
        db.setStatus(enquiry.id, "needs_human", "Customer asked for a person");
        await this.reply(customer, enquiry, "Tell the customer a member of our team will contact them shortly.");
        await this.notifyOwner(`Customer ${customer.name ?? customer.phone} wants to talk to a person (enquiry E${enquiry.id}).`);
        return;
      }

      if (enquiry?.status === "quoted" && intent === "accept_quote") return await this.accept(customer, enquiry);
      if (enquiry?.status === "quoted" && intent === "decline_quote") {
        db.attachMessages(customer.id, enquiry.id);
        db.setStatus(enquiry.id, "lost", "Customer declined");
        await this.reply(customer, enquiry, "Thank the customer politely, and say we are happy to help with any future needs.");
        return;
      }

      if (intent === "new_enquiry" || intent === "add_details") {
        if (!enquiry || (intent === "new_enquiry" && enquiry.status === "quoted")) enquiry = db.createEnquiry(customer.id);
        db.attachMessages(customer.id, enquiry.id);
        for (const draft of db.pendingDrafts()) if (draft.enquiry_id === enquiry.id) db.setDraft(draft.id, "rejected");
        await this.gather(customer, enquiry);
        return;
      }

      if (enquiry) db.attachMessages(customer.id, enquiry.id);
      await this.reply(
        customer,
        enquiry,
        intent === "question"
          ? "Answer the customer's question using the facts. If the facts do not answer it, say we will check and reply soon."
          : "Reply naturally. If they have not asked for anything yet, ask which products they need a price for.",
        enquiry ? this.facts(enquiry, customer) : "",
      );
    } catch (error) {
      this.ctx.log(`Agents failed for customer ${customer.phone}: ${(error as Error).stack ?? error}`);
      enquiry ??= db.createEnquiry(customer.id);
      db.attachMessages(customer.id, enquiry.id);
      db.setStatus(enquiry.id, "needs_human", `Agent error: ${(error as Error).message}`);
      await this.notifyOwner(`The agents could not handle a message from ${customer.name ?? customer.phone} (E${enquiry.id}). Please reply yourself.`);
    }
  }

  // The enquiry pipeline: gather -> price check -> suppliers -> pricing -> estimate

  private async gather(customer: Customer, enquiry: Enquiry): Promise<void> {
    this.ctx.db.setStatus(enquiry.id, "gathering");
    const result = await gatherRequirements(this.ctx, enquiry, customer);
    if (result.items.length === 0) {
      await this.reply(customer, enquiry, "Ask which products, sizes and quantities they need a price for.");
      return;
    }
    if (result.missing_questions.length > 0) {
      await this.reply(
        customer,
        enquiry,
        "Ask these questions so we can prepare the quotation. Briefly confirm what you understood so far.",
        `Items so far:\n${result.items.map((i) => `- ${i.quantity || "?"} ${i.unit ?? ""} ${i.description}`).join("\n")}\n\nQuestions:\n${result.missing_questions.map((q) => `- ${q}`).join("\n")}`,
      );
      return;
    }
    await this.check(customer, this.ctx.db.getEnquiry(enquiry.id)!);
  }

  private async check(customer: Customer, enquiry: Enquiry): Promise<void> {
    const { db } = this.ctx;
    db.setStatus(enquiry.id, "checking");
    const { needSupplier } = await checkPrices(this.ctx, enquiry.id);
    if (needSupplier.length > 0 && db.suppliers().length > 0) {
      const asked = await askSuppliers(this.ctx, enquiry, needSupplier);
      if (asked > 0) {
        db.setStatus(enquiry.id, "waiting_supplier");
        await this.reply(
          customer,
          enquiry,
          "Thank the customer and tell them we are preparing their quotation and will share it shortly. Do not mention suppliers, stock, availability or checking anything.",
          `Items requested:\n${db.items(enquiry.id).map((i) => `- ${i.quantity} ${i.unit ?? ""} ${i.description}`).join("\n")}`,
        );
        return;
      }
    }
    await this.quote(customer, db.getEnquiry(enquiry.id)!);
  }

  /** Continues the enquiry in its customer's queue, so it never runs alongside that customer's messages. */
  private queueAfterSuppliers(enquiryId: number): Promise<void> {
    const enquiry = this.ctx.db.getEnquiry(enquiryId);
    if (!enquiry) return Promise.resolve();
    const customer = this.ctx.db.getCustomer(enquiry.customer_id)!;
    return this.serial(customer.phone, () => this.afterSuppliers(enquiryId));
  }

  private async afterSuppliers(enquiryId: number): Promise<void> {
    const enquiry = this.ctx.db.getEnquiry(enquiryId);
    if (enquiry?.status !== "waiting_supplier") return;
    await this.quote(this.ctx.db.getCustomer(enquiry.customer_id)!, enquiry);
  }

  private async quote(customer: Customer, enquiry: Enquiry): Promise<void> {
    const { db } = this.ctx;
    const settings = db.getSettings();
    const priced = priceItems(db.items(enquiry.id), settings, customer.phone);
    if (priced.lines.length === 0) {
      db.setStatus(enquiry.id, "needs_human", "None of the items could be priced");
      await this.reply(customer, enquiry, "Tell the customer we are checking these items and our team will get back to them soon.");
      await this.notifyOwner(`Enquiry E${enquiry.id} from ${customer.name ?? customer.phone}: no item could be priced. Please check.`);
      return;
    }
    const quote = await createQuote(this.ctx, enquiry, customer, priced);
    const warnings = priceWarnings(db.items(enquiry.id), priced);
    if (settings.requireApproval || warnings.length > 0) {
      db.addDraft({ enquiry_id: enquiry.id, kind: "quote", to_phone: customer.phone, body: quote.body });
      db.setStatus(enquiry.id, "awaiting_approval", warnings.length ? `Check prices: ${warnings.join("; ")}` : undefined);
      await this.notifyOwner(
        `Quote ${quote.ref} for ${customer.name ?? customer.phone} (${money(quote.total, settings)}) is waiting for your approval.` +
          (warnings.length ? ` Please check: ${warnings.join("; ")}.` : ""),
      );
      return;
    }
    await this.send(customer, enquiry.id, quote.body);
    await this.quoteSent(enquiry.id);
  }

  private async quoteSent(enquiryId: number): Promise<void> {
    this.ctx.db.markQuoted(enquiryId);
    const enquiry = this.ctx.db.getEnquiry(enquiryId)!;
    if (enquiry.zoho_estimate_id && this.ctx.zoho) {
      await this.ctx.zoho.markEstimate(enquiry.zoho_estimate_id, "sent").catch((error) => this.ctx.log(`Zoho: ${error.message}`));
    }
  }

  private async accept(customer: Customer, enquiry: Enquiry): Promise<void> {
    const { db } = this.ctx;
    db.attachMessages(customer.id, enquiry.id);
    db.setStatus(enquiry.id, "won", "Customer accepted the quote");
    if (enquiry.zoho_estimate_id && this.ctx.zoho) {
      await this.ctx.zoho.markEstimate(enquiry.zoho_estimate_id, "accepted").catch((error) => this.ctx.log(`Zoho: ${error.message}`));
    }
    await this.reply(
      customer,
      enquiry,
      "Thank the customer and confirm we received their order for this quote. Explain the next steps (payment, delivery) only if they are in the business information; otherwise say our team will contact them to arrange delivery.",
      this.facts(enquiry, customer),
    );
    const settings = db.getSettings();
    await this.notifyOwner(
      `Order confirmed: ${customer.name ?? customer.phone} accepted quote ${enquiry.quote_ref} (${money(enquiry.quote_total ?? 0, settings)}).`,
    );
  }

  /** What the Reception agent may tell the customer about this enquiry. */
  private facts(enquiry: Enquiry, customer: Customer): string {
    const settings = this.ctx.db.getSettings();
    const items = this.ctx.db.items(enquiry.id);
    if (items.length === 0) return "";
    const lines = [`Items requested:`, ...items.map((i) => `- ${i.quantity} ${i.unit ?? ""} ${i.description}`)];
    if (enquiry.status === "quoted" || enquiry.status === "won") {
      const priced = priceItems(items, settings, customer.phone);
      lines.push(
        "",
        `Quote ${enquiry.quote_ref} (valid ${settings.quoteValidityDays} days):`,
        ...priced.lines.map((l) => `- ${l.name}: ${l.quantity} x ${money(l.unitPrice, settings)} = ${money(l.lineTotal, settings)}`),
        `Total: ${money(enquiry.quote_total ?? priced.total, settings)}`,
      );
    }
    return lines.join("\n");
  }

  // Sending

  private async send(customer: Customer, enquiryId: number | null, body: string): Promise<void> {
    await this.ctx.whatsapp.sendText(customer.phone, body);
    this.ctx.db.addOutbound(customer.id, enquiryId, body);
  }

  private async reply(customer: Customer, enquiry: Enquiry | null, task: string, facts = ""): Promise<void> {
    const text = await writeReply(this.ctx, customer, enquiry, task, facts);
    if (text) await this.send(customer, enquiry?.id ?? null, text);
  }

  private async notifyOwner(text: string): Promise<void> {
    this.ctx.log(`Owner: ${text}`);
    if (!this.ctx.ownerPhone) return;
    try {
      await this.ctx.whatsapp.sendText(this.ctx.ownerPhone, text);
    } catch (error) {
      this.ctx.log(`Could not notify the owner on WhatsApp: ${(error as Error).message}`);
    }
  }

  // Owner actions from the dashboard

  async approveDraft(draftId: number, editedBody?: string): Promise<void> {
    const { db } = this.ctx;
    const draft = db.getDraft(draftId);
    if (!draft || draft.status !== "pending") throw new Error("This draft is no longer waiting for approval");
    const body = editedBody?.trim() || draft.body;
    const customer = db.upsertCustomer(draft.to_phone, null);
    await this.send(customer, draft.enquiry_id, body);
    db.setDraft(draft.id, "sent", body);
    if (draft.kind === "quote" && draft.enquiry_id) await this.quoteSent(draft.enquiry_id);
  }

  rejectDraft(draftId: number): void {
    const { db } = this.ctx;
    const draft = db.getDraft(draftId);
    if (!draft || draft.status !== "pending") throw new Error("This draft is no longer waiting for approval");
    db.setDraft(draft.id, "rejected");
    if (draft.enquiry_id) db.setStatus(draft.enquiry_id, "needs_human", "Owner rejected the draft");
  }

  /** Lets the agents handle a chat again after the owner took it over. */
  resume(enquiryId: number): void {
    const enquiry = this.ctx.db.getEnquiry(enquiryId);
    if (!enquiry) throw new Error("Enquiry not found");
    this.ctx.db.setStatus(enquiryId, enquiry.quote_ref ? "quoted" : "gathering", "");
  }

  /** Sends a message typed by the owner from the dashboard. */
  async sendManual(enquiryId: number, body: string): Promise<void> {
    const enquiry = this.ctx.db.getEnquiry(enquiryId);
    if (!enquiry) throw new Error("Enquiry not found");
    await this.send(this.ctx.db.getCustomer(enquiry.customer_id)!, enquiryId, body);
  }

  // Timed jobs, run every minute

  async tick(): Promise<void> {
    await runCustomerFollowups(this.ctx);
    for (const enquiryId of await runSupplierChecks(this.ctx)) await this.queueAfterSuppliers(enquiryId);
    if (this.ctx.mailer) {
      try {
        for (const email of await this.ctx.mailer.fetchUnread()) await this.onSupplierEmail(email);
      } catch (error) {
        this.ctx.log(`Email check failed: ${(error as Error).message}`);
      }
    }
  }
}
