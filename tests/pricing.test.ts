import { describe, expect, it } from "vitest";
import { buyerFor, marginFor, priceDetail, priceItems, unitPrice, type Buyer } from "../src/agents/pricing.js";
import { DEFAULT_SETTINGS, type Item, type Settings } from "../src/db.js";

function item(fields: Partial<Item>): Item {
  return {
    id: 1,
    enquiry_id: 1,
    description: "thing",
    quantity: 1,
    unit: "pcs",
    sku: null,
    matched_name: null,
    category: null,
    brand: null,
    source: "stock",
    available: 1,
    list_price: null,
    reseller_price: null,
    margin_customer: null,
    margin_reseller: null,
    remark: null,
    cost: null,
    unit_price: null,
    supplier_id: null,
    ...fields,
  };
}

function settings(margin: Partial<Settings["margin"]> = {}, rest: Partial<Settings> = {}): Settings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...rest, margin: { ...DEFAULT_SETTINGS.margin, ...margin } };
}

const best: Buyer = { phone: "1", type: "customer", level: 1 };

describe("margins", () => {
  it("uses the customer's margin, then the item's, the category's, the brand's, then the default", () => {
    const s = settings({ defaultPercent: 15, byCategory: { Pipes: 10 }, byBrand: { Cosmoplast: 12 }, byCustomer: { "971500": 5 } });
    const pipe = { category: "pipes", brand: "Cosmoplast", margin_customer: null, margin_reseller: null };
    expect(marginFor(s, { ...best, phone: "971500" }, pipe).percent).toBe(5);
    expect(marginFor(s, best, { ...pipe, margin_customer: 100 }).percent).toBe(100);
    expect(marginFor(s, best, pipe).percent).toBe(10);
    expect(marginFor(s, best, { ...pipe, category: "Fittings" }).percent).toBe(12);
    expect(marginFor(s, best, { ...pipe, category: "Fittings", brand: null }).percent).toBe(15);
  });

  it("gives resellers the reseller margin and price", () => {
    const reseller: Buyer = { ...best, type: "reseller" };
    expect(marginFor(settings(), reseller, { category: null, brand: null, margin_customer: 75, margin_reseller: 15 }).percent).toBe(15);
    expect(unitPrice(item({ list_price: 98, reseller_price: 64.4 }), settings(), reseller)).toBe(64.4);
    expect(unitPrice(item({ list_price: 98, reseller_price: 64.4 }), settings(), best)).toBe(98);
  });

  it("uses the list price for stock items when the basis is the list", () => {
    expect(unitPrice(item({ list_price: 12.5, cost: 9 }), settings(), best)).toBe(12.5);
  });

  it("adds the margin to cost when the basis is cost", () => {
    expect(unitPrice(item({ list_price: 12.5, cost: 10 }), settings({ priceBasis: "cost", defaultPercent: 20 }), best)).toBe(12);
  });

  it("always prices supplier items from cost", () => {
    expect(unitPrice(item({ source: "supplier", cost: 3.5, list_price: 9 }), settings(), best)).toBe(4.03);
  });

  it("rounds up to the chosen step", () => {
    const s = settings({ priceBasis: "cost", defaultPercent: 15, roundTo: 0.25 });
    expect(unitPrice(item({ cost: 3.5 }), s, best)).toBe(4.25);
    expect(unitPrice(item({ cost: 10 }), settings({ priceBasis: "cost", defaultPercent: 20, roundTo: 0.5 }), best)).toBe(12);
  });

  it("does not price unavailable items or items without any price", () => {
    expect(unitPrice(item({ available: 0, list_price: 5 }), settings(), best)).toBeNull();
    expect(unitPrice(item({}), settings(), best)).toBeNull();
  });
});

describe("customer levels", () => {
  const switchItem = item({ list_price: 85.5, category: "SWITCH" });

  it("adds the level's percentage, or the category's own figure, to the best price", () => {
    const s = settings({}, { levelByCategory: { switch: { "2": 3 } } });
    expect(unitPrice(switchItem, s, { ...best, level: 2 })).toBe(88.07);
    expect(unitPrice(switchItem, s, { ...best, level: 3 })).toBe(93.2);
    expect(priceDetail(switchItem, s, { ...best, level: 2 })!.how).toContain("Level 2 +3% (SWITCH rate)");
  });

  it("gives a new customer's first order the first-order level, then their own level", () => {
    const s = settings();
    const customer = { phone: "1", type: "customer" as const, level: null };
    expect(buyerFor(s, customer, false)).toMatchObject({ level: 1, firstOrder: true });
    expect(buyerFor(s, customer, true)).toMatchObject({ level: 3, firstOrder: false });
    expect(buyerFor({ ...s, firstOrderOffer: false }, customer, false).level).toBe(3);
    expect(buyerFor(s, { ...customer, level: 2 }, true).level).toBe(2);
  });
});

describe("quote totals", () => {
  it("adds up lines and tax and lists what could not be priced", () => {
    const quote = priceItems(
      [
        item({ id: 1, quantity: 3, list_price: 10 }),
        item({ id: 2, quantity: 2, source: "supplier", cost: 5, brand: "Pegler" }),
        item({ id: 3, description: "rare part", available: 0 }),
      ],
      settings({ defaultPercent: 10 }, { taxPercent: 5 }),
      best,
    );
    expect(quote.lines.map((l) => l.lineTotal)).toEqual([30, 11]);
    expect(quote.lines.map((l) => l.brand)).toEqual(["No brand", "Pegler"]);
    expect(quote.subtotal).toBe(41);
    expect(quote.tax).toBe(2.05);
    expect(quote.total).toBe(43.05);
    expect(quote.unavailable.map((i) => i.description)).toEqual(["rare part"]);
  });
});
