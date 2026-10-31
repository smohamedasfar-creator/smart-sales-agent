import { timingSafeEqual } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Coordinator } from "./agents/coordinator.js";
import { checkWhatsApp, linkWhatsAppAccount, parseOwnerReplies, parseWebhook, verifySignature } from "./channels/whatsapp.js";
import type { Config } from "./config.js";
import { createBackup, restoreBackup } from "./backup.js";
import { readExcelCatalog } from "./catalog/excel.js";
import { privacyPage } from "./privacy.js";
import type { CustomerDetails, Settings } from "./db.js";

// HTTP server: the WhatsApp webhook (Meta calls it for every new message) and the
// owner's dashboard with its API.

type RawRequest = Request & { rawBody?: Buffer };

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function dashboardAuth(password: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const given = header.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString().split(":").slice(1).join(":") : "";
    if (password && sameText(given, password)) return next();
    res.set("WWW-Authenticate", 'Basic realm="Smart Sales Agent"').status(401).send("Password required");
  };
}

type AppConfig = Pick<Config, "whatsapp" | "dashboardPassword"> & Partial<Pick<Config, "publicUrl" | "zoho" | "email" | "catalogSource" | "excel">>;

/** What is connected, for the dashboard's Connections card. Never includes a key or password. */
export function connectionStatus(config: AppConfig) {
  const wa = config.whatsapp;
  return {
    claude: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    whatsapp: {
      connected: Boolean(wa.accessToken && wa.phoneNumberId),
      webhookReady: Boolean(wa.appSecret && wa.verifyToken),
      webhookUrl: `${(config.publicUrl ?? "").replace(/\/$/, "")}/webhook/whatsapp`,
      businessAccountId: wa.businessAccountId ?? "",
      followupTemplate: wa.followupTemplate,
      supplierTemplate: wa.supplierTemplate,
    },
    zoho: { connected: Boolean(config.zoho?.enabled), app: config.zoho?.app ?? "books", domain: config.zoho?.domain ?? "zoho.com" },
    email: { connected: Boolean(config.email?.enabled), from: config.email?.from ?? "" },
    priceList: config.catalogSource === "zoho" ? "Zoho" : `Excel (${config.excel?.path ?? "data/price-list.xlsx"})`,
  };
}

export function createApp(coordinator: Coordinator, config: AppConfig) {
  const { db } = coordinator.ctx;
  const app = express();
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buffer) => {
        (req as RawRequest).rawBody = buffer;
      },
    }),
  );

  // Meta checks the webhook once when you save its URL.
  app.get("/webhook/whatsapp", (req, res) => {
    const verified =
      req.query["hub.mode"] === "subscribe" &&
      config.whatsapp.verifyToken !== "" &&
      req.query["hub.verify_token"] === config.whatsapp.verifyToken;
    if (verified) res.send(String(req.query["hub.challenge"] ?? ""));
    else res.sendStatus(403);
  });

  app.post("/webhook/whatsapp", (req: RawRequest, res) => {
    if (!config.whatsapp.appSecret || !verifySignature(req.rawBody ?? Buffer.alloc(0), req.header("x-hub-signature-256"), config.whatsapp.appSecret)) {
      res.sendStatus(401);
      return;
    }
    // Answer Meta at once; the agents work in the background.
    res.sendStatus(200);
    for (const message of parseWebhook(req.body)) void coordinator.onWhatsApp(message);
    for (const reply of parseOwnerReplies(req.body)) void coordinator.onOwnerReply(reply);
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Public, for Meta's app review: the privacy policy and data deletion instructions.
  app.get("/privacy", (_req, res) => {
    res.type("html").send(privacyPage(db.getSettings(), db.now().toISOString().slice(0, 10)));
  });

  // Dashboard and its API, behind the dashboard password.
  const here = dirname(fileURLToPath(import.meta.url));
  const auth = dashboardAuth(config.dashboardPassword);
  app.use("/api", auth);

  app.get("/api/enquiries", (_req, res) => {
    res.json(db.listEnquiries().map((e) => ({ ...e, working: coordinator.workingOn(e.phone) })));
  });

  app.get("/api/enquiries/:id", (req, res) => {
    const enquiry = db.getEnquiry(Number(req.params.id));
    if (!enquiry) return void res.sendStatus(404);
    const customer = db.getCustomer(enquiry.customer_id)!;
    res.json({
      enquiry,
      customer,
      messages: db.recentMessages(customer.id, 100),
      items: db.items(enquiry.id),
      supplierRequests: db.supplierRequests(enquiry.id).map((r) => ({ ...r, supplier_name: db.getSupplier(r.supplier_id)?.name ?? null })),
      activity: db.activity(enquiry.id),
      working: coordinator.workingOn(customer.phone),
    });
  });

  app.post("/api/enquiries/:id/resume", (req, res) => {
    coordinator.resume(Number(req.params.id));
    res.json({ ok: true });
  });

  app.post("/api/enquiries/:id/message", async (req, res) => {
    const body = String(req.body?.body ?? "").trim();
    if (!body) return void res.status(400).json({ error: "Message is empty" });
    await coordinator.sendManual(Number(req.params.id), body);
    res.json({ ok: true });
  });

  app.get("/api/drafts", (_req, res) => {
    res.json(db.pendingDrafts());
  });

  app.post("/api/drafts/:id/approve", async (req, res) => {
    await coordinator.approveDraft(Number(req.params.id), req.body?.body);
    res.json({ ok: true });
  });

  app.post("/api/drafts/:id/reject", (req, res) => {
    coordinator.rejectDraft(Number(req.params.id));
    res.json({ ok: true });
  });

  app.get("/api/connections", (_req, res) => {
    res.json(connectionStatus(config));
  });

  // Asks Meta directly whether WhatsApp is set up right, and links the WhatsApp account to the app.
  const accountId = (value: unknown) => String(value ?? "").replace(/\D/g, "") || config.whatsapp.businessAccountId;
  app.post("/api/whatsapp/check", async (req, res) => {
    res.json(await checkWhatsApp(config.whatsapp, accountId(req.body?.businessAccountId)));
  });
  app.post("/api/whatsapp/link", async (req, res) => {
    const id = accountId(req.body?.businessAccountId);
    if (!id) return void res.status(400).json({ error: "Enter the Messaging account ID from Meta's API setup" });
    const error = await linkWhatsAppAccount(config.whatsapp, id);
    if (error) return void res.status(400).json({ error });
    res.json(await checkWhatsApp(config.whatsapp, id));
  });

  // Backup: settings, suppliers and customers as one file to keep; restore it after a reset or on a new server.
  app.get("/api/backup", (_req, res) => {
    const day = db.now().toISOString().slice(0, 10);
    res.set("Content-Disposition", `attachment; filename="smart-sales-agent-backup-${day}.json"`);
    res.type("application/json").send(JSON.stringify(createBackup(db), null, 2));
  });

  app.post("/api/restore", express.json({ limit: "10mb" }), (req, res) => {
    res.json(restoreBackup(db, req.body));
  });

  app.get("/api/settings", (_req, res) => {
    res.json(db.getSettings());
  });

  app.put("/api/settings", (req, res) => {
    const current = db.getSettings();
    const next = { ...current, ...(req.body as Partial<Settings>) };
    next.margin = { ...current.margin, ...(req.body?.margin ?? {}) };
    next.personalContacts = (next.personalContacts ?? [])
      .map((c) => ({ phone: String(c.phone ?? "").replace(/\D/g, ""), name: String(c.name ?? "").trim() }))
      .filter((c) => c.phone);
    db.saveSettings(next);
    // People marked as personal are taken off the customer list, unless they already have an enquiry.
    for (const contact of next.personalContacts) db.forgetCustomer(contact.phone);
    res.json(next);
  });

  app.get("/api/suppliers", (_req, res) => {
    res.json(db.suppliers(false));
  });

  app.post("/api/suppliers", (req, res) => {
    const { name, phone, email, categories, brands } = req.body ?? {};
    if (!name || (!phone && !email)) return void res.status(400).json({ error: "Name and a phone or email are required" });
    res.json(db.addSupplier({ name, phone: phone || null, email: email || null, categories: categories ?? "", brands: brands ?? "" }));
  });

  app.put("/api/suppliers/:id", (req, res) => {
    const { name, phone, email, categories, brands, active } = req.body ?? {};
    db.updateSupplier(Number(req.params.id), {
      name,
      phone: phone || null,
      email: email || null,
      categories: categories ?? "",
      brands: brands ?? "",
      active: active ? 1 : 0,
    });
    res.json({ ok: true });
  });

  // A customer's level, kind (end customer or reseller) and details, set by the owner.
  app.put("/api/customers/:id", (req, res) => {
    const body = req.body ?? {};
    const changes: CustomerDetails = {};
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);
    if ("level" in body) {
      const level = Number(body.level);
      if (!Number.isInteger(level) || level < 1 || level > db.getSettings().levels.length) return void res.status(400).json({ error: "Unknown level" });
      changes.level = level;
    }
    if ("type" in body) {
      if (body.type !== "customer" && body.type !== "reseller") return void res.status(400).json({ error: "Type is customer or reseller" });
      changes.type = body.type;
    }
    for (const key of ["name", "company", "emirate", "area"] as const) if (key in body) changes[key] = text(body[key]);
    if ("trn" in body) {
      const trn = text(body.trn);
      if (trn && trn !== "none" && !/^\d{15}$/.test(trn)) return void res.status(400).json({ error: "A TRN has 15 digits (or write none)" });
      changes.trn = trn;
      changes.trn_problem = null;
    }
    db.updateCustomer(Number(req.params.id), changes);
    res.json(db.getCustomer(Number(req.params.id)));
  });

  // Replaces the Excel price list with an uploaded file, after checking that it can be read.
  app.post("/api/price-list", express.raw({ type: "application/octet-stream", limit: "20mb" }), async (req, res) => {
    if (config.catalogSource === "zoho") return void res.status(400).json({ error: "The price list comes from Zoho (CATALOG_SOURCE=zoho)" });
    const path = config.excel?.path ?? "data/price-list.xlsx";
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) return void res.status(400).json({ error: "Choose an Excel file (.xlsx)" });
    mkdirSync(dirname(path), { recursive: true });
    const upload = `${path}.upload.xlsx`;
    writeFileSync(upload, body);
    try {
      const items = await readExcelCatalog(upload, config.excel?.sheet ?? "");
      renameSync(upload, path);
      const brands = [...new Set(items.map((i) => i.brand).filter(Boolean))];
      res.json({ items: items.length, brands });
    } catch (error) {
      rmSync(upload, { force: true });
      res.status(400).json({ error: `This file can't be used: ${(error as Error).message.replace(upload, "the file")}` });
    }
  });

  // The brands and categories in the price list, for the Settings tables.
  app.get("/api/catalog-summary", async (_req, res) => {
    let items: Awaited<ReturnType<typeof coordinator.ctx.catalog.items>> = [];
    try {
      items = await coordinator.ctx.catalog.items();
    } catch {
      // No price list yet: empty tables.
    }
    const brands = new Map<string, number>();
    const categories = new Map<string, { name: string; brands: Set<string>; items: number }>();
    for (const item of items) {
      if (item.brand) brands.set(item.brand, (brands.get(item.brand) ?? 0) + 1);
      if (!item.category) continue;
      const key = item.category.toLowerCase();
      const entry = categories.get(key) ?? { name: item.category, brands: new Set<string>(), items: 0 };
      entry.items++;
      if (item.brand) entry.brands.add(item.brand);
      categories.set(key, entry);
    }
    res.json({
      brands: [...brands].map(([name, count]) => ({ name, items: count })).sort((a, b) => a.name.localeCompare(b.name)),
      categories: [...categories.values()]
        .map((c) => ({ name: c.name, brands: [...c.brands].sort(), items: c.items }))
        .sort((a, b) => (a.brands[0] ?? "").localeCompare(b.brands[0] ?? "") || a.name.localeCompare(b.name)),
    });
  });

  app.get("/api/alerts", (_req, res) => {
    res.json(db.alerts());
  });

  app.get("/api/orders", (req, res) => {
    res.json(db.orders(typeof req.query.brand === "string" && req.query.brand ? req.query.brand : undefined));
  });

  app.put("/api/orders/:id", (req, res) => {
    const status = req.body?.status;
    if (!["confirmed", "ordered", "delivered", "paid"].includes(status)) return void res.status(400).json({ error: "Unknown status" });
    db.setOrderStatus(Number(req.params.id), status);
    res.json({ ok: true });
  });

  // Try the agents without WhatsApp: the message is handled as if a customer sent it.
  app.post("/api/test-message", async (req, res) => {
    const { from, name, text } = req.body ?? {};
    if (!from || !text) return void res.status(400).json({ error: "from and text are required" });
    await coordinator.onWhatsApp({ id: `test-${Date.now()}-${Math.random()}`, from: String(from), name: name || null, text: String(text) });
    res.json({ ok: true });
  });

  app.use("/", auth, express.static(join(here, "public")));

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: error.message });
  });

  return app;
}
