import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { checkWhatsApp, linkWhatsAppAccount, parseOwnerReplies, parseWebhook } from "../src/channels/whatsapp.js";
import { createApp } from "../src/server.js";
import { setup } from "./helpers.js";

const SECRET = "app-secret";
const servers: { close: () => void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function start() {
  const t = setup();
  const app = createApp(t.coordinator, {
    dashboardPassword: "pw",
    whatsapp: { ...t.ctx.config.whatsapp, appSecret: SECRET, verifyToken: "verify-me" },
  });
  const server = app.listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { t, base };
}

function webhookBody(text: string) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: "971501111111", profile: { name: "Ali" } }],
              messages: [{ id: "wamid.1", from: "971501111111", type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

describe("WhatsApp webhook", () => {
  it("answers Meta's verification only with the right token", async () => {
    const { base } = await start();
    const ok = await fetch(`${base}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=123`);
    expect(await ok.text()).toBe("123");
    const bad = await fetch(`${base}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123`);
    expect(bad.status).toBe(403);
  });

  it("rejects calls without a valid signature and handles signed ones", async () => {
    const { t, base } = await start();
    t.llm.handlers.coordinator = () => ({ intent: "other" });
    const body = JSON.stringify(webhookBody("hello"));

    const unsigned = await fetch(`${base}/webhook/whatsapp`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    expect(unsigned.status).toBe(401);

    const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    const signed = await fetch(`${base}/webhook/whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
      body,
    });
    expect(signed.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.db.recentMessages(1).map((m) => m.body)).toEqual(["hello", "reply for: Reply naturally. If they have not asked for anything yet, ask which products they need a price for."]);
  });

  it("reads button replies and photos with captions", () => {
    const body = webhookBody("x");
    body.entry[0].changes[0].value.messages = [
      { id: "a", from: "1", type: "button", button: { text: "Yes" } },
      { id: "b", from: "1", type: "image", image: { caption: "this size" } },
    ] as never;
    expect(parseWebhook(body).map((m) => m.text)).toEqual(["Yes", "[photo] this size"]);
  });
});

describe("WhatsApp Business app on the same number", () => {
  it("reads the owner's own replies from the smb_message_echoes webhook", () => {
    const body = {
      entry: [{ changes: [{ field: "smb_message_echoes", value: { message_echoes: [
        { id: "wamid.e1", from: "971500000099", to: "971501111111", type: "text", text: { body: "Sure, sending now" } },
      ] } }] }],
    };
    expect(parseOwnerReplies(body)).toEqual([{ id: "wamid.e1", to: "971501111111", text: "Sure, sending now" }]);
    expect(parseWebhook(body)).toEqual([]);
  });
});

describe("privacy policy", () => {
  it("is public and shows the business name", async () => {
    const { t, base } = await start();
    t.db.saveSettings({ ...t.db.getSettings(), businessName: "Jupiter Plus <Technology>" });
    const response = await fetch(`${base}/privacy`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Jupiter Plus &lt;Technology&gt;");
    expect(html).toContain("delete my data");
  });
});

describe("dashboard", () => {
  it("needs the password", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/settings`)).status).toBe(401);
    const auth = { Authorization: `Basic ${Buffer.from("owner:pw").toString("base64")}` };
    const response = await fetch(`${base}/api/settings`, { headers: auth });
    expect(response.status).toBe(200);
    expect((await response.json()).margin.defaultPercent).toBe(15);
  });

  it("saves margin settings without losing the other margin fields", async () => {
    const { base } = await start();
    const headers = { Authorization: `Basic ${Buffer.from("owner:pw").toString("base64")}`, "Content-Type": "application/json" };
    await fetch(`${base}/api/settings`, { method: "PUT", headers, body: JSON.stringify({ margin: { defaultPercent: 22 } }) });
    const saved = await (await fetch(`${base}/api/settings`, { headers })).json();
    expect(saved.margin).toMatchObject({ defaultPercent: 22, priceBasis: "list" });
  });

  it("lets the owner set a customer's level and details, and checks the TRN", async () => {
    const { t, base } = await start();
    const headers = { Authorization: `Basic ${Buffer.from("owner:pw").toString("base64")}`, "Content-Type": "application/json" };
    const customer = t.db.upsertCustomer("971501111111", "Ali");
    const put = (body: unknown) => fetch(`${base}/api/customers/${customer.id}`, { method: "PUT", headers, body: JSON.stringify(body) });
    expect((await put({ trn: "123" })).status).toBe(400);
    expect((await put({ level: 9 })).status).toBe(400);
    const saved = await (await put({ level: 1, type: "reseller", company: "Gulf Star", trn: "100345678900003" })).json();
    expect(saved).toMatchObject({ level: 1, type: "reseller", company: "Gulf Star", trn: "100345678900003" });

    t.db.createEnquiry(customer.id);
    t.db.addOrder({ enquiry_id: 1, customer_id: customer.id, quote_ref: "Q-00001", brand: "UGREEN", subtotal: 10, lines: [] });
    const orders = await (await fetch(`${base}/api/orders?brand=UGREEN`, { headers })).json();
    expect(orders.map((o: { ref: string; company: string }) => [o.ref, o.company])).toEqual([["SO-0001", "Gulf Star"]]);
    expect((await fetch(`${base}/api/orders/1`, { method: "PUT", headers, body: JSON.stringify({ status: "lost" }) })).status).toBe(400);
  });

  it("replaces the price list with an uploaded Excel file only when it can be read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "upload-"));
    const path = join(dir, "price-list.xlsx");
    const t = setup();
    const app = createApp(t.coordinator, {
      dashboardPassword: "pw",
      whatsapp: { ...t.ctx.config.whatsapp, appSecret: SECRET, verifyToken: "verify-me" },
      catalogSource: "excel",
      excel: { path, sheet: "" },
    });
    const server = app.listen(0);
    servers.push(server);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { Authorization: `Basic ${Buffer.from("owner:pw").toString("base64")}`, "Content-Type": "application/octet-stream" };

    const bad = await fetch(`${base}/api/price-list`, { method: "POST", headers, body: Buffer.from("not excel") });
    expect(bad.status).toBe(400);
    expect(existsSync(path)).toBe(false);

    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("UGREEN").addRow(["Name", "Customer Price", "QTY"]);
    workbook.getWorksheet("UGREEN")!.addRow(["UGREEN HDMI CABLE 1M", 18, 7]);
    const good = await fetch(`${base}/api/price-list`, { method: "POST", headers, body: Buffer.from(await workbook.xlsx.writeBuffer()) });
    expect(await good.json()).toEqual({ items: 1, brands: ["UGREEN"] });
    expect(existsSync(path)).toBe(true);
  });

  it("downloads a backup and restores it on a fresh app", async () => {
    const auth = { Authorization: `Basic ${Buffer.from("owner:pw").toString("base64")}` };
    const first = await start();
    const s = first.t.db.getSettings();
    first.t.db.saveSettings({ ...s, trn: "100111222300003", margin: { ...s.margin, byCategory: { "CAT6 CABLE": 20 }, byBrand: { OPTERNA: 25 } }, levelByCategory: { SWITCH: { "2": 3 } } });
    first.t.db.addSupplier({ name: "UGREEN Distributor", phone: "971500000111", email: null, categories: "", brands: "UGREEN" });
    const customer = first.t.db.upsertCustomer("971501111111", "Ali");
    first.t.db.updateCustomer(customer.id, { company: "Gulf Star", emirate: "Sharjah", trn: "100345678900003", level: 1, type: "reseller" });

    const download = await fetch(`${first.base}/api/backup`, { headers: auth });
    expect(download.headers.get("content-disposition")).toContain("smart-sales-agent-backup-");
    const backup = await download.json();

    const second = await start();
    const restore = (body: unknown) =>
      fetch(`${second.base}/api/restore`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await restore({ hello: "world" })).status).toBe(400);
    expect(await (await restore(backup)).json()).toEqual({ suppliers: 1, customers: 1 });
    // Restoring twice doesn't make duplicates.
    await restore(backup);

    const restored = second.t.db.getSettings();
    expect(restored.trn).toBe("100111222300003");
    expect(restored.margin.byCategory).toEqual({ "CAT6 CABLE": 20 });
    expect(restored.margin.byBrand).toEqual({ OPTERNA: 25 });
    expect(restored.levelByCategory).toEqual({ SWITCH: { "2": 3 } });
    expect(second.t.db.suppliers(false).map((x) => [x.name, x.brands])).toEqual([["UGREEN Distributor", "UGREEN"]]);
    expect(second.t.db.customers()).toHaveLength(1);
    expect(second.t.db.customers()[0]).toMatchObject({ company: "Gulf Star", emirate: "Sharjah", level: 1, type: "reseller" });
  });

  it("shows what is connected without giving away any key", async () => {
    const { base } = await start();
    const headers = { Authorization: `Basic ${Buffer.from("owner:pw").toString("base64")}` };
    const text = await (await fetch(`${base}/api/connections`, { headers })).text();
    const status = JSON.parse(text);
    expect(status.whatsapp).toMatchObject({ connected: false, webhookReady: true });
    expect(status.zoho.connected).toBe(false);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("verify-me");
  });
});

describe("WhatsApp check from the dashboard", () => {
  const config = { accessToken: "token", phoneNumberId: "142", businessAccountId: "", appSecret: "", verifyToken: "", apiVersion: "v23.0", followupTemplate: "", followupTemplateLanguage: "en", supplierTemplate: "", supplierTemplateLanguage: "en" };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("explains a rejected token", async () => {
    const fake = async () => reply(401, { error: { message: "Error validating access token: Session has expired", code: 190 } });
    const result = await checkWhatsApp(config, "2025", fake as typeof fetch);
    expect(result.tokenError).toBe("Error validating access token: Session has expired (code 190)");
    expect(result.linked).toBeNull();
  });

  it("finds an unlinked WhatsApp account and links it", async () => {
    const calls: string[] = [];
    let linked = false;
    const fake = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url).split("v23.0/")[1]}`);
      if (String(url).includes("subscribed_apps")) {
        if (init?.method === "POST") {
          linked = true;
          return reply(200, { success: true });
        }
        return reply(200, { data: linked ? [{ whatsapp_business_api_data: { name: "Smart Sales Agent" } }] : [] });
      }
      return reply(200, { display_phone_number: "+1 555-209-9588" });
    };
    expect(await checkWhatsApp(config, "2025", fake as typeof fetch)).toEqual({ tokenError: null, phone: "+1 555-209-9588", linked: false, linkError: null });
    expect(await linkWhatsAppAccount(config, "2025", fake as typeof fetch)).toBeNull();
    expect((await checkWhatsApp(config, "2025", fake as typeof fetch)).linked).toBe(true);
    expect(calls).toContain("POST 2025/subscribed_apps");
  });
});
