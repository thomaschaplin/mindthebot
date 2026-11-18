import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Cache } from "../collect/cache.ts";
import type { Finding } from "../types.ts";
import { askClaude, clip, DEFAULT_AI_MODEL, describeError, eachLimited, isFatal, resolveModel } from "./claude.ts";

export { DEFAULT_AI_MODEL };

/**
 * What the people who replied to an AI review comment meant, as a whole thread.
 *
 * - fixed:        says it's been fixed in this PR, or that the fix is going into this PR's next push
 * - will-fix:     agrees and plans to fix it outside this PR ("follow-up PR", "tracked in #12")
 * - disagrees:    rejects it: false positive, intentional, out of scope, won't fix
 * - acknowledged: accepts or confirms it, with no commitment either way ("confirmed, leaving open")
 * - question:     asks the reviewer or the author something, or discusses without a decision
 * - unclear:      none of the above can be told from the text
 */
export const REPLY_INTENTS = ["fixed", "will-fix", "disagrees", "acknowledged", "question", "unclear"] as const;
export type ReplyIntentLabel = (typeof REPLY_INTENTS)[number];

export interface ReplyIntent {
  intent: ReplyIntentLabel;
  /** One short sentence from the model explaining the label. */
  reason: string;
  /** Model that decided it, recorded with each finding. */
  model: string;
}

/** Decides reply intent for a finding. Returns null when it can't (refusal, error), so the phrase rules apply instead. */
export interface ReplyJudge {
  judge(finding: Finding): Promise<ReplyIntent | null>;
}

const IntentSchema = z.object({
  intent: z.enum(REPLY_INTENTS),
  reason: z.string(),
});

/** Keep prompts small: the reviewer's comment rarely needs more than this to understand the replies. */
const MAX_COMMENT_CHARS = 3000;
const MAX_REPLY_CHARS = 1500;

const SYSTEM_PROMPT = `You label how people responded to an AI code reviewer's comment on a GitHub pull request.

You get the reviewer's comment and the human replies in its thread, oldest first. Decide what the replies, taken together, say happened to the comment. The latest decision wins: if someone first asks a question and later says it's fixed, the answer is "fixed".

Labels:
- fixed: a reply says the issue was fixed or the code was changed for it in this pull request, including a fix the author says is in, or about to go into, this PR's next push or commit ("fixing this in the next push", "the commit I'm about to push does X").
- will-fix: a reply agrees and commits to fixing it outside this pull request: a follow-up PR, an issue, a later release.
- disagrees: a reply rejects the comment: false positive, intentional, by design, out of scope, won't fix, not worth it.
- acknowledged: a reply accepts or confirms the point without saying it was fixed, will be fixed, or won't be ("confirmed", "good point", "leaving this open for the author").
- question: the replies only ask questions or discuss, with no decision.
- unclear: the replies don't say enough to tell.

Judge only from the text. Don't guess whether the code changed. Give a reason of at most 20 words.`;

/** The user message for one finding. Exported for tests. */
export function replyPrompt(finding: Finding): string {
  const replies = finding.replies
    .map((r, i) => `<reply index="${i + 1}" author="${r.author}">\n${clip(r.body, MAX_REPLY_CHARS)}\n</reply>`)
    .join("\n");
  return `<review_comment reviewer="${finding.bot}" path="${finding.path ?? ""}">\n${clip(finding.body, MAX_COMMENT_CHARS)}\n</review_comment>\n\n${replies}`;
}

/**
 * Reply intent from Claude, with structured output so the label is always one
 * of REPLY_INTENTS. Results are cached by comment, replies and model, so a
 * re-run only pays for new or changed threads.
 */
export class ClaudeReplyJudge implements ReplyJudge {
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

  async judge(finding: Finding): Promise<ReplyIntent | null> {
    if (finding.replies.length === 0) return null;
    const prompt = replyPrompt(finding);
    const key = ["reply-intent-v2", this.model, SYSTEM_PROMPT, prompt];
    try {
      return await this.cache.wrap(key, () => {
        this.calls += 1;
        return askClaude(this.client, { model: this.model, effort: "low", system: SYSTEM_PROMPT, prompt, schema: IntentSchema });
      });
    } catch (error) {
      if (isFatal(error)) throw new Error(`--ai can't reach Claude: ${describeError(error)}`);
      this.warn(`reply intent for ${finding.url} failed, using phrase rules: ${describeError(error)}`);
      return null;
    }
  }
}

/** Run judge over findings with replies, a few at a time. */
export async function judgeReplies(
  judge: ReplyJudge,
  findings: Finding[],
  concurrency = 4,
): Promise<Map<number, ReplyIntent>> {
  const results = new Map<number, ReplyIntent>();
  await eachLimited(
    findings.filter((f) => f.source === "inline" && f.replies.length > 0),
    concurrency,
    async (f) => {
      const intent = await judge.judge(f);
      if (intent) results.set(f.commentId, intent);
    },
  );
  return results;
}
