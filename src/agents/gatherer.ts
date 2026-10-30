import { z } from "zod";
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
  const questions = [...result.missing_questions];
  if (missingQuantity && questions.length === 0) questions.push("How many of each item do you need?");
  return { items, missing_questions: questions };
}
