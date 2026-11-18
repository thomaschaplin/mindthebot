import type { Config } from "../config.ts";
import type { FixVerdict } from "../ai/fix-judge.ts";
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

/** True when code within `proximity` lines of the finding changed afterwards (rule 1, before any AI verdict). */
export function hasNearbyChange(finding: Finding, changes: ChangedLines | null | undefined, config: Config): boolean {
  const fileLines = finding.path && changes ? changes[resolvePath(finding.path, changes)] : undefined;
  return Array.isArray(fileLines) && finding.line !== null && isNear(fileLines, finding.line, config.proximity, finding.endLine);
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
 *
 * `fix`, when given (also --ai), is the model's verdict on the later changes to the
 * file. "unrelated" cancels rule 1, so the finding falls through to the rules below
 * it; "fixed", "partly" and "unclear" keep rule 1. A human reply saying it was fixed
 * still counts under rule 2, and a resolved thread counts as acknowledged rather
 * than dismissed, since the fix may be in another file.
 */
export function classify(
  finding: Finding,
  changes: ChangedLines | null | undefined,
  config: Config,
  intent?: ReplyIntent | null,
  fix?: FixVerdict | null,
): ClassifiedFinding {
  const notes = [
    ...(intent ? [`AI read the replies as "${intent.intent}": ${intent.reason}`] : []),
    ...(fix ? [`AI judged the nearby change "${fix.verdict}": ${fix.reason}`] : []),
  ];
  const result = (outcome: ClassifiedFinding["outcome"], reason: string): ClassifiedFinding => ({
    ...finding,
    outcome,
    reason: notes.length > 0 ? `${reason} (${notes.join("; ")})` : reason,
    ...(intent ? { replyIntent: intent } : {}),
    ...(fix ? { fixVerdict: fix } : {}),
  });

  const fileLines = finding.path && changes ? changes[resolvePath(finding.path, changes)] : undefined;
  const fileChanged = fileLines !== undefined;
  const nearbyChange =
    Array.isArray(fileLines) &&
    finding.line !== null &&
    isNear(fileLines, finding.line, config.proximity, finding.endLine) &&
    fix?.verdict !== "unrelated";

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
  if (finding.isResolved && fix?.verdict === "unrelated") {
    // Someone resolved it after changing the file. The AI found no fix in this file,
    // but it may be in another one, so this isn't a dismissal.
    return result("acknowledged", "thread resolved after changes the AI judged unrelated; the fix may be in another file");
  }
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
