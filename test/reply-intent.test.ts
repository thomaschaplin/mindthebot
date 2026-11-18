import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  ClaudeReplyJudge,
  judgeReplies,
  replyPrompt,
  type ReplyIntent,
  type ReplyJudge,
} from "../src/ai/reply-intent.ts";
import { classify } from "../src/classify/rules.ts";
import { Cache } from "../src/collect/cache.ts";
import { defaultConfig } from "../src/config.ts";
import { makeFinding, reply } from "./helpers.ts";

const intent = (label: ReplyIntent["intent"]): ReplyIntent => ({ intent: label, reason: "test", model: "claude-opus-5-5" });

describe("classify with AI reply intent", () => {
  it("reads a dismissal the phrase list misses", () => {
    const finding = makeFinding({ replies: [reply("nah, that's how the upstream API behaves")] });
    expect(classify(finding, {}, defaultConfig).outcome).toBe("acknowledged");
    const result = classify(finding, {}, defaultConfig, intent("disagrees"));
    expect(result.outcome).toBe("dismissed");
    expect(result.reason).toMatch(/AI read the replies as "disagrees"/);
    expect(result.replyIntent?.intent).toBe("disagrees");
  });

  it("a fixed reply plus a change to the file is addressed", () => {
    const finding = makeFinding({ replies: [reply("sorted in the next commit")] });
    expect(classify(finding, { "src/users.ts": [200] }, defaultConfig, intent("fixed")).outcome).toBe("addressed");
  });

  it("will-fix, acknowledged and question fall through to acknowledged", () => {
    const finding = makeFinding({ replies: [reply("tracked in #12")] });
    for (const label of ["will-fix", "acknowledged", "question", "unclear"] as const) {
      expect(classify(finding, {}, defaultConfig, intent(label)).outcome).toBe("acknowledged");
    }
  });

  it("overrides a phrase match the replies don't mean", () => {
    // "intentional" is a dismissal phrase, but the reply says it was fixed.
    const finding = makeFinding({ replies: [reply("Not intentional, good catch - fixed")] });
    expect(classify(finding, { "src/users.ts": [200] }, defaultConfig, intent("fixed")).outcome).toBe("addressed");
  });

  it("a nearby change still wins over the replies, as without AI", () => {
    const finding = makeFinding({ replies: [reply("hmm, will check")] });
    expect(classify(finding, { "src/users.ts": [41] }, defaultConfig, intent("question")).outcome).toBe("addressed");
  });
});

describe("judgeReplies", () => {
  it("only asks about inline findings with replies", async () => {
    const asked: number[] = [];
    const judge: ReplyJudge = {
      judge: async (f) => {
        asked.push(f.commentId);
        return intent("acknowledged");
      },
    };
    const findings = [
      makeFinding({ commentId: 1, replies: [reply("ok")] }),
      makeFinding({ commentId: 2 }),
      makeFinding({ commentId: 3, source: "summary", replies: [reply("ok")] }),
      makeFinding({ commentId: 4, replies: [reply("ok")] }),
    ];
    const results = await judgeReplies(judge, findings);
    expect(asked.sort()).toEqual([1, 4]);
    expect([...results.keys()].sort()).toEqual([1, 4]);
  });
});

describe("replyPrompt", () => {
  it("includes the comment and every reply in order", () => {
    const prompt = replyPrompt(makeFinding({ replies: [reply("first"), reply("second")] }));
    expect(prompt).toContain('<review_comment reviewer="Claude" path="src/users.ts">');
    expect(prompt.indexOf("first")).toBeLessThan(prompt.indexOf("second"));
  });
});

/** A stand-in for the SDK client: records requests and returns a canned parse result. */
function fakeClient(response: Record<string, unknown>) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          requests.push(params);
          return { model: "claude-opus-5-5", stop_reason: "end_turn", ...response };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

describe("ClaudeReplyJudge", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "mindthebot-test-"));

  it("asks once per thread and caches the answer", async () => {
    const { client, requests } = fakeClient({ parsed_output: { intent: "will-fix", reason: "Follow-up PR promised." } });
    const judge = new ClaudeReplyJudge({ cache: new Cache(cacheDir, true), client });
    const finding = makeFinding({ commentId: 7, replies: [reply("Will do this in a follow-up PR")] });

    expect(await judge.judge(finding)).toEqual({ intent: "will-fix", reason: "Follow-up PR promised.", model: "claude-opus-5-5" });
    expect(await judge.judge(finding)).toEqual({ intent: "will-fix", reason: "Follow-up PR promised.", model: "claude-opus-5-5" });
    expect(judge.calls).toBe(1);
    expect(requests[0]).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", output_config: { effort: "low" } });
  });

  it("skips findings with no replies", async () => {
    const { client, requests } = fakeClient({ parsed_output: { intent: "fixed", reason: "" } });
    const judge = new ClaudeReplyJudge({ cache: new Cache(cacheDir, true), client });
    expect(await judge.judge(makeFinding())).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("returns null on a refusal, warns, and doesn't cache it", async () => {
    const warnings: string[] = [];
    const { client } = fakeClient({ stop_reason: "refusal", parsed_output: null });
    const judge = new ClaudeReplyJudge({ cache: new Cache(cacheDir, true), client, warn: (m) => warnings.push(m) });
    const finding = makeFinding({ commentId: 8, replies: [reply("hm")] });
    expect(await judge.judge(finding)).toBeNull();
    expect(await judge.judge(finding)).toBeNull();
    expect(judge.calls).toBe(2);
    expect(warnings[0]).toMatch(/declined/);
  });

  it("stops the run when there are no credentials, instead of warning per thread", async () => {
    const client = {
      beta: { messages: { parse: async () => { throw new Error("Could not resolve authentication method."); } } },
    } as unknown as Anthropic;
    const judge = new ClaudeReplyJudge({ cache: new Cache(cacheDir, false), client });
    await expect(judge.judge(makeFinding({ replies: [reply("ok")] }))).rejects.toThrow(/can't reach Claude/);
  });
});
