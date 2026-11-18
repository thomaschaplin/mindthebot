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

/** Lines either side of the comment whose hunks are shown to the model. */
const HUNK_MARGIN = 10;
const MAX_COMMENT_CHARS = 4000;
const MAX_DIFF_CHARS = 8000;

const SYSTEM_PROMPT = `You check whether a code change dealt with an AI code reviewer's comment on a GitHub pull request.

You get the reviewer's comment, the file and line it was about, and the diff hunks made near that line after the comment (in unified diff format; "-" lines are the code the reviewer saw, "+" lines are what replaced it).

Decide what the change did about the comment:
- fixed: the change resolves the issue the comment raised, whether or not it follows the reviewer's suggested fix.
- partly: the change addresses part of the issue, or only some of the cases the comment described.
- unrelated: the change near the comment does something else and leaves the issue as it was.
- unclear: the hunks don't show enough to tell, for example the fix depends on code outside them.

Judge from the code, not from how confident the comment sounds. A comment can be wrong; if the code was changed to resolve what it described, that still counts as fixed. Give a reason of at most 25 words.`;

/** The user message for one finding, or null when no hunk is near its line. Exported for tests. */
export function fixPrompt(finding: Finding, patches: string[]): string | null {
  if (!finding.path || !finding.line) return null;
  const hunks = patches.flatMap((p) => hunksNear(p, finding.line!, finding.endLine, HUNK_MARGIN));
  if (hunks.length === 0) return null;
  const lines = finding.endLine && finding.endLine !== finding.line ? `${finding.line}-${finding.endLine}` : `${finding.line}`;
  return [
    `<review_comment reviewer="${finding.bot}" path="${finding.path}" lines="${lines}">`,
    clip(finding.body, MAX_COMMENT_CHARS),
    "</review_comment>",
    "",
    `<diff_after_comment path="${finding.path}">`,
    clip(hunks.join("\n"), MAX_DIFF_CHARS),
    "</diff_after_comment>",
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
    const key = ["fix-judge-v1", this.model, SYSTEM_PROMPT, prompt];
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
