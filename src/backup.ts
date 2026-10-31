import { DEFAULT_SETTINGS, samePhone, type Customer, type Db, type Settings } from "./db.js";

// A backup is one JSON file the owner keeps on their computer: settings, suppliers, and customers' details
// and levels. Restoring it after a reset (or on a new server) brings the setup back without retyping.

export interface Backup {
  app: "smart-sales-agent";
  version: 1;
  exported_at: string;
  settings: Settings;
  suppliers: { name: string; phone: string | null; email: string | null; categories: string; brands: string; active: number }[];
  customers: Pick<Customer, "phone" | "name" | "company" | "emirate" | "area" | "trn" | "level" | "type">[];
}

export function createBackup(db: Db): Backup {
  return {
    app: "smart-sales-agent",
    version: 1,
    exported_at: db.now().toISOString(),
    settings: db.getSettings(),
    suppliers: db.suppliers(false).map(({ name, phone, email, categories, brands, active }) => ({ name, phone, email, categories, brands, active })),
    customers: db.customers().map(({ phone, name, company, emirate, area, trn, level, type }) => ({ phone, name, company, emirate, area, trn, level, type })),
  };
}

const text = (value: unknown, max = 200): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/** Restores a backup over the current setup. Suppliers and customers are matched by number (or email/name) and updated. */
export function restoreBackup(db: Db, input: unknown): { suppliers: number; customers: number } {
  const backup = input as Partial<Backup> | null;
  if (!backup || backup.app !== "smart-sales-agent" || backup.version !== 1 || typeof backup.settings !== "object") {
    throw new Error("This is not a Smart Sales Agent backup file");
  }
  const saved = backup.settings as Partial<Settings>;
  db.saveSettings({
    ...structuredClone(DEFAULT_SETTINGS),
    ...saved,
    margin: { ...DEFAULT_SETTINGS.margin, ...saved.margin },
  });

  let suppliers = 0;
  for (const s of Array.isArray(backup.suppliers) ? backup.suppliers : []) {
    const name = text(s?.name);
    if (!name) continue;
    const phone = text(s.phone, 20)?.replace(/\D/g, "") || null;
    const email = text(s.email);
    const fields = { name, phone, email, categories: text(s.categories, 500) ?? "", brands: text(s.brands, 500) ?? "", active: s.active === 0 ? 0 : 1 };
    const existing = db
      .suppliers(false)
      .find((x) => (phone && x.phone && samePhone(x.phone, phone)) || (email && x.email?.toLowerCase() === email.toLowerCase()) || x.name.toLowerCase() === name.toLowerCase());
    if (existing) db.updateSupplier(existing.id, fields);
    else {
      const added = db.addSupplier(fields);
      if (fields.active === 0) db.updateSupplier(added.id, fields);
    }
    suppliers++;
  }

  let customers = 0;
  const levels = db.getSettings().levels.length;
  for (const c of Array.isArray(backup.customers) ? backup.customers : []) {
    const phone = text(c?.phone, 20)?.replace(/\D/g, "");
    if (!phone) continue;
    const customer = db.customers().find((x) => samePhone(x.phone, phone)) ?? db.upsertCustomer(phone, text(c.name));
    const trn = text(c.trn, 20);
    db.updateCustomer(customer.id, {
      name: text(c.name) ?? customer.name,
      company: text(c.company),
      emirate: text(c.emirate),
      area: text(c.area),
      trn: trn && (trn === "none" || /^\d{15}$/.test(trn)) ? trn : null,
      level: Number.isInteger(c.level) && c.level! >= 1 && c.level! <= levels ? c.level : null,
      type: c.type === "reseller" ? "reseller" : "customer",
    });
    customers++;
  }
  return { suppliers, customers };
}
