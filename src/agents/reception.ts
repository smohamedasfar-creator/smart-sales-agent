import type { Customer, Enquiry } from "../db.js";
import { transcript, UNTRUSTED_NOTE, type AgentContext } from "./context.js";

// WhatsApp Reception agent: writes every conversational reply to the customer,
// in the business's tone and the customer's language.

function system(ctx: AgentContext): string {
  const settings = ctx.db.getSettings();
  return `You are the WhatsApp sales assistant for ${settings.businessName}.
Tone: ${settings.tone}
${settings.businessInfo ? `About the business (use when relevant):\n${settings.businessInfo}\n` : ""}
Rules:
- Reply in the customer's language. Keep it short, like a WhatsApp message from a helpful salesperson.
- Never state a price, stock level, discount or delivery date unless it appears in the facts you are given. If asked, say we will confirm.
- Do not promise anything the facts do not support. If you cannot help, say the team will reply soon.
- Write only the message text, with no notes or explanations.
${UNTRUSTED_NOTE}`;
}

/** Writes a reply. `task` tells the agent what this reply must do; `facts` are things it may state. */
export async function writeReply(
  ctx: AgentContext,
  customer: Customer,
  enquiry: Enquiry | null,
  task: string,
  facts = "",
): Promise<string> {
  const messages = ctx.db.recentMessages(customer.id, 20);
  const status = enquiry ? `Current enquiry status: ${enquiry.status}${enquiry.quote_ref ? `, quote ${enquiry.quote_ref}` : ""}.` : "";
  return ctx.llm.text({
    agent: "reception",
    system: system(ctx),
    prompt: `${transcript(messages, customer)}\n\n${status}\n${facts ? `<facts>\n${facts}\n</facts>\n` : ""}\nYour task: ${task}`,
    effort: "low",
  });
}
