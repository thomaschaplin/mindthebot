import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ClaudeFixJudge, fixPrompt, type FixVerdict } from "../src/ai/fix-judge.ts";
import { hunksNear } from "../src/classify/patch.ts";
import { classify, hasNearbyChange } from "../src/classify/rules.ts";
import { Cache } from "../src/collect/cache.ts";
import { patchesFor } from "../src/collect/changes.ts";
import { defaultConfig } from "../src/config.ts";
import { makeFinding, reply } from "./helpers.ts";

const PATCH = [
  "@@ -5,3 +5,3 @@ function a() {",
  " const x = 1;",
  "-return x;",
  "+return x + 1;",
  " }",
  "@@ -40,3 +40,4 @@ function load(user) {",
  "-  return user.name;",
  "+  if (!user) return null;",
  "+  return user.name;",
  " }",
].join("\n");

const verdict = (v: FixVerdict["verdict"]): FixVerdict => ({ verdict: v, reason: "test", model: "claude-opus-5-5" });

describe("hunksNear", () => {
  it("returns only the hunks around the commented line, with their headers", () => {
    const hunks = hunksNear(PATCH, 40, null, 10);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatch(/^@@ -40,3/);
    expect(hunks[0]).toContain("+  if (!user) return null;");
  });

  it("uses the margin and the end of a range", () => {
    expect(hunksNear(PATCH, 20, null, 10)).toHaveLength(0);
    expect(hunksNear(PATCH, 20, 38, 2)).toHaveLength(1);
    expect(hunksNear(PATCH, 1, null, 10)).toHaveLength(1);
  });
});

describe("patchesFor", () => {
  it("collects every patch for a file, following renames", () => {
    const files = [
      { filename: "src/users.ts", patch: "p1" },
      { filename: "src/other.ts", patch: "x" },
      { filename: "src/people.ts", previous_filename: "src/users.ts", patch: "p2" },
      { filename: "src/people.ts", patch: "p3" },
    ];
    expect(patchesFor(files, "src/users.ts")).toEqual(["p1", "p2", "p3"]);
  });
});

describe("fixPrompt", () => {
  it("includes the comment and the nearby hunks", () => {
    const prompt = fixPrompt(makeFinding(), [PATCH])!;
    expect(prompt).toContain('<review_comment reviewer="Claude" path="src/users.ts" lines="40">');
    expect(prompt).toContain("+  if (!user) return null;");
    expect(prompt).not.toContain("return x + 1");
  });

  it("is null when nothing changed near the line", () => {
    expect(fixPrompt(makeFinding({ line: 200 }), [PATCH])).toBeNull();
    expect(fixPrompt(makeFinding({ line: null }), [PATCH])).toBeNull();
  });
});

describe("classify with an AI fix verdict", () => {
  const changes = { "src/users.ts": [40, 41] };

  it("an unrelated nearby change no longer counts as addressed", () => {
    expect(hasNearbyChange(makeFinding(), changes, defaultConfig)).toBe(true);
    const result = classify(makeFinding(), changes, defaultConfig, null, verdict("unrelated"));
    expect(result.outcome).toBe("ignored");
    expect(result.reason).toMatch(/AI judged the nearby change "unrelated"/);
    expect(result.fixVerdict?.verdict).toBe("unrelated");
  });

  it("fixed, partly and unclear keep it addressed", () => {
    for (const v of ["fixed", "partly", "unclear"] as const) {
      expect(classify(makeFinding(), changes, defaultConfig, null, verdict(v)).outcome).toBe("addressed");
    }
  });

  it("a human saying it was fixed still counts, even if the AI calls the nearby change unrelated", () => {
    const finding = makeFinding({ replies: [reply("Fixed in the next commit")] });
    expect(classify(finding, changes, defaultConfig, null, verdict("unrelated")).outcome).toBe("addressed");
  });

  it("an unrelated change on a resolved thread is a dismissal", () => {
    expect(classify(makeFinding({ isResolved: true }), changes, defaultConfig, null, verdict("unrelated")).outcome).toBe("dismissed");
  });

  it("a summary item with an unrelated change is not addressed", () => {
    const finding = makeFinding({ source: "summary" });
    expect(classify(finding, changes, defaultConfig, null, verdict("unrelated")).outcome).toBe("not-addressed");
  });
});

describe("ClaudeFixJudge", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "mindthebot-fix-"));

  function fakeClient(parsed: unknown) {
    const requests: Record<string, unknown>[] = [];
    const client = {
      beta: {
        messages: {
          parse: async (params: Record<string, unknown>) => {
            requests.push(params);
            return { model: "claude-opus-5-5", stop_reason: "end_turn", parsed_output: parsed };
          },
        },
      },
    } as unknown as Anthropic;
    return { client, requests };
  }

  it("asks once per finding and diff, at medium effort, and caches the verdict", async () => {
    const { client, requests } = fakeClient({ verdict: "fixed", reason: "Adds the null check the comment asked for." });
    const judge = new ClaudeFixJudge({ cache: new Cache(cacheDir, true), client });
    const expected = { verdict: "fixed", reason: "Adds the null check the comment asked for.", model: "claude-opus-5-5" };
    expect(await judge.judge(makeFinding(), [PATCH])).toEqual(expected);
    expect(await judge.judge(makeFinding(), [PATCH])).toEqual(expected);
    expect(judge.calls).toBe(1);
    expect(requests[0]).toMatchObject({ fallbacks: "default", output_config: { effort: "medium" } });
  });

  it("doesn't call Claude when no hunk is near the line", async () => {
    const { client, requests } = fakeClient({ verdict: "fixed", reason: "" });
    const judge = new ClaudeFixJudge({ cache: new Cache(cacheDir, true), client });
    expect(await judge.judge(makeFinding({ line: 300 }), [PATCH])).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("keeps the proximity rule when a request fails", async () => {
    const warnings: string[] = [];
    const client = {
      beta: { messages: { parse: async () => ({ model: "m", stop_reason: "max_tokens", parsed_output: null }) } },
    } as unknown as Anthropic;
    const judge = new ClaudeFixJudge({ cache: new Cache(cacheDir, true), client, warn: (m) => warnings.push(m) });
    expect(await judge.judge(makeFinding({ commentId: 9, body: "different" }), [PATCH])).toBeNull();
    expect(warnings[0]).toMatch(/keeping the proximity rule/);
  });
});
