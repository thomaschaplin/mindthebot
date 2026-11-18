import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { askClaude, resolveModel } from "../src/ai/claude.ts";

describe("resolveModel", () => {
  it("maps each alias to the newest model of its family", () => {
    expect(resolveModel("haiku")).toBe("claude-haiku-5-5");
    expect(resolveModel("sonnet")).toBe("claude-sonnet-5-5");
    expect(resolveModel("Opus")).toBe("claude-opus-5-5");
    expect(resolveModel(" fable ")).toBe("claude-fable-5-2");
  });

  it("passes full model IDs through", () => {
    expect(resolveModel("claude-opus-5")).toBe("claude-opus-5");
  });

  it("rejects anything else, naming the choices", () => {
    expect(() => resolveModel("gpt-5")).toThrow(/haiku, sonnet, opus, fable/);
  });
});

describe("askClaude fallbacks", () => {
  async function requestFor(model: string) {
    let sent: Record<string, unknown> = {};
    const client = {
      beta: {
        messages: {
          parse: async (params: Record<string, unknown>) => {
            sent = params;
            return { model, stop_reason: "end_turn", parsed_output: { ok: true } };
          },
        },
      },
    } as unknown as Anthropic;
    await askClaude(client, { model, effort: "low", system: "s", prompt: "p", schema: z.object({ ok: z.boolean() }) });
    return sent;
  }

  it("sends server-side fallbacks to Sonnet, Opus and Fable", async () => {
    for (const alias of ["sonnet", "opus", "fable"]) {
      expect(await requestFor(resolveModel(alias))).toMatchObject({
        fallbacks: "default",
        betas: ["server-side-fallback-2026-07-01"],
      });
    }
  });

  it("leaves them out for Haiku and for IDs it doesn't know", async () => {
    expect(await requestFor("claude-haiku-5-5")).not.toHaveProperty("fallbacks");
    expect(await requestFor("claude-some-future-model")).not.toHaveProperty("betas");
  });
});
