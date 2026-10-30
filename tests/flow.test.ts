import { describe, expect, it } from "vitest";
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

    // Only 5 elbows in stock, so the supplier is asked and the customer is told we are checking.
    const enquiry = t.db.openEnquiry(1)!;
    expect(enquiry.status).toBe("waiting_supplier");
    const toSupplier = t.whatsapp.sent.find((m) => m.to === SUPPLIER)!;
    expect(toSupplier.body).toContain("20 pcs PVC elbow 4 inch");
    expect(toSupplier.body).not.toContain("pipe");
    expect(t.whatsapp.sent.some((m) => m.to === CUSTOMER && m.body.includes("confirming price and availability"))).toBe(true);

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
