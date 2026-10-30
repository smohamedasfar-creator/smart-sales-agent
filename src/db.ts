import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// The database is the agents' shared memory: every customer, message, enquiry,
// item, supplier request and draft reply is stored here.

export type EnquiryStatus =
  | "gathering" // still collecting what the customer needs
  | "checking" // matching items to the price list
  | "waiting_supplier" // asked a supplier, waiting for their prices
  | "awaiting_approval" // quote is ready, the owner has to approve it
  | "quoted" // quote sent to the customer
  | "won"
  | "lost"
  | "needs_human"; // agents handed the conversation to the owner

export const OPEN_STATUSES: EnquiryStatus[] = [
  "gathering",
  "checking",
  "waiting_supplier",
  "awaiting_approval",
  "quoted",
  "needs_human",
];

export interface Customer {
  id: number;
  phone: string;
  name: string | null;
  created_at: string;
  last_inbound_at: string | null;
}

export interface Message {
  id: number;
  customer_id: number;
  enquiry_id: number | null;
  direction: "in" | "out";
  body: string;
  created_at: string;
}

export interface Enquiry {
  id: number;
  customer_id: number;
  status: EnquiryStatus;
  notes: string | null;
  quote_ref: string | null;
  quote_total: number | null;
  zoho_estimate_id: string | null;
  quoted_at: string | null;
  followups_sent: number;
  created_at: string;
  updated_at: string;
}

export interface Item {
  id: number;
  enquiry_id: number;
  description: string;
  quantity: number;
  unit: string | null;
  sku: string | null;
  matched_name: string | null;
  category: string | null;
  source: "stock" | "supplier" | null;
  available: number | null; // 1 yes, 0 no, null unknown
  list_price: number | null;
  cost: number | null;
  unit_price: number | null;
  supplier_id: number | null;
}

export interface Supplier {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  categories: string; // comma separated, empty = everything
  active: number;
  last_inbound_at: string | null;
}

export interface SupplierRequest {
  id: number;
  enquiry_id: number;
  supplier_id: number;
  channel: "whatsapp" | "email";
  /** JSON array of the item ids this request asks about. */
  item_ids: string;
  status: "sent" | "answered" | "reminded" | "timeout";
  body: string;
  reply: string | null;
  sent_at: string;
  answered_at: string | null;
}

export interface Draft {
  id: number;
  enquiry_id: number | null;
  kind: "reply" | "quote" | "followup";
  to_phone: string;
  body: string;
  status: "pending" | "sent" | "rejected";
  created_at: string;
}

export interface Settings {
  businessName: string;
  businessInfo: string;
  currency: string;
  tone: string;
  requireApproval: boolean;
  margin: {
    /** Use the price list's selling price when it has one ("list"), or always cost plus margin ("cost"). */
    priceBasis: "list" | "cost";
    defaultPercent: number;
    byCategory: Record<string, number>;
    byCustomer: Record<string, number>;
    /** Round each unit price up to a multiple of this (0 = no rounding). */
    roundTo: number;
  };
  taxPercent: number;
  quoteValidityDays: number;
  /** Hours after the quote when each follow-up goes out. */
  followupHours: number[];
  supplierReminderHours: number;
  supplierGiveUpHours: number;
}

export const DEFAULT_SETTINGS: Settings = {
  businessName: "Our Company",
  businessInfo: "",
  currency: "AED",
  tone: "Friendly, short and professional. Use simple English.",
  requireApproval: true,
  margin: {
    priceBasis: "list",
    defaultPercent: 15,
    byCategory: {},
    byCustomer: {},
    roundTo: 0,
  },
  taxPercent: 0,
  quoteValidityDays: 7,
  followupHours: [24, 72],
  supplierReminderHours: 4,
  supplierGiveUpHours: 24,
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL,
  last_inbound_at TEXT
);
CREATE TABLE IF NOT EXISTS enquiries (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL,
  notes TEXT,
  quote_ref TEXT,
  quote_total REAL,
  zoho_estimate_id TEXT,
  quoted_at TEXT,
  followups_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  enquiry_id INTEGER REFERENCES enquiries(id),
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  wa_message_id TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  enquiry_id INTEGER NOT NULL REFERENCES enquiries(id),
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT,
  sku TEXT,
  matched_name TEXT,
  category TEXT,
  source TEXT,
  available INTEGER,
  list_price REAL,
  cost REAL,
  unit_price REAL,
  supplier_id INTEGER REFERENCES suppliers(id)
);
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  categories TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  last_inbound_at TEXT
);
CREATE TABLE IF NOT EXISTS supplier_requests (
  id INTEGER PRIMARY KEY,
  enquiry_id INTEGER NOT NULL REFERENCES enquiries(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  channel TEXT NOT NULL,
  item_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  reply TEXT,
  sent_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY,
  enquiry_id INTEGER REFERENCES enquiries(id),
  kind TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

export class Db {
  readonly sql: DatabaseSync;
  /** Overridable clock so tests can move time forward. */
  now: () => Date = () => new Date();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec("PRAGMA foreign_keys = ON;");
    this.sql.exec(SCHEMA);
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private get<T>(query: string, ...params: (string | number | null)[]): T | undefined {
    return this.sql.prepare(query).get(...params) as T | undefined;
  }

  private all<T>(query: string, ...params: (string | number | null)[]): T[] {
    return this.sql.prepare(query).all(...params) as T[];
  }

  private run(query: string, ...params: (string | number | null)[]): number {
    return Number(this.sql.prepare(query).run(...params).lastInsertRowid);
  }

  // Settings

  getSettings(): Settings {
    const row = this.get<{ value: string }>("SELECT value FROM settings WHERE key = 'settings'");
    if (!row) return structuredClone(DEFAULT_SETTINGS);
    const saved = JSON.parse(row.value) as Partial<Settings>;
    return {
      ...structuredClone(DEFAULT_SETTINGS),
      ...saved,
      margin: { ...DEFAULT_SETTINGS.margin, ...saved.margin },
    };
  }

  saveSettings(settings: Settings): void {
    this.run(
      "INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(settings),
    );
  }

  // Customers and messages

  upsertCustomer(phone: string, name: string | null): Customer {
    const existing = this.get<Customer>("SELECT * FROM customers WHERE phone = ?", phone);
    if (existing) {
      if (name && name !== existing.name) {
        this.run("UPDATE customers SET name = ? WHERE id = ?", name, existing.id);
        existing.name = name;
      }
      return existing;
    }
    const id = this.run("INSERT INTO customers (phone, name, created_at) VALUES (?, ?, ?)", phone, name, this.iso());
    return this.getCustomer(id)!;
  }

  getCustomer(id: number): Customer | undefined {
    return this.get<Customer>("SELECT * FROM customers WHERE id = ?", id);
  }

  /** Stores an incoming message. Returns false when WhatsApp delivered the same message twice. */
  addInbound(customerId: number, body: string, waMessageId: string | null): boolean {
    if (waMessageId && this.get("SELECT id FROM messages WHERE wa_message_id = ?", waMessageId)) return false;
    const at = this.iso();
    this.run(
      "INSERT INTO messages (customer_id, direction, body, wa_message_id, created_at) VALUES (?, 'in', ?, ?, ?)",
      customerId,
      body,
      waMessageId,
      at,
    );
    this.run("UPDATE customers SET last_inbound_at = ? WHERE id = ?", at, customerId);
    return true;
  }

  addOutbound(customerId: number, enquiryId: number | null, body: string): void {
    this.run(
      "INSERT INTO messages (customer_id, enquiry_id, direction, body, created_at) VALUES (?, ?, 'out', ?, ?)",
      customerId,
      enquiryId,
      body,
      this.iso(),
    );
  }

  /** Links the customer's messages that have no enquiry yet to this enquiry. */
  attachMessages(customerId: number, enquiryId: number): void {
    this.run("UPDATE messages SET enquiry_id = ? WHERE customer_id = ? AND enquiry_id IS NULL", enquiryId, customerId);
  }

  recentMessages(customerId: number, limit = 30): Message[] {
    return this.all<Message>(
      "SELECT * FROM (SELECT * FROM messages WHERE customer_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id",
      customerId,
      limit,
    );
  }

  enquiryMessages(enquiryId: number): Message[] {
    return this.all<Message>("SELECT * FROM messages WHERE enquiry_id = ? ORDER BY id", enquiryId);
  }

  // Enquiries

  createEnquiry(customerId: number): Enquiry {
    const at = this.iso();
    const id = this.run(
      "INSERT INTO enquiries (customer_id, status, created_at, updated_at) VALUES (?, 'gathering', ?, ?)",
      customerId,
      at,
      at,
    );
    return this.getEnquiry(id)!;
  }

  getEnquiry(id: number): Enquiry | undefined {
    return this.get<Enquiry>("SELECT * FROM enquiries WHERE id = ?", id);
  }

  openEnquiry(customerId: number): Enquiry | undefined {
    const placeholders = OPEN_STATUSES.map(() => "?").join(", ");
    return this.get<Enquiry>(
      `SELECT * FROM enquiries WHERE customer_id = ? AND status IN (${placeholders}) ORDER BY id DESC LIMIT 1`,
      customerId,
      ...OPEN_STATUSES,
    );
  }

  setStatus(enquiryId: number, status: EnquiryStatus, notes?: string): void {
    if (notes === undefined) {
      this.run("UPDATE enquiries SET status = ?, updated_at = ? WHERE id = ?", status, this.iso(), enquiryId);
    } else {
      this.run(
        "UPDATE enquiries SET status = ?, notes = ?, updated_at = ? WHERE id = ?",
        status,
        notes,
        this.iso(),
        enquiryId,
      );
    }
  }

  markQuoted(enquiryId: number): void {
    const at = this.iso();
    this.run(
      "UPDATE enquiries SET status = 'quoted', quoted_at = ?, followups_sent = 0, updated_at = ? WHERE id = ?",
      at,
      at,
      enquiryId,
    );
  }

  setQuote(enquiryId: number, ref: string, total: number, zohoEstimateId: string | null): void {
    this.run(
      "UPDATE enquiries SET quote_ref = ?, quote_total = ?, zoho_estimate_id = ? WHERE id = ?",
      ref,
      total,
      zohoEstimateId,
      enquiryId,
    );
  }

  countFollowup(enquiryId: number): void {
    this.run("UPDATE enquiries SET followups_sent = followups_sent + 1, updated_at = ? WHERE id = ?", this.iso(), enquiryId);
  }

  enquiriesByStatus(status: EnquiryStatus): Enquiry[] {
    return this.all<Enquiry>("SELECT * FROM enquiries WHERE status = ? ORDER BY id", status);
  }

  listEnquiries(limit = 100): (Enquiry & { phone: string; name: string | null })[] {
    return this.all(
      "SELECT e.*, c.phone, c.name FROM enquiries e JOIN customers c ON c.id = e.customer_id ORDER BY e.updated_at DESC LIMIT ?",
      limit,
    );
  }

  nextQuoteNumber(): string {
    const row = this.get<{ n: number }>("SELECT COUNT(*) AS n FROM enquiries WHERE quote_ref IS NOT NULL");
    return `Q-${String((row?.n ?? 0) + 1).padStart(5, "0")}`;
  }

  // Items

  replaceItems(
    enquiryId: number,
    items: { description: string; quantity: number; unit: string | null }[],
  ): void {
    this.run("DELETE FROM items WHERE enquiry_id = ?", enquiryId);
    for (const item of items) {
      this.run(
        "INSERT INTO items (enquiry_id, description, quantity, unit) VALUES (?, ?, ?, ?)",
        enquiryId,
        item.description,
        item.quantity,
        item.unit,
      );
    }
  }

  getItem(id: number): Item | undefined {
    return this.get<Item>("SELECT * FROM items WHERE id = ?", id);
  }

  items(enquiryId: number): Item[] {
    return this.all<Item>("SELECT * FROM items WHERE enquiry_id = ? ORDER BY id", enquiryId);
  }

  updateItem(id: number, fields: Partial<Omit<Item, "id" | "enquiry_id">>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length === 0) return;
    const assignments = keys.map((key) => `${key} = ?`).join(", ");
    const values = keys.map((key) => (fields[key] ?? null) as string | number | null);
    this.run(`UPDATE items SET ${assignments} WHERE id = ?`, ...values, id);
  }

  // Suppliers

  addSupplier(supplier: Omit<Supplier, "id" | "active" | "last_inbound_at">): Supplier {
    const id = this.run(
      "INSERT INTO suppliers (name, phone, email, categories) VALUES (?, ?, ?, ?)",
      supplier.name,
      supplier.phone,
      supplier.email,
      supplier.categories,
    );
    return this.get<Supplier>("SELECT * FROM suppliers WHERE id = ?", id)!;
  }

  updateSupplier(id: number, supplier: Omit<Supplier, "id" | "last_inbound_at">): void {
    this.run(
      "UPDATE suppliers SET name = ?, phone = ?, email = ?, categories = ?, active = ? WHERE id = ?",
      supplier.name,
      supplier.phone,
      supplier.email,
      supplier.categories,
      supplier.active,
      id,
    );
  }

  suppliers(activeOnly = true): Supplier[] {
    return this.all<Supplier>(activeOnly ? "SELECT * FROM suppliers WHERE active = 1 ORDER BY id" : "SELECT * FROM suppliers ORDER BY id");
  }

  getSupplier(id: number): Supplier | undefined {
    return this.get<Supplier>("SELECT * FROM suppliers WHERE id = ?", id);
  }

  supplierByPhone(phone: string): Supplier | undefined {
    return this.get<Supplier>("SELECT * FROM suppliers WHERE phone = ? AND active = 1", phone);
  }

  supplierMessaged(id: number): void {
    this.run("UPDATE suppliers SET last_inbound_at = ? WHERE id = ?", this.iso(), id);
  }

  supplierByEmail(email: string): Supplier | undefined {
    return this.get<Supplier>("SELECT * FROM suppliers WHERE lower(email) = lower(?) AND active = 1", email);
  }

  addSupplierRequest(
    request: Pick<SupplierRequest, "enquiry_id" | "supplier_id" | "channel" | "body"> & { itemIds: number[] },
  ): SupplierRequest {
    const id = this.run(
      "INSERT INTO supplier_requests (enquiry_id, supplier_id, channel, item_ids, status, body, sent_at) VALUES (?, ?, ?, ?, 'sent', ?, ?)",
      request.enquiry_id,
      request.supplier_id,
      request.channel,
      JSON.stringify(request.itemIds),
      request.body,
      this.iso(),
    );
    return this.get<SupplierRequest>("SELECT * FROM supplier_requests WHERE id = ?", id)!;
  }

  openSupplierRequests(supplierId?: number): SupplierRequest[] {
    if (supplierId === undefined) {
      return this.all<SupplierRequest>("SELECT * FROM supplier_requests WHERE status IN ('sent', 'reminded') ORDER BY id");
    }
    return this.all<SupplierRequest>(
      "SELECT * FROM supplier_requests WHERE supplier_id = ? AND status IN ('sent', 'reminded') ORDER BY id",
      supplierId,
    );
  }

  supplierRequests(enquiryId: number): SupplierRequest[] {
    return this.all<SupplierRequest>("SELECT * FROM supplier_requests WHERE enquiry_id = ? ORDER BY id", enquiryId);
  }

  setSupplierRequestStatus(id: number, status: SupplierRequest["status"], reply?: string): void {
    if (status === "answered") {
      this.run(
        "UPDATE supplier_requests SET status = 'answered', reply = ?, answered_at = ? WHERE id = ?",
        reply ?? null,
        this.iso(),
        id,
      );
    } else {
      this.run("UPDATE supplier_requests SET status = ? WHERE id = ?", status, id);
    }
  }

  // Drafts waiting for the owner's approval

  addDraft(draft: Pick<Draft, "enquiry_id" | "kind" | "to_phone" | "body">): Draft {
    const id = this.run(
      "INSERT INTO drafts (enquiry_id, kind, to_phone, body, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
      draft.enquiry_id,
      draft.kind,
      draft.to_phone,
      draft.body,
      this.iso(),
    );
    return this.getDraft(id)!;
  }

  getDraft(id: number): Draft | undefined {
    return this.get<Draft>("SELECT * FROM drafts WHERE id = ?", id);
  }

  pendingDrafts(): Draft[] {
    return this.all<Draft>("SELECT * FROM drafts WHERE status = 'pending' ORDER BY id");
  }

  setDraft(id: number, status: Draft["status"], body?: string): void {
    if (body === undefined) this.run("UPDATE drafts SET status = ? WHERE id = ?", status, id);
    else this.run("UPDATE drafts SET status = ?, body = ? WHERE id = ?", status, body, id);
  }
}
