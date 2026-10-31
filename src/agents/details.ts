import { z } from "zod";
import type { Customer, CustomerDetails } from "../db.js";
import { transcript, UNTRUSTED_NOTE, type AgentContext } from "./context.js";

// Customer Details agent: a new customer's name, company, emirate and TRN, read from their own messages.
// A quote goes out only once these are known (Settings: requireDetails).

const EMIRATES: [string, RegExp][] = [
  ["Abu Dhabi", /\b(abu ?dhabi|al ain|auh)\b/i],
  ["Dubai", /\b(dubai|dxb)\b/i],
  ["Sharjah", /\b(sharjah|shj)\b/i],
  ["Ajman", /\bajman\b/i],
  ["Umm Al Quwain", /\b(umm al ?q[a-z]+|uaq)\b/i],
  ["Ras Al Khaimah", /\b(ras al ?khaimah|rak)\b/i],
  ["Fujairah", /\bfujairah\b/i],
];

export function emirateIn(text: string): string | null {
  return EMIRATES.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

/** What we still need to ask a customer, in words for the customer. */
export function missingDetails(customer: Customer): string[] {
  return [
    !customer.name && "name",
    !customer.company && "company name",
    !customer.emirate && "emirate (location in the UAE)",
    !customer.trn &&
      (customer.trn_problem
        ? `TRN (it should be 15 digits; the one received was "${customer.trn_problem}")`
        : "TRN (VAT registration number), or let us know if you are not VAT registered"),
  ].filter((x): x is string => Boolean(x));
}

export const listText = (items: string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : (items[0] ?? "");

/** The customer as one line: "Ali, Gulf Star Contracting, Sharjah (Al Nahda), TRN 100…". */
export function customerLine(customer: Customer): string {
  const place = customer.emirate ? `${customer.emirate}${customer.area ? ` (${customer.area})` : ""}` : null;
  const trn = customer.trn ? (customer.trn === "none" ? "not VAT registered" : `TRN ${customer.trn}`) : null;
  return [customer.name ?? "New customer", customer.company, place, trn].filter(Boolean).join(", ");
}

/** A TRN answer: 15 digits, "none" when not VAT registered, or the wrong number as given. */
export function readTrn(value: string): { trn: string } | { problem: string } | null {
  const text = value.trim();
  if (/^none$|\b(no|not|don'?t have|without)\b.*\b(trn|vat|registered)\b|\bnot vat\b|\bindividual\b/i.test(text)) return { trn: "none" };
  const digits = text.replace(/[\s-]/g, "").match(/\d+/);
  if (!digits) return null;
  return /^\d{15}$/.test(digits[0]) ? { trn: digits[0] } : { problem: digits[0] };
}

const Details = z.object({
  name: z.string().nullable(),
  company: z.string().nullable(),
  emirate: z.string().nullable(),
  area: z.string().nullable(),
  trn: z.string().nullable().describe('Digits exactly as written, or "none" if they say they are not VAT registered'),
});

const SYSTEM = `You are the Customer Details agent for a trading company in the UAE.
From the customer's own messages, pick out their name, company name, emirate, area and TRN (UAE VAT registration number), but only what they actually said; use null for anything not said.
Emirate is one of: Abu Dhabi, Dubai, Sharjah, Ajman, Umm Al Quwain, Ras Al Khaimah, Fujairah (Al Ain is in Abu Dhabi). Area is a district or city, e.g. Al Quoz, Mussafah.
A reply to our question may just list them, e.g. "Ali, ABC Trading, Sharjah, 100123456700003".
TRN: give the number exactly as they wrote it (digits only), or "none" if they say they are not VAT registered or have no TRN.
${UNTRUSTED_NOTE}`;

/** Reads new details from the conversation and saves them. Returns what was saved, for the log. */
export async function updateDetails(ctx: AgentContext, customer: Customer): Promise<string[]> {
  if (missingDetails(customer).length === 0) return [];
  const result = await ctx.llm.json({
    agent: "details",
    system: SYSTEM,
    prompt: `${transcript(ctx.db.recentMessages(customer.id, 12), customer)}\n\nWhat details has the customer given?`,
    schema: Details,
    effort: "low",
  });
  const changes: CustomerDetails = {};
  const saved: string[] = [];
  const text = (v: string | null) => (v ?? "").trim().slice(0, 120);
  if (!customer.name && text(result.name)) changes.name = text(result.name);
  if (!customer.company && text(result.company)) changes.company = text(result.company);
  if (!customer.emirate && text(result.emirate)) changes.emirate = emirateIn(text(result.emirate)) ?? text(result.emirate);
  if (!customer.area && text(result.area)) changes.area = text(result.area);
  for (const key of ["name", "company", "emirate", "area"] as const) if (changes[key]) saved.push(`${key}: ${changes[key]}`);
  const trn = !customer.trn && text(result.trn) ? readTrn(text(result.trn)) : null;
  if (trn && "trn" in trn) {
    changes.trn = trn.trn;
    changes.trn_problem = null;
    saved.push(trn.trn === "none" ? "not VAT registered" : `TRN ${trn.trn}`);
  } else if (trn && "problem" in trn && trn.problem !== customer.trn_problem) {
    // Ask again, politely, in the next reply.
    changes.trn_problem = trn.problem;
    changes.details_asked = 0;
    saved.push(`TRN "${trn.problem}" is ${trn.problem.length} digits, not 15`);
  }
  if (Object.keys(changes).length > 0) ctx.db.updateCustomer(customer.id, changes);
  return saved;
}
