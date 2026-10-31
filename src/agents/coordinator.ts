import { z } from "zod";
import type { InboundEmail } from "../channels/email.js";
import type { InboundMessage, OwnerReply } from "../channels/whatsapp.js";
import { samePhone, type Customer, type Enquiry } from "../db.js";
import { money, transcript, UNTRUSTED_NOTE, type AgentContext } from "./context.js";
import { normalize, searchCatalog } from "../catalog/catalog.js";
import { customerLine, emirateIn, listText, missingDetails, updateDetails } from "./details.js";
import { createQuote } from "./estimate.js";
import { runCustomerFollowups, runSupplierChecks } from "./followup.js";
import { gatherRequirements } from "./gatherer.js";
import { checkPrices } from "./priceChecker.js";
import { buyerFor, priceItems, priceWarnings, type PricedQuote } from "./pricing.js";
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
- other: greetings, thanks and anything else. Messages that only give the customer's name, company, location or TRN are "other".
${UNTRUSTED_NOTE}`;

const INTENT_LABEL: Record<z.infer<typeof Intent>["intent"], string> = {
  new_enquiry: "a new price request",
  add_details: "more details for the request",
  accept_quote: "yes to the quote",
  decline_quote: "no to the quote",
  question: "a question",
  human_request: "wants to talk to a person",
  personal: "looks personal, so the agents stay quiet",
  other: "a general message",
};

const HOLDING_REPLY = "Thank you for your message. Our team will get back to you shortly.";

export class Coordinator {
  private readonly queues = new Map<string, Promise<void>>();
  /** Which agent is working on each customer's chat right now, for the dashboard. */
  private readonly working = new Map<string, { agent: string; since: string }>();

  /** The agent working on this phone number's chat right now, if any. */
  workingOn(phone: string): { agent: string; since: string } | null {
    return this.working.get(phone) ?? null;
  }

  /** Marks which agent is working and, with text, adds the step to the enquiry's timeline. */
  private step(customer: Customer, enquiryId: number | null, agent: string, text?: string): void {
    this.working.set(customer.phone, { agent, since: this.ctx.db.now().toISOString() });
    if (text) this.ctx.db.addActivity(enquiryId, customer.id, agent, text);
  }

  constructor(readonly ctx: AgentContext) {}

  /** Runs jobs for the same customer or supplier one at a time, in the order they arrive. */
  private serial(key: string, job: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .then(job)
      .catch((error) => this.ctx.log(`Job ${key} failed: ${(error as Error).stack ?? error}`))
      .finally(() => this.working.delete(key));
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
        const asked = this.ctx.db.openSupplierRequests(supplier.id);
        const finished = await handleSupplierReply(this.ctx, supplier, message.text);
        for (const enquiryId of new Set(asked.map((r) => r.enquiry_id))) {
          this.ctx.db.addActivity(enquiryId, null, "Supplier Enquiry", `Read ${supplier.name}'s reply: "${message.text.slice(0, 200)}"`);
        }
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
        db.addActivity(enquiry.id, customer.id, "You", "Replied from the WhatsApp Business app; the agents step back in this chat.");
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

  /** True when the customer's latest message names something from the price list, not just a name, place or TRN. */
  private async namesProducts(customer: Customer): Promise<boolean> {
    const last = this.ctx.db.recentMessages(customer.id, 5).filter((m) => m.direction === "in").at(-1)?.body ?? "";
    const stop = new Set(["this", "from", "are", "for", "with", "our", "the", "and", "sorry", "trn", "vat", "number", "company", "name", "located", "here", "you", "your", "thanks", "thank"]);
    const words = normalize(last).filter((w) => !/\d/.test(w) && w.length >= 3 && !stop.has(w) && !emirateIn(w));
    if (words.length === 0) return false;
    return searchCatalog(await this.ctx.catalog.items(), words.join(" ")).some((item) => words.some((w) => normalize(item.name).includes(w)));
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
      this.step(customer, enquiry?.id ?? null, "Coordinator");
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
      this.step(customer, enquiry?.id ?? null, "Coordinator", `Read the customer's message: ${INTENT_LABEL[intent]}.`);

      if (intent === "personal") {
        // Looks like family or a friend: stay quiet and let the owner decide.
        await this.notifyOwner(
          `${customer.name ?? customer.phone} sent a message that looks personal, so the agents didn't reply. If they are family or a friend, add +${customer.phone} to your personal contacts in Settings.`,
        );
        return;
      }

      // A new customer gives name, company, emirate and TRN before a quote goes out.
      const settings = db.getSettings();
      let detailsSaved = false;
      if (settings.requireDetails && missingDetails(customer).length > 0) {
        this.step(customer, enquiry?.id ?? null, "Customer Details");
        const saved = await updateDetails(this.ctx, customer);
        customer = db.getCustomer(customer.id)!;
        if (saved.length > 0) {
          detailsSaved = true;
          this.step(customer, enquiry?.id ?? null, "Customer Details", `Saved ${saved.join(", ")}.${missingDetails(customer).length ? ` Still to ask: ${listText(missingDetails(customer))}.` : " All details known."}`);
          this.ctx.log(`Customer details for ${customer.phone}: ${saved.join(", ")}`);
          if (missingDetails(customer).length === 0 && customer.level === null) {
            db.updateCustomer(customer.id, { level: settings.newCustomerLevel });
            customer = db.getCustomer(customer.id)!;
            const buyer = buyerFor(settings, customer, db.hasOrdered(customer.id));
            const name = (level: number) => settings.levels[level - 1]?.name ?? `Level ${level}`;
            await this.notifyOwner(
              `New customer: ${customerLine(customer)}. ${buyer.firstOrder ? `Their first order gets ${name(buyer.level)} prices, then` : "They are on"} ${name(customer.level!)}; change it in Enquiries if needed.`,
            );
          }
        }
      }
      const onlyDetails = detailsSaved && (intent === "new_enquiry" || intent === "add_details") && !(await this.namesProducts(customer));
      const effective = onlyDetails ? "other" : intent;

      if (enquiry?.status === "awaiting_details" && effective !== "new_enquiry" && effective !== "add_details" && effective !== "human_request") {
        db.attachMessages(customer.id, enquiry.id);
        const missing = missingDetails(customer);
        if (missing.length > 0) {
          await this.reply(customer, enquiry, `Thank the customer and politely ask for their ${listText(missing)} so we can finalise the quotation.`, "", { asksDetails: true });
          return;
        }
        this.ctx.log(`Customer details complete for E${enquiry.id}; finishing the quotation.`);
        this.step(customer, enquiry.id, "Coordinator", "Customer details complete; finishing the quotation.");
        await this.quote(customer, enquiry);
        return;
      }
      if (detailsSaved && effective === "other") {
        if (enquiry) db.attachMessages(customer.id, enquiry.id);
        const missing = missingDetails(customer);
        await this.reply(
          customer,
          enquiry,
          `Thank the customer for their details.${missing.length ? ` Politely ask for their ${listText(missing)} too.` : ""}${enquiry ? " Say their quotation will follow shortly." : " Ask which products they need."}`,
          "",
          { asksDetails: missing.length > 0 },
        );
        return;
      }

      if (intent === "human_request") {
        enquiry ??= db.createEnquiry(customer.id);
        db.attachMessages(customer.id, enquiry.id);
        db.setStatus(enquiry.id, "needs_human", "Customer asked for a person");
        this.step(customer, enquiry.id, "Coordinator", "The customer asked for a person. Handed to you.");
        await this.reply(customer, enquiry, "Tell the customer a member of our team will contact them shortly.");
        await this.notifyOwner(`Customer ${customer.name ?? customer.phone} wants to talk to a person (enquiry E${enquiry.id}).`);
        return;
      }

      if (enquiry?.status === "quoted" && intent === "accept_quote") return await this.accept(customer, enquiry);
      if (enquiry?.status === "quoted" && intent === "decline_quote") {
        db.attachMessages(customer.id, enquiry.id);
        db.setStatus(enquiry.id, "lost", "Customer declined");
        this.step(customer, enquiry.id, "Coordinator", "The customer declined the quote.");
        await this.reply(customer, enquiry, "Thank the customer politely, and say we are happy to help with any future needs.");
        return;
      }

      if (effective === "new_enquiry" || effective === "add_details") {
        if (!enquiry || (effective === "new_enquiry" && enquiry.status === "quoted")) enquiry = db.createEnquiry(customer.id);
        db.attachMessages(customer.id, enquiry.id);
        for (const draft of db.pendingDrafts()) if (draft.enquiry_id === enquiry.id) db.setDraft(draft.id, "rejected");
        await this.gather(customer, enquiry);
        return;
      }

      if (enquiry) db.attachMessages(customer.id, enquiry.id);
      await this.reply(
        customer,
        enquiry,
        effective === "question"
          ? "Answer the customer's question using the facts. If the facts do not answer it, say we will check and reply soon."
          : "Reply naturally. If they have not asked for anything yet, ask which products they need a price for.",
        enquiry ? this.facts(enquiry, customer) : "",
      );
    } catch (error) {
      this.ctx.log(`Agents failed for customer ${customer.phone}: ${(error as Error).stack ?? error}`);
      enquiry ??= db.createEnquiry(customer.id);
      db.attachMessages(customer.id, enquiry.id);
      db.setStatus(enquiry.id, "needs_human", `Agent error: ${(error as Error).message}`);
      db.addActivity(enquiry.id, customer.id, "Coordinator", `Stopped: ${(error as Error).message.slice(0, 300)}. Handed to you; the customer was told you'll reply shortly.`);
      // Never leave the customer without an answer.
      try {
        await this.send(customer, enquiry.id, HOLDING_REPLY);
      } catch (sendError) {
        this.ctx.log(`Could not send the holding reply: ${(sendError as Error).message}`);
      }
      await this.notifyOwner(
        `The agents could not handle a message from ${customer.name ?? customer.phone} (E${enquiry.id}); the customer was told you'll reply shortly. Reason: ${(error as Error).message.slice(0, 300)}`,
      );
    }
  }

  // The enquiry pipeline: gather -> price check -> suppliers -> pricing -> estimate

  private async gather(customer: Customer, enquiry: Enquiry): Promise<void> {
    this.ctx.db.setStatus(enquiry.id, "gathering");
    this.step(customer, enquiry.id, "Requirement Gatherer");
    const result = await gatherRequirements(this.ctx, enquiry, customer);
    this.step(
      customer,
      enquiry.id,
      "Requirement Gatherer",
      result.items.length
        ? `Items: ${result.items.map((i) => `${i.quantity || "?"} ${i.unit ?? ""} ${i.description}`.replace(/\s+/g, " ")).join("; ")}.` +
            (result.missing_questions.length ? ` To ask: ${result.missing_questions.join(" ")}` : " Nothing more to ask.")
        : "No products asked for yet.",
    );
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
        { fallback: `Thank you${customer.name ? `, ${customer.name}` : ""}. To prepare your quotation, could you please confirm:\n${result.missing_questions.map((q) => `- ${q}`).join("\n")}` },
      );
      return;
    }
    await this.check(customer, this.ctx.db.getEnquiry(enquiry.id)!);
  }

  private async check(customer: Customer, enquiry: Enquiry): Promise<void> {
    const { db } = this.ctx;
    db.setStatus(enquiry.id, "checking");
    this.step(customer, enquiry.id, "Price & Stock");
    const { needSupplier } = await checkPrices(this.ctx, enquiry.id);
    this.step(
      customer,
      enquiry.id,
      "Price & Stock",
      db
        .items(enquiry.id)
        .map((i) => `${i.description} → ${i.matched_name ? `${i.matched_name} (${i.brand ?? "no brand"}), ${i.source === "stock" ? "in stock" : "not enough stock"}` : "not in the price list"}`)
        .join("; "),
    );
    // Each brand's agent takes its own items: from stock, or from that brand's suppliers.
    const byBrand = new Map<string, typeof needSupplier>();
    for (const item of needSupplier) byBrand.set(item.brand ?? "", [...(byBrand.get(item.brand ?? "") ?? []), item]);
    let asked = 0;
    for (const [brand, items] of byBrand) {
      const label = brand ? `${brand} agent` : "Supplier Enquiry";
      this.step(customer, enquiry.id, label);
      const names = await askSuppliers(this.ctx, enquiry, items, brand || null);
      asked += names.length;
      this.step(
        customer,
        enquiry.id,
        label,
        names.length ? `Asked ${names.join(" and ")} for ${items.map((i) => i.description).join(", ")}.` : `No supplier set up for ${brand || "these items"}.`,
      );
      if (names.length > 0) this.ctx.log(`${label}: asked ${names.join(" and ")} for ${items.map((i) => i.description).join(", ")} (E${enquiry.id})`);
      else await this.notifyOwner(`No supplier is set up for ${brand || "these items"}, so ${items.map((i) => i.description).join(", ")} can't be priced (E${enquiry.id}). Add a supplier${brand ? ` for ${brand}` : ""}.`);
    }
    if (needSupplier.length > 0) {
      if (asked > 0) {
        db.setStatus(enquiry.id, "waiting_supplier");
        db.addActivity(enquiry.id, customer.id, "Coordinator", "Waiting for the suppliers' prices.");
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
    customer = db.getCustomer(customer.id)!;
    const missing = missingDetails(customer);
    if (settings.requireDetails && missing.length > 0) {
      db.setStatus(enquiry.id, "awaiting_details", `Waiting for the customer's ${listText(missing)}`);
      this.step(customer, enquiry.id, "Customer Details", `The quote waits for the customer's ${listText(missing)}.`);
      await this.reply(
        customer,
        enquiry,
        `Thank the customer. Tell them the quotation is almost ready, and politely ask for their ${listText(missing)} to finalise it. Do not mention suppliers or stock.`,
        "",
        { asksDetails: true },
      );
      return;
    }
    this.step(customer, enquiry.id, "Pricing & Margin");
    const priced = this.price(customer, db.items(enquiry.id));
    this.step(
      customer,
      enquiry.id,
      "Pricing & Margin",
      priced.lines.length
        ? priced.lines.map((l) => `${l.name}: ${l.quantity} x ${money(l.unitPrice, settings)} (${l.how})`).join("; ") + `. Total ${money(priced.total, settings)}.`
        : "No item could be priced.",
    );
    this.ctx.log(`Pricing E${enquiry.id}: ${priced.lines.map((l) => `${l.brand}: ${l.name} ${l.quantity} x ${l.unitPrice} (${l.how})`).join("; ")}`);
    if (priced.lines.length === 0) {
      db.setStatus(enquiry.id, "needs_human", "None of the items could be priced");
      await this.reply(customer, enquiry, "Tell the customer we are checking these items and our team will get back to them soon.");
      await this.notifyOwner(`Enquiry E${enquiry.id} from ${customer.name ?? customer.phone}: no item could be priced. Please check.`);
      return;
    }
    this.step(customer, enquiry.id, "Estimate");
    const quote = await createQuote(this.ctx, enquiry, customer, priced);
    const warnings = priceWarnings(db.items(enquiry.id), priced);
    this.step(customer, enquiry.id, "Estimate", `Wrote quotation ${quote.ref} (${money(quote.total, settings)}).`);
    if (settings.requireApproval || warnings.length > 0) {
      db.addDraft({ enquiry_id: enquiry.id, kind: "quote", to_phone: customer.phone, body: quote.body });
      db.setStatus(enquiry.id, "awaiting_approval", warnings.length ? `Check prices: ${warnings.join("; ")}` : undefined);
      db.addActivity(enquiry.id, customer.id, "Coordinator", `Waiting for your approval${warnings.length ? `. Please check: ${warnings.join("; ")}` : ""}.`);
      await this.notifyOwner(
        `Quote ${quote.ref} for ${customerLine(customer)} (${money(quote.total, settings)}) is waiting for your approval.` +
          (warnings.length ? ` Please check: ${warnings.join("; ")}.` : ""),
      );
      return;
    }
    await this.sendQuote(customer, enquiry.id, quote.body);
    await this.quoteSent(enquiry.id);
  }

  /** Prices items for this customer: their price list prices, margins and level (the first-order level on a first order). */
  private price(customer: Customer, items: ReturnType<AgentContext["db"]["items"]>): PricedQuote {
    const { db } = this.ctx;
    const settings = db.getSettings();
    return priceItems(items, settings, buyerFor(settings, customer, db.hasOrdered(customer.id)));
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
    // Priced before the status changes, so a first order keeps its first-order prices.
    const priced = this.price(customer, db.items(enquiry.id));
    db.attachMessages(customer.id, enquiry.id);
    const facts = this.facts(enquiry, customer);
    db.setStatus(enquiry.id, "won", "Customer accepted the quote");
    if (enquiry.zoho_estimate_id && this.ctx.zoho) {
      await this.ctx.zoho.markEstimate(enquiry.zoho_estimate_id, "accepted").catch((error) => this.ctx.log(`Zoho: ${error.message}`));
    }
    await this.reply(
      customer,
      enquiry,
      "Thank the customer and confirm we received their order for this quote. Explain the next steps (payment, delivery) only if they are in the business information; otherwise say our team will contact them to arrange delivery.",
      facts,
    );
    const settings = db.getSettings();
    // One order per brand, so each brand's orders can be managed on their own.
    const orders = [...new Set(priced.lines.map((l) => l.brand))].map((brand) => {
      const lines = priced.lines.filter((l) => l.brand === brand);
      const subtotal = Math.round(lines.reduce((sum, l) => sum + l.lineTotal, 0) * 100) / 100;
      return db.addOrder({
        enquiry_id: enquiry.id,
        customer_id: customer.id,
        quote_ref: enquiry.quote_ref,
        brand,
        subtotal,
        lines: lines.map(({ name, quantity, unit, unitPrice, lineTotal }) => ({ name, quantity, unit, unitPrice, lineTotal })),
      });
    });
    if (customer.level === null) db.updateCustomer(customer.id, { level: settings.newCustomerLevel });
    db.addActivity(enquiry.id, customer.id, "Coordinator", `The customer accepted quotation ${enquiry.quote_ref}.`);
    for (const o of orders) db.addActivity(enquiry.id, customer.id, `${o.brand} agent`, `Order ${o.ref}: ${money(o.subtotal, settings)} before VAT.`);
    await this.notifyOwner(
      `Order confirmed: ${customerLine(customer)} accepted quote ${enquiry.quote_ref} (${money(enquiry.quote_total ?? 0, settings)}). ` +
        `By brand: ${orders.map((o) => `${o.brand} ${o.ref} ${money(o.subtotal, settings)}`).join("; ")}.`,
    );
  }

  /** What the Reception agent may tell the customer about this enquiry. */
  private facts(enquiry: Enquiry, customer: Customer): string {
    const settings = this.ctx.db.getSettings();
    const items = this.ctx.db.items(enquiry.id);
    if (items.length === 0) return "";
    const lines = [`Items requested:`, ...items.map((i) => `- ${i.quantity} ${i.unit ?? ""} ${i.description}`)];
    if (enquiry.status === "quoted" || enquiry.status === "won") {
      const priced = this.price(customer, items);
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

  /**
   * Sends a quotation: the Zoho estimate PDF with a short message when Zoho made one, otherwise the text quotation.
   * The text is kept in the chat history either way.
   */
  private async sendQuote(customer: Customer, enquiryId: number, body: string): Promise<void> {
    const { db, zoho, whatsapp } = this.ctx;
    const enquiry = db.getEnquiry(enquiryId);
    if (zoho && enquiry?.zoho_estimate_id) {
      try {
        const pdf = await zoho.estimatePdf(enquiry.zoho_estimate_id);
        const settings = db.getSettings();
        const caption =
          `*Quotation ${enquiry.quote_ref}*\nTotal: ${money(enquiry.quote_total ?? 0, settings)}${settings.taxPercent > 0 ? ` (incl. VAT)` : ""}\n` +
          `Valid for ${settings.quoteValidityDays} days. Reply *YES* to confirm the order.`;
        await whatsapp.sendDocument(customer.phone, pdf, `${enquiry.quote_ref}.pdf`, caption);
        db.addOutbound(customer.id, enquiryId, `[Zoho estimate ${enquiry.quote_ref} sent as PDF]\n${body}`);
        db.addActivity(enquiryId, customer.id, "Estimate", `Sent Zoho estimate ${enquiry.quote_ref} to the customer as a PDF.`);
        return;
      } catch (error) {
        const reason = (error as Error).message.slice(0, 300);
        db.addActivity(enquiryId, customer.id, "Estimate", `Couldn't send the Zoho PDF (${reason}); sent the quotation as text.`);
      }
    }
    await this.send(customer, enquiryId, body);
    db.addActivity(enquiryId, customer.id, "Coordinator", "Sent the quotation to the customer.");
  }

  private async reply(customer: Customer, enquiry: Enquiry | null, task: string, facts = "", options: { asksDetails?: boolean; fallback?: string } = {}): Promise<void> {
    const { db } = this.ctx;
    customer = db.getCustomer(customer.id) ?? customer;
    const missing = db.getSettings().requireDetails ? missingDetails(customer) : [];
    const askNow = missing.length > 0 && !customer.details_asked && !options.asksDetails && !/team will contact|happy to help with any future/.test(task);
    if (askNow) task += ` This is a new customer: at the end, also politely ask for their ${listText(missing)}, so we can prepare the quotation and arrange delivery.`;
    if (askNow || options.asksDetails) db.updateCustomer(customer.id, { details_asked: 1 });
    this.step(customer, enquiry?.id ?? null, "WhatsApp Reception");
    let text: string;
    try {
      text = await writeReply(this.ctx, customer, enquiry, task, facts);
    } catch (error) {
      // Without a fallback the caller's error handling takes over; with one, the conversation goes on.
      if (!options.fallback) throw error;
      this.ctx.log(`Reception failed, sending the plain version: ${(error as Error).message}`);
      text = options.fallback;
    }
    if (text) await this.send(customer, enquiry?.id ?? null, text);
  }

  /** Tells the owner: always on the dashboard's Alerts list, and on WhatsApp too when OWNER_PHONE is set. */
  private async notifyOwner(text: string): Promise<void> {
    this.ctx.log(`Owner: ${text}`);
    this.ctx.db.addAlert(text);
    if (!this.ctx.ownerPhone) return;
    try {
      await this.ctx.whatsapp.sendText(this.ctx.ownerPhone, text);
    } catch (error) {
      this.ctx.log(`Could not notify the owner on WhatsApp: ${(error as Error).message}`);
    }
  }

  /**
   * After a restart, enquiries that were still being worked on (their customer's last message has no answer)
   * are picked up again, so no customer is left waiting.
   */
  resumeInterrupted(): Promise<void>[] {
    const { db } = this.ctx;
    const stuck = [...db.enquiriesByStatus("gathering"), ...db.enquiriesByStatus("checking")];
    return stuck.flatMap((enquiry) => {
      const customer = db.getCustomer(enquiry.customer_id);
      const last = customer ? db.recentMessages(customer.id, 1)[0] : undefined;
      if (!customer || last?.direction !== "in") return [];
      this.ctx.log(`Picking up E${enquiry.id} again after a restart.`);
      return [this.serial(customer.phone, () => this.handleCustomer(db.getCustomer(customer.id)!))];
    });
  }

  // Owner actions from the dashboard

  async approveDraft(draftId: number, editedBody?: string): Promise<void> {
    const { db } = this.ctx;
    const draft = db.getDraft(draftId);
    if (!draft || draft.status !== "pending") throw new Error("This draft is no longer waiting for approval");
    const body = editedBody?.trim() || draft.body;
    const customer = db.upsertCustomer(draft.to_phone, null);
    // An edited quote no longer matches the Zoho estimate, so it goes as the edited text.
    if (draft.kind === "quote" && draft.enquiry_id && body === draft.body) await this.sendQuote(customer, draft.enquiry_id, body);
    else await this.send(customer, draft.enquiry_id, body);
    db.setDraft(draft.id, "sent", body);
    if (draft.kind === "quote" && draft.enquiry_id) await this.quoteSent(draft.enquiry_id);
    db.addActivity(draft.enquiry_id, customer.id, "You", "Approved the quotation and sent it to the customer.");
  }

  rejectDraft(draftId: number): void {
    const { db } = this.ctx;
    const draft = db.getDraft(draftId);
    if (!draft || draft.status !== "pending") throw new Error("This draft is no longer waiting for approval");
    db.setDraft(draft.id, "rejected");
    if (draft.enquiry_id) db.setStatus(draft.enquiry_id, "needs_human", "Owner rejected the draft");
    db.addActivity(draft.enquiry_id, null, "You", "Rejected the quotation and took over the chat.");
  }

  /** Lets the agents handle a chat again after the owner took it over. */
  resume(enquiryId: number): void {
    const enquiry = this.ctx.db.getEnquiry(enquiryId);
    if (!enquiry) throw new Error("Enquiry not found");
    this.ctx.db.setStatus(enquiryId, enquiry.quote_ref ? "quoted" : "gathering", "");
    this.ctx.db.addActivity(enquiryId, enquiry.customer_id, "You", "Handed the chat back to the agents.");
  }

  /** Sends a message typed by the owner from the dashboard. */
  async sendManual(enquiryId: number, body: string): Promise<void> {
    const enquiry = this.ctx.db.getEnquiry(enquiryId);
    if (!enquiry) throw new Error("Enquiry not found");
    await this.send(this.ctx.db.getCustomer(enquiry.customer_id)!, enquiryId, body);
    this.ctx.db.addActivity(enquiryId, enquiry.customer_id, "You", "Sent a message from the dashboard.");
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
