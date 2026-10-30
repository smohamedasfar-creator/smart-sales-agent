import { Coordinator } from "../src/agents/coordinator.js";
import type { AgentContext } from "../src/agents/context.js";
import type { Catalog, CatalogItem } from "../src/catalog/catalog.js";
import type { InboundEmail, Mailer } from "../src/channels/email.js";
import type { WhatsApp } from "../src/channels/whatsapp.js";
import { Db } from "../src/db.js";
import type { Llm, LlmRequest } from "../src/llm.js";
import type { z } from "zod";

/** Stands in for Claude: each agent's answer comes from a handler the test sets. */
export class FakeLlm implements Llm {
  calls: LlmRequest[] = [];
  handlers: Record<string, (request: LlmRequest) => unknown> = {
    reception: (request) => `reply for: ${request.prompt.split("Your task: ")[1] ?? ""}`,
    followup: () => "Just checking in on our quotation.",
  };

  async json<T>(request: LlmRequest & { schema: z.ZodType<T> }): Promise<T> {
    this.calls.push(request);
    const handler = this.handlers[request.agent];
    if (!handler) throw new Error(`No fake answer for agent ${request.agent}`);
    return request.schema.parse(handler(request));
  }

  async text(request: LlmRequest): Promise<string> {
    this.calls.push(request);
    const handler = this.handlers[request.agent];
    if (!handler) throw new Error(`No fake answer for agent ${request.agent}`);
    return String(handler(request));
  }
}

export class FakeWhatsApp implements WhatsApp {
  sent: { to: string; body: string }[] = [];
  templates: { to: string; name: string; params: string[] }[] = [];

  async sendText(to: string, body: string) {
    this.sent.push({ to, body });
  }
  async sendTemplate(to: string, name: string, _language: string, params: string[]) {
    this.templates.push({ to, name, params });
  }
  async sendDocument() {}
}

export class FakeMailer implements Mailer {
  sent: { to: string; subject: string; text: string }[] = [];
  inbox: InboundEmail[] = [];

  async send(to: string, subject: string, text: string) {
    this.sent.push({ to, subject, text });
  }
  async fetchUnread() {
    const emails = this.inbox;
    this.inbox = [];
    return emails;
  }
}

export const CATALOG: CatalogItem[] = [
  { sku: "PVC-110", name: 'PVC Pipe 4" (110mm) 6m', category: "Pipes", unit: "pcs", price: 12.5, cost: 9, stock: 200 },
  { sku: "PVC-160", name: 'PVC Pipe 6" (160mm) 6m', category: "Pipes", unit: "pcs", price: 24, cost: 18, stock: 40 },
  { sku: "ELB-110", name: 'PVC Elbow 4" 90 degree', category: "Fittings", unit: "pcs", price: 3.2, cost: 2.1, stock: 5 },
  { sku: "TEE-110", name: 'PVC Tee 4"', category: "Fittings", unit: "pcs", price: 4.1, cost: 2.8, stock: 100 },
];

export function setup(options: { catalog?: CatalogItem[]; followupTemplate?: string } = {}) {
  const db = new Db(":memory:");
  let clock = new Date("2026-10-01T08:00:00Z");
  db.now = () => clock;
  const llm = new FakeLlm();
  const whatsapp = new FakeWhatsApp();
  const mailer = new FakeMailer();
  const catalog: Catalog = { items: async () => options.catalog ?? CATALOG };
  const logs: string[] = [];
  const ctx: AgentContext = {
    db,
    llm,
    catalog,
    whatsapp,
    mailer,
    zoho: null,
    config: {
      catalogSource: "excel",
      whatsapp: {
        accessToken: "",
        phoneNumberId: "",
        appSecret: "",
        verifyToken: "",
        apiVersion: "v23.0",
        followupTemplate: options.followupTemplate ?? "",
        followupTemplateLanguage: "en",
        supplierTemplate: "",
        supplierTemplateLanguage: "en",
      },
    },
    ownerPhone: "971500000099",
    log: (message) => logs.push(message),
  };
  return {
    db,
    llm,
    whatsapp,
    mailer,
    logs,
    ctx,
    coordinator: new Coordinator(ctx),
    advanceHours: (hours: number) => {
      clock = new Date(clock.getTime() + hours * 3_600_000);
    },
  };
}
