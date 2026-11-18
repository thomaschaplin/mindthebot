import type { ClassifiedFinding, PullRequestRecord } from "../types.ts";
import { minutesBetween } from "../util/duration.ts";
import { median, percentile, ratio } from "../util/stats.ts";

export interface BotStats {
  bot: string;
  /** Repo name, or "*" for all repos combined. */
  repo: string;
  /** PRs where this bot left at least one comment of any kind. */
  prsReviewed: number;
  findings: number;
  /** Findings from inline review threads. */
  inlineFindings: number;
  /** Findings from file-and-line items in summary comments. */
  summaryFindings: number;
  addressed: number;
  dismissed: number;
  /** A person replied or reacted, but no change followed and nobody dismissed it. */
  acknowledged: number;
  ignored: number;
  outdated: number;
  /** Summary items with no nearby change (dismissed and ignored can't be told apart). */
  notAddressed: number;
  addressedRate: number;
  dismissedRate: number;
  acknowledgedRate: number;
  /** With --ai: nearby changes the model checked, and how it judged them. */
  aiChecked: number;
  aiFixed: number;
  aiPartly: number;
  aiUnrelated: number;
  ignoredRate: number;
  notAddressedRate: number;
  findingsPerPr: number;
  summaryComments: number;
  /** Median minutes from PR opened to this bot's first comment. */
  medianFirstCommentMinutes: number | null;
}

export interface MergeTimes {
  prs: number;
  medianHours: number | null;
  p75Hours: number | null;
}

export interface SeverityStats {
  bot: string;
  severity: string;
  findings: number;
  addressed: number;
  addressedRate: number;
}

export interface IgnoredFile {
  repo: string;
  path: string;
  /** Findings in this file that were ignored or not addressed. */
  ignored: number;
  /** All findings in this file, whatever the outcome. */
  findings: number;
  /** The ignored findings, newest first, up to MAX_ITEMS_PER_FILE. */
  items: ClassifiedFinding[];
}

const MAX_ITEMS_PER_FILE = 5;

/** True when nobody acted on a finding: no change, no reply, no reaction. */
export const isIgnored = (f: ClassifiedFinding) => f.outcome === "ignored" || f.outcome === "not-addressed";

export interface Ledger {
  generatedAt: string;
  since: string;
  repos: string[];
  prsAnalysed: number;
  prsWithAi: number;
  timeToMerge: { withAiFindings: MergeTimes; withoutAiFindings: MergeTimes };
  byBot: BotStats[];
  byRepoAndBot: BotStats[];
  bySeverity: SeverityStats[];
  topDismissedFiles: { repo: string; path: string; dismissed: number }[];
  /** Files with the most findings nobody acted on (ignored, or a summary item not addressed). */
  topIgnoredFiles: IgnoredFile[];
  findings: ClassifiedFinding[];
}

function mergeTimes(prs: PullRequestRecord[]): MergeTimes {
  const hours = prs.map((pr) => minutesBetween(pr.createdAt, pr.mergedAt) / 60);
  return { prs: prs.length, medianHours: median(hours), p75Hours: percentile(hours, 75) };
}

function botStats(
  bot: string,
  repo: string,
  prs: PullRequestRecord[],
  findings: ClassifiedFinding[],
): BotStats {
  const mine = findings.filter((f) => f.bot === bot);
  const count = (outcome: ClassifiedFinding["outcome"]) => mine.filter((f) => f.outcome === outcome).length;

  const firstCommentMinutes: number[] = [];
  let prsReviewed = 0;
  let summaryComments = 0;
  for (const pr of prs) {
    const times = [
      ...pr.findings.filter((f) => f.bot === bot).map((f) => f.createdAt),
      ...pr.summaries.filter((s) => s.bot === bot).map((s) => s.createdAt),
    ].sort();
    summaryComments += pr.summaries.filter((s) => s.bot === bot).length;
    if (times.length === 0) continue;
    prsReviewed += 1;
    firstCommentMinutes.push(minutesBetween(pr.createdAt, times[0]!));
  }

  const addressed = count("addressed");
  const dismissed = count("dismissed");
  const acknowledged = count("acknowledged");
  const ignored = count("ignored");
  const notAddressed = count("not-addressed");
  return {
    bot,
    repo,
    prsReviewed,
    findings: mine.length,
    inlineFindings: mine.filter((f) => f.source === "inline").length,
    summaryFindings: mine.filter((f) => f.source === "summary").length,
    addressed,
    dismissed,
    acknowledged,
    ignored,
    outdated: count("outdated"),
    notAddressed,
    addressedRate: ratio(addressed, mine.length),
    dismissedRate: ratio(dismissed, mine.length),
    acknowledgedRate: ratio(acknowledged, mine.length),
    aiChecked: mine.filter((f) => f.fixVerdict).length,
    aiFixed: mine.filter((f) => f.fixVerdict?.verdict === "fixed").length,
    aiPartly: mine.filter((f) => f.fixVerdict?.verdict === "partly").length,
    aiUnrelated: mine.filter((f) => f.fixVerdict?.verdict === "unrelated").length,
    ignoredRate: ratio(ignored, mine.length),
    notAddressedRate: ratio(notAddressed, mine.length),
    findingsPerPr: ratio(mine.length, prsReviewed),
    summaryComments,
    medianFirstCommentMinutes: median(firstCommentMinutes),
  };
}

export function buildLedger(
  prs: PullRequestRecord[],
  findings: ClassifiedFinding[],
  options: { since: string; repos: string[]; now?: Date },
): Ledger {
  const bots = [
    ...new Set([...prs.flatMap((pr) => pr.findings.map((f) => f.bot)), ...prs.flatMap((pr) => pr.summaries.map((s) => s.bot))]),
  ].sort();

  const byBot = bots.map((bot) => botStats(bot, "*", prs, findings));
  const byRepoAndBot = options.repos.flatMap((repo) => {
    const repoPrs = prs.filter((pr) => pr.repo === repo);
    const repoFindings = findings.filter((f) => f.repo === repo);
    return bots
      .map((bot) => botStats(bot, repo, repoPrs, repoFindings))
      .filter((s) => s.prsReviewed > 0);
  });

  const severityGroups = new Map<string, SeverityStats>();
  for (const f of findings) {
    if (!f.severity) continue;
    const key = `${f.bot}\u0000${f.severity}`;
    const entry = severityGroups.get(key) ?? { bot: f.bot, severity: f.severity, findings: 0, addressed: 0, addressedRate: 0 };
    entry.findings += 1;
    if (f.outcome === "addressed") entry.addressed += 1;
    severityGroups.set(key, entry);
  }
  const bySeverity = [...severityGroups.values()]
    .map((s) => ({ ...s, addressedRate: ratio(s.addressed, s.findings) }))
    .sort((a, b) => a.bot.localeCompare(b.bot) || a.severity.localeCompare(b.severity));

  const dismissedByFile = new Map<string, { repo: string; path: string; dismissed: number }>();
  for (const f of findings) {
    if (f.outcome !== "dismissed" || !f.path) continue;
    const key = `${f.repo}:${f.path}`;
    const entry = dismissedByFile.get(key) ?? { repo: f.repo, path: f.path, dismissed: 0 };
    entry.dismissed += 1;
    dismissedByFile.set(key, entry);
  }

  const byFile = new Map<string, IgnoredFile>();
  for (const f of findings) {
    if (!f.path) continue;
    const key = `${f.repo}:${f.path}`;
    const entry = byFile.get(key) ?? { repo: f.repo, path: f.path, ignored: 0, findings: 0, items: [] };
    entry.findings += 1;
    if (isIgnored(f)) {
      entry.ignored += 1;
      entry.items.push(f);
    }
    byFile.set(key, entry);
  }
  const topIgnoredFiles = [...byFile.values()]
    .filter((f) => f.ignored > 0)
    .map((f) => ({ ...f, items: [...f.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_ITEMS_PER_FILE) }))
    .sort((a, b) => b.ignored - a.ignored || b.findings - a.findings || a.path.localeCompare(b.path))
    .slice(0, 10);

  const withAi = prs.filter((pr) => pr.findings.length > 0);
  const withoutAi = prs.filter((pr) => pr.findings.length === 0);

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    since: options.since,
    repos: options.repos,
    prsAnalysed: prs.length,
    prsWithAi: prs.filter((pr) => pr.findings.length > 0 || pr.summaries.length > 0).length,
    timeToMerge: { withAiFindings: mergeTimes(withAi), withoutAiFindings: mergeTimes(withoutAi) },
    byBot,
    byRepoAndBot,
    bySeverity,
    topDismissedFiles: [...dismissedByFile.values()].sort((a, b) => b.dismissed - a.dismissed).slice(0, 10),
    topIgnoredFiles,
    findings,
  };
}
