import { existsSync } from "node:fs";
import { Coordinator } from "./agents/coordinator.js";
import type { AgentContext } from "./agents/context.js";
import type { Catalog } from "./catalog/catalog.js";
import { ExcelCatalog } from "./catalog/excel.js";
import { ZohoClient } from "./catalog/zoho.js";
import { SmtpImapMailer } from "./channels/email.js";
import { WhatsAppCloud, type WhatsApp } from "./channels/whatsapp.js";
import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { ClaudeLlm } from "./llm.js";
import { createApp } from "./server.js";

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

/** Used when WhatsApp is not set up yet: messages are printed instead of sent, so you can test from the dashboard. */
class ConsoleWhatsApp implements WhatsApp {
  async sendText(to: string, body: string) {
    log(`[WhatsApp to ${to}] ${body}`);
  }
  async sendTemplate(to: string, name: string, _language: string, params: string[]) {
    log(`[WhatsApp template ${name} to ${to}] ${params.join(" | ")}`);
  }
  async sendDocument(to: string, _file: Buffer, filename: string) {
    log(`[WhatsApp document ${filename} to ${to}]`);
  }
}

const config = loadConfig();
if (!config.dashboardPassword) throw new Error("Set DASHBOARD_PASSWORD before starting.");

const db = new Db(config.databasePath);
const zoho = config.zoho.enabled ? new ZohoClient(config.zoho) : null;
let catalog: Catalog;
if (config.catalogSource === "zoho") {
  if (!zoho) throw new Error("CATALOG_SOURCE is zoho but the ZOHO_* settings are missing.");
  catalog = zoho;
} else {
  catalog = new ExcelCatalog(config.excel.path, config.excel.sheet);
  if (!existsSync(config.excel.path)) log(`No price list at ${config.excel.path} yet: upload it in the dashboard (Settings → Price list).`);
}

const whatsappReady = Boolean(config.whatsapp.accessToken && config.whatsapp.phoneNumberId);
if (!whatsappReady) log("WhatsApp is not configured: replies are printed here. Use the dashboard's Test chat.");

const ctx: AgentContext = {
  db,
  llm: new ClaudeLlm(config.anthropicModel),
  catalog,
  whatsapp: whatsappReady ? new WhatsAppCloud(config.whatsapp) : new ConsoleWhatsApp(),
  mailer: config.email.enabled ? new SmtpImapMailer(config.email) : null,
  zoho,
  config,
  ownerPhone: process.env.OWNER_PHONE?.trim() || null,
  log,
};

const coordinator = new Coordinator(ctx);
void Promise.all(coordinator.resumeInterrupted());
createApp(coordinator, config).listen(config.port, () => log(`Smart Sales Agent running on port ${config.port}`));

let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    await coordinator.tick();
  } catch (error) {
    log(`Timed jobs failed: ${(error as Error).stack ?? error}`);
  } finally {
    ticking = false;
  }
}, 60_000);
