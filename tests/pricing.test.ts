import { describe, expect, it } from "vitest";
import { marginPercent, priceItems, unitPrice } from "../src/agents/pricing.js";
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
    source: "stock",
    available: 1,
    list_price: null,
    cost: null,
    unit_price: null,
    supplier_id: null,
    ...fields,
  };
}

function settings(margin: Partial<Settings["margin"]> = {}, rest: Partial<Settings> = {}): Settings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...rest, margin: { ...DEFAULT_SETTINGS.margin, ...margin } };
}

describe("margins", () => {
  it("uses the customer's margin first, then the category's, then the default", () => {
    const s = settings({ defaultPercent: 15, byCategory: { Pipes: 10 }, byCustomer: { "971500": 5 } });
    expect(marginPercent(s, "971500", "Pipes")).toBe(5);
    expect(marginPercent(s, "971999", "pipes")).toBe(10);
    expect(marginPercent(s, "971999", "Fittings")).toBe(15);
  });

  it("uses the list price for stock items when the basis is the list", () => {
    expect(unitPrice(item({ list_price: 12.5, cost: 9 }), settings(), "1")).toBe(12.5);
  });

  it("adds the margin to cost when the basis is cost", () => {
    expect(unitPrice(item({ list_price: 12.5, cost: 10 }), settings({ priceBasis: "cost", defaultPercent: 20 }), "1")).toBe(12);
  });

  it("always prices supplier items from cost", () => {
    expect(unitPrice(item({ source: "supplier", cost: 3.5, list_price: 9 }), settings(), "1")).toBe(4.03);
  });

  it("rounds up to the chosen step", () => {
    const s = settings({ priceBasis: "cost", defaultPercent: 15, roundTo: 0.25 });
    expect(unitPrice(item({ cost: 3.5 }), s, "1")).toBe(4.25);
    expect(unitPrice(item({ cost: 10 }), settings({ priceBasis: "cost", defaultPercent: 20, roundTo: 0.5 }), "1")).toBe(12);
  });

  it("does not price unavailable items or items without any price", () => {
    expect(unitPrice(item({ available: 0, list_price: 5 }), settings(), "1")).toBeNull();
    expect(unitPrice(item({}), settings(), "1")).toBeNull();
  });
});

describe("quote totals", () => {
  it("adds up lines and tax and lists what could not be priced", () => {
    const quote = priceItems(
      [
        item({ id: 1, quantity: 3, list_price: 10 }),
        item({ id: 2, quantity: 2, source: "supplier", cost: 5 }),
        item({ id: 3, description: "rare part", available: 0 }),
      ],
      settings({ defaultPercent: 10 }, { taxPercent: 5 }),
      "1",
    );
    expect(quote.lines.map((l) => l.lineTotal)).toEqual([30, 11]);
    expect(quote.subtotal).toBe(41);
    expect(quote.tax).toBe(2.05);
    expect(quote.total).toBe(43.05);
    expect(quote.unavailable.map((i) => i.description)).toEqual(["rare part"]);
  });
});
