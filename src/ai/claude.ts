import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export const DEFAULT_AI_MODEL = "claude-opus-5-5";

/**
 * One structured-output request to Claude. Server-side fallbacks re-run a
 * declined request on another model. Throws on a refusal or a missing parse,
 * so callers never cache a non-answer.
 */
export async function askClaude<T extends z.ZodType<Record<string, unknown>>>(
  client: Anthropic,
  options: { model: string; effort: "low" | "medium" | "high"; system: string; prompt: string; schema: T },
): Promise<z.infer<T> & { model: string }> {
  const response = await client.beta.messages.parse({
    model: options.model,
    max_tokens: 8192,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: options.effort, format: zodOutputFormat(options.schema) },
    system: options.system,
    messages: [{ role: "user", content: options.prompt }],
  });
  if (response.stop_reason === "refusal") throw new Error("the model declined");
  if (!response.parsed_output) throw new Error(`no structured output (stop reason: ${response.stop_reason})`);
  return { ...(response.parsed_output as z.infer<T>), model: response.model };
}

/** Missing or bad credentials affect every request, so the run should stop rather than warn per finding. */
export function isFatal(error: unknown): boolean {
  return (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError ||
    (!(error instanceof Anthropic.APIError) && /authentication/i.test(String(error)))
  );
}

export const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[…cut]` : text);

/** Run `work` over `items`, a few at a time. */
export async function eachLimited<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}
