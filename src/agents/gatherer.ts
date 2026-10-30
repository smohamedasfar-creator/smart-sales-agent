import { z } from "zod";
import { closeMatches } from "../catalog/catalog.js";
import type { Customer, Enquiry } from "../db.js";
import { transcript, UNTRUSTED_NOTE, type AgentContext } from "./context.js";

// Requirement Gatherer agent: turns the chat into a clean list of items and
// quantities, and lists the questions still needed before we can quote.

const GatherResult = z.object({
  items: z.array(
    z.object({
      description: z.string().describe("Product name with size, grade, brand or colour the customer gave"),
      quantity: z.number().describe("Quantity requested; 0 if not given yet"),
      unit: z.string().nullable().describe("pcs, m, kg, box, etc., or null if not given"),
    }),
  ),
  missing_questions: z
    .array(z.string())
    .describe("Short questions we must ask before we can quote, e.g. a missing quantity or size. Empty if nothing is missing."),
});

export type GatherResult = z.infer<typeof GatherResult>;

const SYSTEM = `You are the Requirement Gatherer for a trading company's sales team.
Read the whole conversation and write the complete, current list of items the customer wants a price for.
- Include every item mentioned in this enquiry, applying any later changes ("make it 60", "remove the elbows").
- Keep the customer's own details (size, brand, grade, colour). Do not invent details.
- Ask a question only when the missing detail changes the price, such as a missing quantity or size. Do not ask about things a salesperson would not need.
- If the customer has not asked for any product yet, return no items and no questions.
${UNTRUSTED_NOTE}`;

const Options = z.object({ questions: z.array(z.string()) });

const OPTIONS_SYSTEM = `You are the Requirement Gatherer for a trading company. You know our stock list well.
For each request you get the closest products from our stock list.
Decide whether the customer's words (in the conversation) already point to exactly one product.
- If they do, ask nothing about that request.
- If several products fit and they differ in a way that matters (length, connector, fibre type, speed, number of ports, PoE, power, size, colour, brand), write ONE short, polite question that offers the choices as a numbered list using only the differences (e.g. "1) 1m  2) 2m  3) 3m"), at most 6 choices, in-stock ones first.
${UNTRUSTED_NOTE}`;

/** Asks which product the customer means when their words fit several in the stock list. */
async function whichOne(ctx: AgentContext, customer: Customer, messages: Parameters<typeof transcript>[0], items: GatherResult["items"]): Promise<string[]> {
  const catalog = await ctx.catalog.items();
  const open = items
    .map((item, n) => ({ n, item, options: closeMatches(catalog, item.description) }))
    .filter((x) => x.options.length > 1);
  if (open.length === 0) return [];
  const listing = open
    .map(
      (x) =>
        `Request ${x.n + 1}: ${x.item.quantity || "?"} ${x.item.unit ?? ""} ${x.item.description}\n  Closest products in our stock list:\n` +
        x.options
          .slice(0, 10)
          .map((c) => `    - ${c.name} | brand: ${c.brand ?? "none"} | ${c.category ?? ""} | stock: ${c.stock ?? "not tracked"}`)
          .join("\n"),
    )
    .join("\n\n");
  const result = await ctx.llm.json({
    agent: "options",
    system: OPTIONS_SYSTEM,
    prompt: `${transcript(messages, customer)}\n\n<requests>\n${listing}\n</requests>\n\nWrite the questions, if any.`,
    schema: Options,
    effort: "medium",
  });
  return result.questions.filter((q) => q.trim() !== "");
}

export async function gatherRequirements(ctx: AgentContext, enquiry: Enquiry, customer: Customer): Promise<GatherResult> {
  const messages = ctx.db.enquiryMessages(enquiry.id);
  const result = await ctx.llm.json({
    agent: "gatherer",
    system: SYSTEM,
    prompt: `${transcript(messages, customer)}\n\nWrite the item list and any missing questions.`,
    schema: GatherResult,
    effort: "medium",
  });
  const items = result.items.filter((item) => item.description.trim() !== "");
  ctx.db.replaceItems(
    enquiry.id,
    items.map((item) => ({ description: item.description.trim(), quantity: item.quantity, unit: item.unit })),
  );
  const missingQuantity = items.some((item) => item.quantity <= 0);
  const questions = [...result.missing_questions, ...(await whichOne(ctx, customer, messages, items))];
  if (missingQuantity && questions.length === 0) questions.push("How many of each item do you need?");
  return { items, missing_questions: questions };
}
