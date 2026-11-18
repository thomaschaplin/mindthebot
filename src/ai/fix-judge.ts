import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { hunksNear } from "../classify/patch.ts";
import type { Cache } from "../collect/cache.ts";
import type { Finding } from "../types.ts";
import { askClaude, clip, DEFAULT_AI_MODEL, describeError, isFatal, resolveModel } from "./claude.ts";

/**
 * Whether the code that changed near an AI review comment actually dealt with it.
 *
 * - fixed:     the change resolves the issue the comment raised
 * - partly:    the change addresses some of it, or a weaker version of the fix
 * - unrelated: the change near the comment does something else
 * - unclear:   the diff doesn't show enough to tell
 */
export const FIX_VERDICTS = ["fixed", "partly", "unrelated", "unclear"] as const;
export type FixVerdictLabel = (typeof FIX_VERDICTS)[number];

export interface FixVerdict {
  verdict: FixVerdictLabel;
  /** One short sentence from the model explaining the verdict. */
  reason: string;
  model: string;
}

/** Decides whether a nearby change fixed a finding. Returns null when it can't, so the proximity rule stands. */
export interface FixJudge {
  judge(finding: Finding, patches: string[]): Promise<FixVerdict | null>;
}

const VerdictSchema = z.object({
  verdict: z.enum(FIX_VERDICTS),
  reason: z.string(),
});

/** Lines either side of the comment whose hunks count as "near" it. */
const HUNK_MARGIN = 10;
const MAX_COMMENT_CHARS = 4000;
const MAX_NEAR_CHARS = 8000;
const MAX_OTHER_CHARS = 8000;

const SYSTEM_PROMPT = `You check whether code changes dealt with an AI code reviewer's comment on a GitHub pull request.

You get the reviewer's comment, the file and line it was about, and every change made to that file after the comment, in unified diff format ("-" lines are the code the reviewer saw, "+" lines are what replaced it). Changes near the commented line come first; other changes to the same file follow, because a fix often lands elsewhere in the file, such as in a helper the commented code calls.

Decide what the changes did about the comment:
- fixed: they resolve the issue the comment raised, whether or not they follow the reviewer's suggested fix.
- partly: they address part of the issue, or only some of the cases the comment described.
- unrelated: none of the changes to this file deal with the issue; it is left as it was in this file.
- unclear: the changes don't show enough to tell, for example the fix depends on code in another file.

Judge from the code, not from how confident the comment sounds. A comment can be wrong; if the code was changed to resolve what it described, that still counts as fixed. Give a reason of at most 25 words.`;

/** Join whole hunks up to `max` characters, noting how many were left out. */
function joinHunks(hunks: string[], max: number): string {
  const kept: string[] = [];
  let size = 0;
  for (const hunk of hunks) {
    if (kept.length > 0 && size + hunk.length > max) break;
    kept.push(hunk.length > max ? clip(hunk, max) : hunk);
    size += hunk.length;
  }
  const left = hunks.length - kept.length;
  return left > 0 ? `${kept.join("\n")}\n[${left} more hunk${left === 1 ? "" : "s"} not shown]` : kept.join("\n");
}

/**
 * The user message for one finding: the comment, the hunks near its line, and
 * every other later change to the same file. Null when nothing changed near
 * the line, since then there's no nearby change to judge. Exported for tests.
 */
export function fixPrompt(finding: Finding, patches: string[]): string | null {
  if (!finding.path || !finding.line) return null;
  const near = patches.flatMap((p) => hunksNear(p, finding.line!, finding.endLine, HUNK_MARGIN));
  if (near.length === 0) return null;
  const nearSet = new Set(near);
  const other = patches.flatMap((p) => hunksNear(p, 1, null, Number.MAX_SAFE_INTEGER)).filter((h) => !nearSet.has(h));
  const lines = finding.endLine && finding.endLine !== finding.line ? `${finding.line}-${finding.endLine}` : `${finding.line}`;
  return [
    `<review_comment reviewer="${finding.bot}" path="${finding.path}" lines="${lines}">`,
    clip(finding.body, MAX_COMMENT_CHARS),
    "</review_comment>",
    "",
    `<changes_near_comment path="${finding.path}">`,
    joinHunks(near, MAX_NEAR_CHARS),
    "</changes_near_comment>",
    ...(other.length > 0
      ? ["", `<other_changes_to_file path="${finding.path}">`, joinHunks(other, MAX_OTHER_CHARS), "</other_changes_to_file>"]
      : []),
  ].join("\n");
}

/**
 * Fix verdicts from Claude, with structured output. Cached by comment, diff
 * and model, so a re-run only pays for new findings.
 */
export class ClaudeFixJudge implements FixJudge {
  private readonly client: Anthropic;
  private readonly cache: Cache;
  private readonly model: string;
  private readonly warn: (message: string) => void;
  /** Requests made (cache misses), for the run summary. */
  calls = 0;

  constructor(options: { cache: Cache; model?: string; client?: Anthropic; warn?: (message: string) => void }) {
    this.client = options.client ?? new Anthropic();
    this.cache = options.cache;
    this.model = resolveModel(options.model ?? DEFAULT_AI_MODEL);
    this.warn = options.warn ?? (() => {});
  }

  async judge(finding: Finding, patches: string[]): Promise<FixVerdict | null> {
    const prompt = fixPrompt(finding, patches);
    if (!prompt) return null;
    const key = ["fix-judge-v2", this.model, SYSTEM_PROMPT, prompt];
    try {
      return await this.cache.wrap(key, () => {
        this.calls += 1;
        return askClaude(this.client, { model: this.model, effort: "medium", system: SYSTEM_PROMPT, prompt, schema: VerdictSchema });
      });
    } catch (error) {
      if (isFatal(error)) throw new Error(`--ai can't reach Claude: ${describeError(error)}`);
      this.warn(`fix check for ${finding.url} failed, keeping the proximity rule: ${describeError(error)}`);
      return null;
    }
  }
}
