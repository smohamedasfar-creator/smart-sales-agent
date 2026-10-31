import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseOwnerReplies, parseWebhook } from "../src/channels/whatsapp.js";
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
