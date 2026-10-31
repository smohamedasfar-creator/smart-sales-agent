import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

// Every agent talks to Claude through this small interface, so tests can swap in
// a scripted fake and the agents never depend on the SDK directly.

export type Effort = "low" | "medium" | "high";

export interface LlmRequest {
  /** Which agent is asking; used for logs and by the test fake. */
  agent: string;
  system: string;
  prompt: string;
  effort?: Effort;
}

export interface Llm {
  /** Returns an answer that matches the schema. */
  json<T>(request: LlmRequest & { schema: z.ZodType<T> }): Promise<T>;
  /** Returns plain text, such as a message to send. */
  text(request: LlmRequest): Promise<string>;
}

export class LlmRefusalError extends Error {}

export class ClaudeLlm implements Llm {
  // A slow or rate-limited call fails within two minutes instead of hanging the chat; the SDK waits out
  // "please slow down" (429) answers before retrying, which new accounts with low limits get often.
  private readonly client = new Anthropic({ timeout: 120_000, maxRetries: 5 });

  constructor(private readonly model: string) {}

  private base(request: LlmRequest) {
    return {
      model: this.model,
      // The answers are short (a label, an item list, a WhatsApp reply). A smaller ceiling keeps each call
      // inside a new account's output-tokens-per-minute limit, which counts max_tokens up front.
      max_tokens: 8000,
      // If the model declines a request, the API retries it on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default" as const,
      system: [{ type: "text" as const, text: request.system, cache_control: { type: "ephemeral" as const } }],
      messages: [{ role: "user" as const, content: request.prompt }],
    };
  }

  async json<T>(request: LlmRequest & { schema: z.ZodType<T> }): Promise<T> {
    const response = await this.client.beta.messages.parse({
      ...this.base(request),
      output_config: { effort: request.effort ?? "medium", format: betaZodOutputFormat(request.schema) },
    });
    if (response.stop_reason === "refusal") throw new LlmRefusalError(`${request.agent}: request declined`);
    if (response.parsed_output == null) throw new Error(`${request.agent}: answer did not match the expected format`);
    return response.parsed_output as T;
  }

  async text(request: LlmRequest): Promise<string> {
    const response = await this.client.beta.messages.create({
      ...this.base(request),
      output_config: { effort: request.effort ?? "low" },
    });
    if (response.stop_reason === "refusal") throw new LlmRefusalError(`${request.agent}: request declined`);
    return response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();
  }
}
