import { describe, expect, it } from "vitest";
import type { CatalogItem } from "../src/catalog/catalog.js";
import type { LlmRequest } from "../src/llm.js";
import { setup } from "./helpers.js";

const CUSTOMER = "971501111111";
const SUPPLIER = "971502222222";
const OWNER = "971500000099";

let messageId = 0;
const fromCustomer = (text: string) => ({ id: `wamid.${++messageId}`, from: CUSTOMER, name: "Ali", text });

/** The price checker's fake: matches by keyword, like Claude would pick from the candidates. */
function matchByKeyword(request: LlmRequest) {
  const matches = [...request.prompt.matchAll(/Item (\d+): (.*)/g)].map(([, id, line]) => ({
    item_id: Number(id),
    sku: /pipe/i.test(line) ? "PVC-110" : /elbow/i.test(line) ? "ELB-110" : null,
  }));
  return { matches };
}

function pipesAndElbows() {
  return {
    items: [
      { description: "PVC pipe 4 inch", quantity: 50, unit: "pcs" },
      { description: "PVC elbow 4 inch", quantity: 20, unit: "pcs" },
    ],
    missing_questions: [],
  };
}

describe("enquiry to order", () => {
  it("asks a supplier for missing stock, quotes after approval, and records the order", async () => {
    const t = setup();
    t.db.addSupplier({ name: "Gulf Fittings", phone: SUPPLIER, email: null, categories: "" });
    t.llm.handlers.coordinator = () => ({ intent: "new_enquiry" });
    t.llm.handlers.gatherer = pipesAndElbows;
    t.llm.handlers["price-checker"] = matchByKeyword;

    await t.coordinator.onWhatsApp(fromCustomer("Hi, need 50 pcs 4 inch PVC pipe and 20 elbows 4 inch, price?"));

    // Only 5 elbows in stock, so the supplier is asked; the customer only hears that the quote is being prepared.
    const enquiry = t.db.openEnquiry(1)!;
    expect(enquiry.status).toBe("waiting_supplier");
    const toSupplier = t.whatsapp.sent.find((m) => m.to === SUPPLIER)!;
    expect(toSupplier.body).toContain("20 pcs PVC elbow 4 inch");
    expect(toSupplier.body).not.toContain("pipe");
    const toCustomer = t.whatsapp.sent.filter((m) => m.to === CUSTOMER);
    expect(toCustomer.some((m) => m.body.includes("preparing their quotation"))).toBe(true);
    expect(toCustomer.some((m) => /confirming|availability/.test(m.body.split("Do not mention")[0]))).toBe(false);

    // The supplier answers; the quote is drafted and waits for the owner.
    const elbowId = t.db.items(enquiry.id).find((i) => i.description.includes("elbow"))!.id;
    t.llm.handlers.supplier = () => ({
      answered: true,
      quotes: [{ item_id: elbowId, available: true, unit_cost: 3.5, note: "" }],
    });
    await t.coordinator.onWhatsApp({ id: "wamid.s1", from: SUPPLIER, name: null, text: "Elbow 4in available, 3.50 each" });

    expect(t.db.getEnquiry(enquiry.id)!.status).toBe("awaiting_approval");
    const [draft] = t.db.pendingDrafts();
    // Pipe from the price list at 12.50; elbow from the supplier at 3.50 + 15% = 4.025, rounded to 4.03.
    expect(draft.body).toContain("50 pcs x AED 12.50 = AED 625.00");
    expect(draft.body).toContain("20 pcs x AED 4.03 = AED 80.60");
    expect(draft.body).toContain("*Total: AED 705.60*");
    expect(t.whatsapp.sent.some((m) => m.to === OWNER && m.body.includes("waiting for your approval"))).toBe(true);
    expect(t.whatsapp.sent.some((m) => m.to === CUSTOMER && m.body.includes("Quotation"))).toBe(false);

    // The owner approves; the quote goes to the customer.
    await t.coordinator.approveDraft(draft.id);
    expect(t.db.getEnquiry(enquiry.id)!.status).toBe("quoted");
    expect(t.whatsapp.sent.at(-1)).toEqual({ to: CUSTOMER, body: draft.body });

    // The customer says yes.
    t.llm.handlers.coordinator = () => ({ intent: "accept_quote" });
    await t.coordinator.onWhatsApp(fromCustomer("Yes please go ahead"));
    expect(t.db.getEnquiry(enquiry.id)!.status).toBe("won");
    expect(t.whatsapp.sent.some((m) => m.to === OWNER && m.body.startsWith("Order confirmed"))).toBe(true);
  });

  it("sends the quote straight away when approval is off and everything is in stock", async () => {
    const t = setup();
    t.db.saveSettings({ ...t.db.getSettings(), requireApproval: false, taxPercent: 5 });
    t.llm.handlers.coordinator = () => ({ intent: "new_enquiry" });
    t.llm.handlers.gatherer = () => ({ items: [{ description: "PVC pipe 4 inch", quantity: 10, unit: "pcs" }], missing_questions: [] });
    t.llm.handlers["price-checker"] = matchByKeyword;

    await t.coordinator.onWhatsApp(fromCustomer("10 pipes 4 inch please"));

    const quote = t.whatsapp.sent.find((m) => m.to === CUSTOMER)!.body;
    expect(quote).toContain("Subtotal: AED 125.00");
    expect(quote).toContain("VAT 5%: AED 6.25");
    expect(quote).toContain("*Total: AED 131.25*");
    expect(t.db.openEnquiry(1)!.status).toBe("quoted");
  });

  it("asks the customer for missing details before pricing", async () => {
    const t = setup();
    t.llm.handlers.coordinator = () => ({ intent: "new_enquiry" });
    t.llm.handlers.gatherer = () => ({
      items: [{ description: "PVC pipe", quantity: 50, unit: "pcs" }],
      missing_questions: ["Which size do you need?"],
    });

    await t.coordinator.onWhatsApp(fromCustomer("price for 50 pvc pipes"));

    expect(t.db.openEnquiry(1)!.status).toBe("gathering");
    const reception = t.llm.calls.find((c) => c.agent === "reception")!;
    expect(reception.prompt).toContain("Which size do you need?");
    expect(t.llm.calls.some((c) => c.agent === "price-checker")).toBe(false);
  });

  it("follows up on an unanswered quote, using the template after 24 hours", async () => {
    const t = setup({ followupTemplate: "quote_followup" });
    t.db.saveSettings({ ...t.db.getSettings(), requireApproval: false, followupHours: [20, 48] });
    t.llm.handlers.coordinator = () => ({ intent: "new_enquiry" });
    t.llm.handlers.gatherer = () => ({ items: [{ description: "PVC pipe 4 inch", quantity: 10, unit: "pcs" }], missing_questions: [] });
    t.llm.handlers["price-checker"] = matchByKeyword;
    await t.coordinator.onWhatsApp(fromCustomer("10 pipes 4 inch please"));

    t.advanceHours(10);
    await t.coordinator.tick();
    expect(t.whatsapp.sent.filter((m) => m.body === "Just checking in on our quotation.")).toHaveLength(0);

    t.advanceHours(11); // 21 hours: inside the 24-hour window, so a normal message
    await t.coordinator.tick();
    expect(t.whatsapp.sent.filter((m) => m.body === "Just checking in on our quotation.")).toHaveLength(1);

    t.advanceHours(28); // 49 hours: only a template is allowed now
    await t.coordinator.tick();
    expect(t.whatsapp.templates).toEqual([{ to: CUSTOMER, name: "quote_followup", params: ["Ali", "Q-00001"] }]);

    t.advanceHours(100); // no third follow-up is configured
    await t.coordinator.tick();
    expect(t.whatsapp.templates).toHaveLength(1);
  });

  it("holds a quote for the owner when a supplier price looks wrong, even with approval off", async () => {
    const t = setup();
    t.db.saveSettings({ ...t.db.getSettings(), requireApproval: false });
    t.db.addSupplier({ name: "Gulf Fittings", phone: SUPPLIER, email: null, categories: "" });
    t.llm.handlers.coordinator = () => ({ intent: "new_enquiry" });
    t.llm.handlers.gatherer = pipesAndElbows;
    t.llm.handlers["price-checker"] = matchByKeyword;
    await t.coordinator.onWhatsApp(fromCustomer("50 pipes and 20 elbows, 4 inch"));

    // The elbow lists at 3.20; a reply of 0.05 each is far too low to trust.
    const elbowId = t.db.items(1).find((i) => i.description.includes("elbow"))!.id;
    t.llm.handlers.supplier = () => ({ answered: true, quotes: [{ item_id: elbowId, available: true, unit_cost: 0.05, note: "" }] });
    await t.coordinator.onWhatsApp({ id: "wamid.s9", from: SUPPLIER, name: null, text: "elbow 0.05 each" });

    expect(t.db.getEnquiry(1)!.status).toBe("awaiting_approval");
    expect(t.db.getEnquiry(1)!.notes).toContain("far from the price list");
    expect(t.whatsapp.sent.filter((m) => m.to === CUSTOMER).some((m) => m.body.includes("Quotation"))).toBe(false);
    expect(t.whatsapp.sent.find((m) => m.to === OWNER)!.body).toContain("Please check");
  });

  it("stops waiting for a silent supplier and quotes what is available", async () => {
    const t = setup();
    t.db.saveSettings({ ...t.db.getSettings(), requireApproval: false });
    t.db.addSupplier({ name: "Slow Trading", phone: null, email: "sales@slow.example", categories: "" });
    t.llm.handlers.coordinator = () => ({ intent: "new_enquiry" });
    t.llm.handlers.gatherer = pipesAndElbows;
    t.llm.handlers["price-checker"] = matchByKeyword;
    await t.coordinator.onWhatsApp(fromCustomer("50 pipes and 20 elbows, 4 inch"));
    expect(t.mailer.sent).toHaveLength(1);

    t.advanceHours(5);
    await t.coordinator.tick();
    expect(t.mailer.sent.map((m) => m.subject)).toEqual(["Price enquiry E1 - Our Company", "Reminder: price enquiry E1"]);

    t.advanceHours(20);
    await t.coordinator.tick();
    const quote = t.whatsapp.sent.filter((m) => m.to === CUSTOMER).at(-1)!.body;
    expect(quote).toContain("*Total: AED 625.00*");
    expect(quote).toContain("Not available at the moment:\n- PVC elbow 4 inch");
  });

  it("reads a supplier's email reply", async () => {
    const t = setup();
    t.db.addSupplier({ name: "Mail Supplier", phone: null, email: "quotes@supplier.example", categories: "" });
    t.llm.handlers.coordinator = () => ({ intent: "new_enquiry" });
    t.llm.handlers.gatherer = pipesAndElbows;
    t.llm.handlers["price-checker"] = matchByKeyword;
    await t.coordinator.onWhatsApp(fromCustomer("50 pipes and 20 elbows, 4 inch"));

    const elbowId = t.db.items(1).find((i) => i.description.includes("elbow"))!.id;
    t.llm.handlers.supplier = () => ({ answered: true, quotes: [{ item_id: elbowId, available: true, unit_cost: 3, note: "" }] });
    t.mailer.inbox.push({ from: "Quotes@Supplier.example", subject: "Re: Price enquiry E1", text: "Elbows 3.00 each" });
    await t.coordinator.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(t.db.getEnquiry(1)!.status).toBe("awaiting_approval");
    expect(t.db.pendingDrafts()[0].body).toContain("20 pcs x AED 3.45");
  });

  it("hands the chat to the owner when the customer asks for a person, then stays quiet", async () => {
    const t = setup();
    t.llm.handlers.coordinator = () => ({ intent: "human_request" });
    await t.coordinator.onWhatsApp(fromCustomer("I want to talk to the manager"));
    expect(t.db.openEnquiry(1)!.status).toBe("needs_human");
    expect(t.whatsapp.sent.some((m) => m.to === OWNER)).toBe(true);

    const before = t.whatsapp.sent.length;
    await t.coordinator.onWhatsApp(fromCustomer("hello?"));
    expect(t.whatsapp.sent.length).toBe(before);
  });

  it("does not treat the owner as a customer", async () => {
    const t = setup();
    await t.coordinator.onWhatsApp({ id: "wamid.o1", from: OWNER, name: "Owner", text: "hi" });
    expect(t.llm.calls).toHaveLength(0);
    expect(t.db.listEnquiries()).toHaveLength(0);
  });

  it("never answers a personal contact and keeps them off the customer list", async () => {
    const t = setup();
    t.db.saveSettings({ ...t.db.getSettings(), personalContacts: [{ phone: "0501111111", name: "Ali (cousin)" }] });
    await t.coordinator.onWhatsApp(fromCustomer("Hi, are you coming for dinner tonight?"));
    expect(t.llm.calls).toHaveLength(0);
    expect(t.whatsapp.sent).toHaveLength(0);
    expect(t.db.listEnquiries()).toHaveLength(0);
    expect(t.logs.some((l) => l.includes("Personal message from Ali (cousin)"))).toBe(true);
  });

  it("stays quiet on a message that looks personal and tells the owner", async () => {
    const t = setup();
    t.llm.handlers.coordinator = () => ({ intent: "personal" });
    await t.coordinator.onWhatsApp(fromCustomer("Bro, happy birthday! Party at mine on Friday"));
    expect(t.whatsapp.sent.filter((m) => m.to === CUSTOMER)).toHaveLength(0);
    expect(t.db.listEnquiries()).toHaveLength(0);
    expect(t.whatsapp.sent.find((m) => m.to === OWNER)!.body).toContain("looks personal");

    // Once the owner marks them as personal, they leave the customer list.
    t.db.forgetCustomer(CUSTOMER);
    expect(t.db.recentMessages(1)).toHaveLength(0);
  });

  it("steps back from a chat when the owner replies from the WhatsApp Business app", async () => {
    const t = setup();
    t.llm.handlers.coordinator = () => ({ intent: "question" });
    await t.coordinator.onOwnerReply({ id: "wamid.e1", to: CUSTOMER, text: "Hi Ali, yes we have it. I'll send the price." });
    const enquiry = t.db.openEnquiry(1)!;
    expect(enquiry.status).toBe("needs_human");
    expect(t.db.enquiryMessages(enquiry.id).map((m) => m.body)).toContain("Hi Ali, yes we have it. I'll send the price.");

    await t.coordinator.onWhatsApp(fromCustomer("ok thanks, also delivery to Sharjah?"));
    expect(t.whatsapp.sent).toHaveLength(0);
    expect(t.llm.calls).toHaveLength(0);
  });

  it("ignores a message WhatsApp delivers twice", async () => {
    const t = setup();
    t.llm.handlers.coordinator = () => ({ intent: "other" });
    const message = fromCustomer("hi");
    await t.coordinator.onWhatsApp(message);
    await t.coordinator.onWhatsApp(message);
    expect(t.llm.calls.filter((c) => c.agent === "coordinator")).toHaveLength(1);
  });

  it("passes the chat to the owner when an agent fails", async () => {
    const t = setup();
    t.llm.handlers.coordinator = () => {
      throw new Error("API down");
    };
    await t.coordinator.onWhatsApp(fromCustomer("price for pipes"));
    const enquiry = t.db.openEnquiry(1)!;
    expect(enquiry.status).toBe("needs_human");
    expect(enquiry.notes).toContain("API down");
  });
});

describe("brands, levels and new customers", () => {
  const BRANDED: CatalogItem[] = [
    { sku: "COS-P110", name: 'PVC Pipe 4" 6m', brand: "Cosmoplast", category: "Pipes", unit: "pcs", price: 12.5, cost: 9, stock: 200 },
    { sku: "COS-P160", name: 'PVC Pipe 6" 6m', brand: "Cosmoplast", category: "Pipes", unit: "pcs", price: 24, cost: 18, stock: 40 },
    { sku: "COS-E110", name: 'PVC Elbow 4"', brand: "Cosmoplast", category: "Fittings", unit: "pcs", price: 3.2, cost: 2.1, stock: 5 },
    { sku: "PEG-BV025", name: 'Ball Valve Brass 1"', brand: "Pegler", category: "Valves", unit: "pcs", price: 28, cost: 19, stock: 0 },
  ];
  const VALVES = "971503333333";
  const ANY = "971504444444";

  function matchBranded(request: LlmRequest) {
    const matches = [...request.prompt.matchAll(/Item (\d+): (.*)/g)].map(([, id, line]) => ({
      item_id: Number(id),
      sku: /pipe/i.test(line) ? "COS-P110" : /elbow/i.test(line) ? "COS-E110" : /valve/i.test(line) ? "PEG-BV025" : null,
    }));
    return { matches };
  }

  it("asks each brand's own suppliers, groups the quote by brand and makes one order per brand", async () => {
    const t = setup({ catalog: BRANDED });
    t.db.addSupplier({ name: "Gulf Pipes", phone: SUPPLIER, email: null, categories: "", brands: "Cosmoplast" });
    t.db.addSupplier({ name: "Emirates Valves", phone: VALVES, email: null, categories: "", brands: "Pegler" });
    t.db.addSupplier({ name: "Any Brand Trading", phone: ANY, email: null, categories: "" });
    t.llm.handlers.coordinator = () => ({ intent: "new_enquiry" });
    t.llm.handlers.gatherer = () => ({
      items: [
        { description: "PVC pipe 4 inch", quantity: 50, unit: "pcs" },
        { description: "PVC elbow 4 inch", quantity: 20, unit: "pcs" },
        { description: "Pegler ball valve 1 inch", quantity: 2, unit: "pcs" },
      ],
      missing_questions: [],
    });
    t.llm.handlers["price-checker"] = matchBranded;
    await t.coordinator.onWhatsApp(fromCustomer("50 pipes, 20 elbows 4 inch and 2 Pegler ball valves 1 inch"));

    const to = (phone: string) => t.whatsapp.sent.filter((m) => m.to === phone).map((m) => m.body).join("\n");
    expect(to(SUPPLIER)).toContain("for Cosmoplast");
    expect(to(SUPPLIER)).toContain("20 pcs PVC elbow 4 inch");
    expect(to(SUPPLIER)).not.toContain("valve");
    expect(to(VALVES)).toContain("2 pcs Pegler ball valve 1 inch");
    expect(to(ANY)).toBe("");

    const [elbow, valve] = [t.db.items(1)[1].id, t.db.items(1)[2].id];
    t.llm.handlers.supplier = (request) => ({
      answered: true,
      quotes: request.prompt.includes("elbow")
        ? [{ item_id: elbow, available: true, unit_cost: 2.3, note: "" }]
        : [{ item_id: valve, available: true, unit_cost: 21.5, note: "" }],
    });
    await t.coordinator.onWhatsApp({ id: "wamid.s1", from: SUPPLIER, name: null, text: "elbow 2.30" });
    await t.coordinator.onWhatsApp({ id: "wamid.s2", from: VALVES, name: null, text: "valve 21.50" });

    const [draft] = t.db.pendingDrafts();
    expect(draft.body).toMatch(/\*Cosmoplast\*\n1\. PVC Pipe 4" 6m[\s\S]*2\. PVC Elbow[\s\S]*\*Pegler\*\n3\. Ball Valve/);
    await t.coordinator.approveDraft(draft.id);

    t.llm.handlers.coordinator = () => ({ intent: "accept_quote" });
    await t.coordinator.onWhatsApp(fromCustomer("Yes, go ahead"));
    const orders = t.db.orders();
    expect(orders.map((o) => [o.brand, o.subtotal]).sort()).toEqual([
      ["Cosmoplast", 625 + 20 * 2.65],
      ["Pegler", 2 * 24.73],
    ]);
    expect(t.whatsapp.sent.find((m) => m.to === OWNER && m.body.startsWith("Order confirmed"))!.body).toContain("By brand: ");
  });

  it("prices a new customer's first order at Level 1, then their own level", async () => {
    const t = setup({ catalog: BRANDED });
    t.db.saveSettings({ ...t.db.getSettings(), requireApproval: false });
    t.llm.handlers.coordinator = () => ({ intent: "new_enquiry" });
    t.llm.handlers.gatherer = () => ({ items: [{ description: "PVC pipe 4 inch", quantity: 10, unit: "pcs" }], missing_questions: [] });
    t.llm.handlers["price-checker"] = matchBranded;

    await t.coordinator.onWhatsApp(fromCustomer("10 pipes 4 inch"));
    expect(t.whatsapp.sent.at(-1)!.body).toContain("10 pcs x AED 12.50");
    t.llm.handlers.coordinator = () => ({ intent: "accept_quote" });
    await t.coordinator.onWhatsApp(fromCustomer("ok confirm"));

    // Second order: Level 3 (new customers' level) is 9% more.
    t.llm.handlers.coordinator = () => ({ intent: "new_enquiry" });
    await t.coordinator.onWhatsApp(fromCustomer("10 more pipes please"));
    expect(t.whatsapp.sent.at(-1)!.body).toContain("10 pcs x AED 13.63");
    expect(t.db.getCustomer(1)!.level).toBe(3);
  });

  it("gets a new customer's name, company, emirate and TRN before the quote goes out", async () => {
    const t = setup({ catalog: BRANDED, requireDetails: true });
    t.llm.handlers.coordinator = () => ({ intent: "new_enquiry" });
    t.llm.handlers.gatherer = () => ({ items: [{ description: "PVC pipe 4 inch", quantity: 50, unit: "pcs" }], missing_questions: [] });
    t.llm.handlers["price-checker"] = matchBranded;
    const toCustomer = () => t.whatsapp.sent.filter((m) => m.to === CUSTOMER).map((m) => m.body);

    await t.coordinator.onWhatsApp(fromCustomer("Hi, price for 50 pipes 4 inch"));
    expect(t.db.getEnquiry(1)!.status).toBe("awaiting_details");
    // The name comes from the WhatsApp profile; the rest is asked for.
    expect(toCustomer().at(-1)).toContain("ask for their company name, emirate (location in the UAE) and TRN");
    expect(t.db.pendingDrafts()).toHaveLength(0);

    // Details with a TRN that is too short: asked again.
    t.llm.handlers.coordinator = () => ({ intent: "other" });
    t.llm.handlers.details = () => ({ name: "Ali", company: "Gulf Star Contracting", emirate: "sharjah", area: null, trn: "10034567890" });
    await t.coordinator.onWhatsApp(fromCustomer("Ali, Gulf Star Contracting, Sharjah, TRN 10034567890"));
    expect(t.db.getEnquiry(1)!.status).toBe("awaiting_details");
    expect(toCustomer().at(-1)).toContain("it should be 15 digits");

    t.llm.handlers.details = () => ({ name: null, company: null, emirate: null, area: null, trn: "100345678900003" });
    await t.coordinator.onWhatsApp(fromCustomer("Sorry, TRN is 100345678900003"));
    const customer = t.db.getCustomer(1)!;
    expect(customer).toMatchObject({ name: "Ali", company: "Gulf Star Contracting", emirate: "Sharjah", trn: "100345678900003", level: 3 });
    const [draft] = t.db.pendingDrafts();
    expect(draft.body).toContain("To: Ali, Gulf Star Contracting, Sharjah");
    expect(draft.body).toContain("Customer TRN: 100345678900003");
    expect(draft.body).toContain("50 pcs x AED 12.50"); // first order at Level 1
    expect(t.whatsapp.sent.some((m) => m.to === OWNER && m.body.startsWith("New customer: Ali, Gulf Star Contracting"))).toBe(true);
  });

  it("asks which model when the request fits several items in the stock list", async () => {
    const t = setup({ catalog: BRANDED });
    t.llm.handlers.coordinator = () => ({ intent: "new_enquiry" });
    t.llm.handlers.gatherer = () => ({ items: [{ description: "PVC pipe", quantity: 10, unit: "pcs" }], missing_questions: [] });
    t.llm.handlers.options = () => ({ questions: ["Which PVC pipe would you like? 1) 4 inch  2) 6 inch"] });
    await t.coordinator.onWhatsApp(fromCustomer("price for 10 pvc pipes"));
    expect(t.db.getEnquiry(1)!.status).toBe("gathering");
    expect(t.whatsapp.sent.at(-1)!.body).toContain("Ask these questions");
    expect(t.llm.calls.filter((c) => c.agent === "reception").at(-1)!.prompt).toContain("Which PVC pipe would you like? 1) 4 inch  2) 6 inch");
    // The gatherer saw both pipes from the stock list.
    expect(t.llm.calls.find((c) => c.agent === "options")!.prompt).toMatch(/PVC Pipe 4" 6m[\s\S]*PVC Pipe 6" 6m/);
  });
});
