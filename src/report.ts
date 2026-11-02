import ExcelJS from "exceljs";
import type { Db, EnquiryStatus } from "./db.js";

// The Excel report the owner downloads: every enquiry with its status, every item asked for,
// and every order, also split into one sheet per brand.

export const STATUS_TEXT: Record<EnquiryStatus, string> = {
  gathering: "1. Gathering - waiting for the customer's answer",
  checking: "2. Checking prices",
  waiting_supplier: "3. Asking suppliers",
  awaiting_details: "4. Waiting for the customer's details",
  awaiting_approval: "5. Waiting for your approval",
  quoted: "6. Quote sent - waiting for the customer's yes",
  won: "7. Order won",
  lost: "Lost / closed",
  needs_human: "With you (human handling)",
};

const ORDER_STATUS: Record<string, string> = {
  confirmed: "Confirmed",
  ordered: "Ordered from supplier",
  delivered: "Delivered",
  paid: "Paid",
};

interface Line {
  name?: string;
  quantity?: number;
  unit?: string | null;
  unitPrice?: number;
  lineTotal?: number;
}

const day = (iso: string | null) => (iso ? new Date(iso) : null);
const money = "#,##0.00";

function addSheet(workbook: ExcelJS.Workbook, name: string, columns: Partial<ExcelJS.Column>[]): ExcelJS.Worksheet {
  // Excel sheet names: at most 31 characters, none of : \ / ? * [ ]
  const safe = name.replace(/[:\\/?*[\]]/g, " ").slice(0, 31) || "Sheet";
  let unique = safe;
  for (let n = 2; workbook.getWorksheet(unique); n++) unique = `${safe.slice(0, 28)} ${n}`;
  const sheet = workbook.addWorksheet(unique, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return sheet;
}

function orderColumns(): Partial<ExcelJS.Column>[] {
  return [
    { header: "Order", key: "ref", width: 10 },
    { header: "Date", key: "date", width: 12, style: { numFmt: "dd-mmm-yyyy" } },
    { header: "Brand", key: "brand", width: 14 },
    { header: "Enquiry", key: "enquiry", width: 9 },
    { header: "Quote", key: "quote", width: 10 },
    { header: "Customer", key: "name", width: 20 },
    { header: "Company", key: "company", width: 24 },
    { header: "Phone", key: "phone", width: 15 },
    { header: "Items", key: "items", width: 50 },
    { header: "Before VAT (AED)", key: "subtotal", width: 16, style: { numFmt: money } },
    { header: "Status", key: "status", width: 20 },
  ];
}

export async function createReport(db: Db): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = db.now();

  const enquiries = addSheet(workbook, "Enquiries", [
    { header: "Enquiry", key: "id", width: 9 },
    { header: "Date", key: "date", width: 12, style: { numFmt: "dd-mmm-yyyy" } },
    { header: "Last update", key: "updated", width: 16, style: { numFmt: "dd-mmm-yyyy hh:mm" } },
    { header: "Customer", key: "name", width: 20 },
    { header: "Company", key: "company", width: 24 },
    { header: "Phone", key: "phone", width: 15 },
    { header: "Emirate", key: "emirate", width: 13 },
    { header: "TRN", key: "trn", width: 17 },
    { header: "Level", key: "level", width: 7 },
    { header: "Brands", key: "brands", width: 18 },
    { header: "Items asked", key: "items", width: 50 },
    { header: "Status", key: "status", width: 40 },
    { header: "Quote", key: "quote", width: 10 },
    { header: "Quote total (AED)", key: "total", width: 16, style: { numFmt: money } },
    { header: "Quote sent", key: "quoted", width: 12, style: { numFmt: "dd-mmm-yyyy" } },
    { header: "Zoho estimate", key: "zoho", width: 16 },
    { header: "Follow-ups", key: "followups", width: 10 },
    { header: "Notes", key: "notes", width: 40 },
  ]);
  const items = addSheet(workbook, "Items", [
    { header: "Enquiry", key: "enquiry", width: 9 },
    { header: "Date", key: "date", width: 12, style: { numFmt: "dd-mmm-yyyy" } },
    { header: "Customer", key: "customer", width: 24 },
    { header: "Asked for", key: "description", width: 34 },
    { header: "Matched item", key: "matched", width: 34 },
    { header: "SKU", key: "sku", width: 16 },
    { header: "Brand", key: "brand", width: 14 },
    { header: "Category", key: "category", width: 16 },
    { header: "Qty", key: "qty", width: 7 },
    { header: "From", key: "source", width: 10 },
    { header: "Supplier", key: "supplier", width: 18 },
    { header: "Cost", key: "cost", width: 11, style: { numFmt: money } },
    { header: "Our price", key: "price", width: 11, style: { numFmt: money } },
    { header: "Line total", key: "line", width: 12, style: { numFmt: money } },
    { header: "Enquiry status", key: "status", width: 40 },
  ]);

  const supplierName = new Map(db.suppliers(false).map((s) => [s.id, s.name]));
  for (const e of db.allEnquiries()) {
    const lines = db.items(e.id);
    const status = STATUS_TEXT[e.status] ?? e.status;
    const customer = [e.name, e.company].filter(Boolean).join(" - ") || `+${e.phone}`;
    enquiries.addRow({
      id: `E${e.id}`,
      date: day(e.created_at),
      updated: day(e.updated_at),
      name: e.name ?? "",
      company: e.company ?? "",
      phone: `+${e.phone}`,
      emirate: e.emirate ?? "",
      trn: e.trn ?? "",
      level: e.level ?? "",
      brands: [...new Set(lines.map((i) => i.brand).filter(Boolean))].join(", "),
      items: lines.map((i) => `${i.quantity} x ${i.matched_name || i.description}`).join("\n"),
      status,
      quote: e.quote_ref ?? "",
      total: e.quote_total ?? null,
      quoted: day(e.quoted_at),
      zoho: e.zoho_estimate_id ?? "",
      followups: e.followups_sent,
      notes: e.notes ?? "",
    }).alignment = { vertical: "top", wrapText: true };
    for (const i of lines) {
      items.addRow({
        enquiry: `E${e.id}`,
        date: day(e.created_at),
        customer,
        description: i.description,
        matched: i.matched_name ?? "",
        sku: i.sku ?? "",
        brand: i.brand ?? "",
        category: i.category ?? "",
        qty: i.quantity,
        source: i.source ?? "",
        supplier: i.supplier_id ? (supplierName.get(i.supplier_id) ?? "") : "",
        cost: i.cost,
        price: i.unit_price,
        line: i.unit_price == null ? null : i.unit_price * i.quantity,
        status,
      });
    }
  }

  const orders = db.orders();
  const orderRow = (o: (typeof orders)[number]) => ({
    ref: o.ref,
    date: day(o.created_at),
    brand: o.brand,
    enquiry: `E${o.enquiry_id}`,
    quote: o.quote_ref ?? "",
    name: o.name ?? "",
    company: o.company ?? "",
    phone: `+${o.phone}`,
    items: (JSON.parse(o.lines) as Line[]).map((l) => `${l.quantity ?? ""} x ${l.name ?? ""}`).join("\n"),
    subtotal: o.subtotal,
    status: ORDER_STATUS[o.status] ?? o.status,
  });
  const all = addSheet(workbook, "Orders", orderColumns());
  for (const o of orders) all.addRow(orderRow(o)).alignment = { vertical: "top", wrapText: true };
  for (const brand of [...new Set(orders.map((o) => o.brand))].sort()) {
    const sheet = addSheet(workbook, `Orders ${brand}`, orderColumns());
    const rows = orders.filter((o) => o.brand === brand);
    for (const o of rows) sheet.addRow(orderRow(o)).alignment = { vertical: "top", wrapText: true };
    const total = sheet.addRow({ items: "Total", subtotal: rows.reduce((sum, o) => sum + o.subtotal, 0) });
    total.font = { bold: true };
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
