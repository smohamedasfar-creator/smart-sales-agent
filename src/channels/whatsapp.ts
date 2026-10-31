import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";

// WhatsApp Business Cloud API (Meta). Docs:
// https://developers.facebook.com/docs/whatsapp/cloud-api

export interface WhatsApp {
  sendText(to: string, body: string): Promise<void>;
  /** Sends an approved message template; needed when the last message from that number is over 24 hours old. */
  sendTemplate(to: string, name: string, language: string, bodyParams: string[]): Promise<void>;
  sendDocument(to: string, file: Buffer, filename: string, caption: string): Promise<void>;
}

export interface InboundMessage {
  id: string;
  from: string;
  name: string | null;
  text: string;
}

/** A message the owner typed in the WhatsApp Business app on their phone (number shared with the API, "coexistence"). */
export interface OwnerReply {
  id: string;
  to: string;
  text: string;
}

export class WhatsAppCloud implements WhatsApp {
  constructor(private readonly config: Config["whatsapp"]) {}

  private url(path: string): string {
    return `https://graph.facebook.com/${this.config.apiVersion}/${this.config.phoneNumberId}/${path}`;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(this.url(path), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as { error?: { message?: string } };
    if (!response.ok) throw new Error(`WhatsApp ${path} failed: ${json.error?.message ?? response.status}`);
    return json;
  }

  async sendText(to: string, body: string): Promise<void> {
    await this.post("messages", {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body, preview_url: false },
    });
  }

  async sendTemplate(to: string, name: string, language: string, bodyParams: string[]): Promise<void> {
    await this.post("messages", {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name,
        language: { code: language },
        components: bodyParams.length
          ? [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }]
          : [],
      },
    });
  }

  async sendDocument(to: string, file: Buffer, filename: string, caption: string): Promise<void> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", "application/pdf");
    form.append("file", new Blob([new Uint8Array(file)], { type: "application/pdf" }), filename);
    const upload = await fetch(this.url("media"), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
      body: form,
    });
    const media = (await upload.json()) as { id?: string; error?: { message?: string } };
    if (!upload.ok || !media.id) throw new Error(`WhatsApp media upload failed: ${media.error?.message ?? upload.status}`);
    await this.post("messages", {
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: { id: media.id, filename, caption },
    });
  }
}

/** Checks that a webhook call really came from Meta (X-Hub-Signature-256 header). */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

interface WebhookMessage {
  id: string;
  from: string;
  to?: string;
  type: string;
  text?: { body: string };
  button?: { text: string };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
  image?: { caption?: string };
  document?: { caption?: string; filename?: string };
  location?: { name?: string; address?: string };
}

interface WebhookBody {
  entry?: {
    changes?: {
      field?: string;
      value?: {
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: WebhookMessage[];
        /** Messages sent from the WhatsApp Business app on the phone (webhook field "smb_message_echoes"). */
        message_echoes?: WebhookMessage[];
      };
    }[];
  }[];
}

function messageText(message: WebhookMessage): string {
  switch (message.type) {
    case "text":
      return message.text?.body ?? "";
    case "button":
      return message.button?.text ?? "";
    case "interactive":
      return message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? "";
    case "image":
      return `[photo] ${message.image?.caption ?? ""}`.trim();
    case "document":
      return `[document ${message.document?.filename ?? ""}] ${message.document?.caption ?? ""}`.trim();
    case "location":
      return `[location] ${message.location?.name ?? ""} ${message.location?.address ?? ""}`.trim();
    default:
      return `[${message.type} message]`;
  }
}

/** Pulls out the messages the owner sent from the WhatsApp Business app on their phone. */
export function parseOwnerReplies(body: unknown): OwnerReply[] {
  const result: OwnerReply[] = [];
  for (const entry of (body as WebhookBody).entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.message_echoes ?? []) {
        if (message.to) result.push({ id: message.id, to: message.to, text: messageText(message) });
      }
    }
  }
  return result;
}

/** Pulls the customer messages out of a webhook call. Delivery and read receipts are ignored. */
export function parseWebhook(body: unknown): InboundMessage[] {
  const result: InboundMessage[] = [];
  for (const entry of (body as WebhookBody).entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      for (const message of value?.messages ?? []) {
        const contact = value?.contacts?.find((c) => c.wa_id === message.from);
        result.push({ id: message.id, from: message.from, name: contact?.profile?.name ?? null, text: messageText(message) });
      }
    }
  }
  return result;
}
