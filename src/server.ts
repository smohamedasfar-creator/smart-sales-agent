import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Coordinator } from "./agents/coordinator.js";
import { parseWebhook, verifySignature } from "./channels/whatsapp.js";
import type { Config } from "./config.js";
import type { Settings } from "./db.js";

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

export function createApp(coordinator: Coordinator, config: Pick<Config, "whatsapp" | "dashboardPassword">) {
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
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Dashboard and its API, behind the dashboard password.
  const here = dirname(fileURLToPath(import.meta.url));
  const auth = dashboardAuth(config.dashboardPassword);
  app.use("/api", auth);

  app.get("/api/enquiries", (_req, res) => {
    res.json(db.listEnquiries());
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
      supplierRequests: db.supplierRequests(enquiry.id),
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
    const { name, phone, email, categories } = req.body ?? {};
    if (!name || (!phone && !email)) return void res.status(400).json({ error: "Name and a phone or email are required" });
    res.json(db.addSupplier({ name, phone: phone || null, email: email || null, categories: categories ?? "" }));
  });

  app.put("/api/suppliers/:id", (req, res) => {
    const { name, phone, email, categories, active } = req.body ?? {};
    db.updateSupplier(Number(req.params.id), {
      name,
      phone: phone || null,
      email: email || null,
      categories: categories ?? "",
      active: active ? 1 : 0,
    });
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
