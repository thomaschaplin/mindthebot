import type { Config } from "../config.ts";
import type { ReplyIntent } from "../ai/reply-intent.ts";
import type { ChangedLines, ClassifiedFinding, Finding } from "../types.ts";
import { isNear } from "./patch.ts";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Reviewers sometimes cite a path relative to a package, or just a filename
 * (`adapter.ts:103`). If there's no exact match, use the one changed file
 * whose path ends with it. Ambiguous matches are left unresolved.
 */
export function resolvePath(path: string, changes: ChangedLines): string {
  if (path in changes) return path;
  const candidates = Object.keys(changes).filter((p) => p.endsWith(`/${path}`));
  return candidates.length === 1 ? candidates[0]! : path;
}

/** True if any reply contains one of the phrases as whole words, case-insensitively. */
export function repliesMatch(finding: Finding, phrases: string[]): boolean {
  if (phrases.length === 0) return false;
  const pattern = new RegExp(`\\b(?:${phrases.map(escapeRegExp).join("|")})\\b`, "i");
  return finding.replies.some((r) => pattern.test(r.body));
}

/**
 * Decide what happened to one AI finding. The first matching rule wins:
 *
 * 0. dismissed: a person replied with a dismissal ("leaving as is") and never said it was fixed.
 *               An explicit human decision beats an unrelated nearby change.
 * 1. addressed: code within `proximity` lines of the comment changed afterwards
 * 2. addressed: a human said "fixed"/"good catch" or gave a 👍, and the file changed afterwards
 * 3. dismissed: a 👎, a dismissal reply, or the thread was resolved with no nearby change
 * 4. acknowledged: a person replied or gave a 👍, but nothing nearby changed and nobody dismissed it
 *                 (e.g. "Confirmed, leaving this open until the author decides")
 * 5. outdated:  GitHub marked the thread outdated, but no nearby change was found
 * 6. ignored:   no reply, reaction, resolution or nearby change
 *
 * Summary items (from a bot's summary comment) have no replies, reactions or
 * resolution, so they are either addressed by rule 1 or "not-addressed".
 *
 * `changes` is undefined when no diff was needed, and null when one couldn't be fetched.
 *
 * `intent`, when given (the --ai mode), replaces the phrase lists: "fixed" counts as a
 * fixed reply and "disagrees" as a dismissal; the other labels fall through to
 * acknowledged. The model's label and reason are added to the finding's reason.
 */
export function classify(
  finding: Finding,
  changes: ChangedLines | null | undefined,
  config: Config,
  intent?: ReplyIntent | null,
): ClassifiedFinding {
  const ai = intent ? ` (AI read the replies as "${intent.intent}": ${intent.reason})` : "";
  const result = (outcome: ClassifiedFinding["outcome"], reason: string): ClassifiedFinding => ({
    ...finding,
    outcome,
    reason: `${reason}${ai}`,
    ...(intent ? { replyIntent: intent } : {}),
  });

  const fileLines = finding.path && changes ? changes[resolvePath(finding.path, changes)] : undefined;
  const fileChanged = fileLines !== undefined;
  const nearbyChange =
    Array.isArray(fileLines) &&
    finding.line !== null &&
    isNear(fileLines, finding.line, config.proximity, finding.endLine);

  const saidDismissed = intent ? intent.intent === "disagrees" : repliesMatch(finding, config.dismissedPhrases);
  const saidFixed = intent ? intent.intent === "fixed" : repliesMatch(finding, config.addressedPhrases);
  if (saidDismissed && !saidFixed) return result("dismissed", "reply dismisses the finding");

  if (nearbyChange) {
    return finding.source === "summary"
      ? result(
          "addressed",
          finding.repeats > 0
            ? `code within ${config.proximity} lines changed after the last review that repeated it`
            : `code within ${config.proximity} lines changed after the summary item`,
        )
      : result("addressed", `code within ${config.proximity} lines changed after the comment`);
  }

  if (finding.source === "summary") {
    return result(
      "not-addressed",
      changes === null
        ? "summary item; no diff available to check"
        : "summary item; no nearby change (summaries have no replies or resolution, so dismissed and ignored look the same)",
    );
  }

  const saidAddressed = finding.reactions.up > 0 || saidFixed;
  if (saidAddressed && fileChanged) {
    return result("addressed", "reply or 👍 says addressed, and the file changed after the comment");
  }
  if (saidAddressed && changes === null) {
    return result("addressed", "reply or 👍 says addressed (no diff available to confirm)");
  }

  if (finding.reactions.down > 0) return result("dismissed", "👎 reaction");
  if (saidDismissed) return result("dismissed", "reply dismisses the finding");
  if (finding.isResolved) return result("dismissed", "thread resolved with no nearby code change");

  if (finding.replies.length > 0 || finding.reactions.up > 0) {
    return result(
      "acknowledged",
      finding.replies.length > 0 ? "a person replied, but no nearby change followed" : "👍 reaction, but no nearby change followed",
    );
  }

  if (finding.isOutdated) return result("outdated", "thread outdated, but no nearby change found");

  return result("ignored", "no reply, reaction, resolution or nearby change");
}
