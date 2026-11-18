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
  it("puts the nearby hunks first and the rest of the file's changes after", () => {
    const prompt = fixPrompt(makeFinding(), [PATCH])!;
    expect(prompt).toContain('<review_comment reviewer="Claude" path="src/users.ts" lines="40">');
    const near = prompt.slice(prompt.indexOf("<changes_near_comment"), prompt.indexOf("</changes_near_comment>"));
    const other = prompt.slice(prompt.indexOf("<other_changes_to_file"), prompt.indexOf("</other_changes_to_file>"));
    expect(near).toContain("+  if (!user) return null;");
    expect(near).not.toContain("return x + 1");
    expect(other).toContain("+return x + 1;");
    expect(other).not.toContain("if (!user)");
  });

  it("includes changes from every later patch, and leaves the other section out when there are none", () => {
    const later = "@@ -90,1 +90,1 @@\n-old\n+new";
    expect(fixPrompt(makeFinding(), [PATCH, later])).toContain("+new");
    const onlyNear = "@@ -40,1 +40,1 @@\n-a\n+b";
    expect(fixPrompt(makeFinding(), [onlyNear])).not.toContain("<other_changes_to_file");
  });

  it("caps very long diffs by whole hunks and says how many were left out", () => {
    const many = Array.from({ length: 400 }, (_, i) => `@@ -${200 + i * 5},1 +${200 + i * 5},1 @@\n-line ${i} ${"x".repeat(40)}\n+line ${i}`).join("\n");
    const prompt = fixPrompt(makeFinding(), [PATCH, many])!;
    expect(prompt).toMatch(/\[\d+ more hunks not shown\]/);
    expect(prompt.length).toBeLessThan(20000);
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

  it("an unrelated change on a resolved thread is acknowledged, not dismissed: the fix may be in another file", () => {
    const result = classify(makeFinding({ isResolved: true }), changes, defaultConfig, null, verdict("unrelated"));
    expect(result.outcome).toBe("acknowledged");
    expect(result.reason).toMatch(/another file/);
  });

  it("a resolved thread with no nearby change at all is still a dismissal", () => {
    expect(classify(makeFinding({ isResolved: true }), {}, defaultConfig).outcome).toBe("dismissed");
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
    expect(requests[0]).toMatchObject({ model: "claude-haiku-5-5", output_config: { effort: "medium" } });
    expect(requests[0]).not.toHaveProperty("fallbacks");
  });

  it("sends server-side fallbacks for models that support them", async () => {
    const { client, requests } = fakeClient({ verdict: "fixed", reason: "ok" });
    const judge = new ClaudeFixJudge({ cache: new Cache(cacheDir, false), client, model: "claude-opus-5-5" });
    await judge.judge(makeFinding({ commentId: 11 }), [PATCH]);
    expect(requests[0]).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
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
