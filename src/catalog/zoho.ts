import type { Config } from "../config.js";
import type { Catalog, CatalogItem } from "./catalog.js";

// Talks to Zoho Books or Zoho Inventory: reads items (price, cost, stock),
// finds or creates the customer, and creates estimates.
// API docs: https://www.zoho.com/books/api/v3/ and https://www.zoho.com/inventory/api/v1/

export interface EstimateLine {
  zohoItemId?: string;
  name: string;
  quantity: number;
  rate: number;
  unit?: string | null;
}

interface ZohoItem {
  item_id: string;
  name: string;
  sku?: string;
  rate?: number;
  purchase_rate?: number;
  unit?: string;
  status?: string;
  stock_on_hand?: number;
  available_stock?: number;
  actual_available_stock?: number;
  category_name?: string;
  group_name?: string;
}

const ITEMS_CACHE_MS = 15 * 60 * 1000;

export class ZohoClient implements Catalog {
  private accessToken = "";
  private tokenExpiresAt = 0;
  private itemsCache: CatalogItem[] = [];
  private itemsLoadedAt = 0;

  constructor(private readonly config: Config["zoho"]) {}

  private get apiBase(): string {
    const path = this.config.app === "books" ? "books/v3" : "inventory/v1";
    return `https://www.zohoapis.${this.config.domain}/${path}`;
  }

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) return this.accessToken;
    const params = new URLSearchParams({
      refresh_token: this.config.refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "refresh_token",
    });
    const response = await fetch(`https://accounts.${this.config.domain}/oauth/v2/token?${params}`, { method: "POST" });
    const body = (await response.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!response.ok || !body.access_token) throw new Error(`Zoho login failed: ${body.error ?? response.status}`);
    this.accessToken = body.access_token;
    this.tokenExpiresAt = Date.now() + ((body.expires_in ?? 3600) - 120) * 1000;
    return this.accessToken;
  }

  private async request<T>(method: string, path: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
    const params = new URLSearchParams({ organization_id: this.config.organizationId, ...query });
    const response = await fetch(`${this.apiBase}${path}?${params}`, {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${await this.token()}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json()) as T & { code?: number; message?: string };
    if (!response.ok || (json.code !== undefined && json.code !== 0)) {
      throw new Error(`Zoho ${method} ${path} failed: ${json.message ?? response.status}`);
    }
    return json;
  }

  async items(): Promise<CatalogItem[]> {
    if (this.itemsCache.length > 0 && Date.now() - this.itemsLoadedAt < ITEMS_CACHE_MS) return this.itemsCache;
    const items: CatalogItem[] = [];
    for (let page = 1; ; page++) {
      const result = await this.request<{ items: ZohoItem[]; page_context?: { has_more_page?: boolean } }>(
        "GET",
        "/items",
        { page: String(page), per_page: "200", filter_by: "Status.Active" },
      );
      for (const item of result.items) {
        const stock = item.available_stock ?? item.actual_available_stock ?? item.stock_on_hand;
        items.push({
          sku: item.sku || item.item_id,
          name: item.name,
          category: item.category_name || item.group_name || null,
          unit: item.unit || null,
          price: item.rate ?? null,
          cost: item.purchase_rate ?? null,
          stock: stock ?? null,
          zohoItemId: item.item_id,
        });
      }
      if (!result.page_context?.has_more_page) break;
    }
    this.itemsCache = items;
    this.itemsLoadedAt = Date.now();
    return items;
  }

  /** Finds the Zoho customer with this phone number, or creates one. */
  async customerId(phone: string, name: string | null): Promise<string> {
    const digits = phone.replace(/\D/g, "");
    const found = await this.request<{ contacts: { contact_id: string }[] }>("GET", "/contacts", {
      phone_contains: digits.slice(-9),
      contact_type: "customer",
    });
    if (found.contacts.length > 0) return found.contacts[0].contact_id;
    const created = await this.request<{ contact: { contact_id: string } }>("POST", "/contacts", {}, {
      contact_name: name || `+${digits}`,
      contact_type: "customer",
      contact_persons: [{ first_name: name || `+${digits}`, mobile: `+${digits}`, is_primary_contact: true }],
    });
    return created.contact.contact_id;
  }

  async createEstimate(
    customerId: string,
    lines: EstimateLine[],
    validityDays: number,
    referenceNumber: string,
  ): Promise<{ id: string; number: string; total: number }> {
    const today = new Date();
    const expiry = new Date(today.getTime() + validityDays * 86_400_000);
    const result = await this.request<{ estimate: { estimate_id: string; estimate_number: string; total: number } }>(
      "POST",
      "/estimates",
      {},
      {
        customer_id: customerId,
        reference_number: referenceNumber,
        date: today.toISOString().slice(0, 10),
        expiry_date: expiry.toISOString().slice(0, 10),
        line_items: lines.map((line) =>
          line.zohoItemId
            ? { item_id: line.zohoItemId, quantity: line.quantity, rate: line.rate }
            : { name: line.name, quantity: line.quantity, rate: line.rate, unit: line.unit ?? undefined },
        ),
      },
    );
    return {
      id: result.estimate.estimate_id,
      number: result.estimate.estimate_number,
      total: result.estimate.total,
    };
  }

  async markEstimate(estimateId: string, status: "sent" | "accepted" | "declined"): Promise<void> {
    await this.request("POST", `/estimates/${estimateId}/status/${status}`);
  }

  /** Downloads the estimate as a PDF. */
  async estimatePdf(estimateId: string): Promise<Buffer> {
    const params = new URLSearchParams({ organization_id: this.config.organizationId, accept: "pdf" });
    const response = await fetch(`${this.apiBase}/estimates/${estimateId}?${params}`, {
      headers: { Authorization: `Zoho-oauthtoken ${await this.token()}` },
    });
    if (!response.ok) throw new Error(`Zoho estimate PDF failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
}
