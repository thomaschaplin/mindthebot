import { buildLedger, type Ledger } from "./aggregate/metrics.ts";
import { eachLimited } from "./ai/claude.ts";
import type { FixJudge, FixVerdict } from "./ai/fix-judge.ts";
import { judgeReplies, type ReplyJudge } from "./ai/reply-intent.ts";
import { classify, hasNearbyChange, resolvePath } from "./classify/rules.ts";
import type { Cache } from "./collect/cache.ts";
import { changedLinesSince, filesSince, patchesFor, type FileDiff } from "./collect/changes.ts";
import type { GitHubClient } from "./collect/github.ts";
import { fetchMergedPullRequests, toRecord } from "./collect/pull-requests.ts";
import type { Config } from "./config.ts";
import type { ChangedLines, ClassifiedFinding, Finding, PullRequestRecord } from "./types.ts";
import { parseDuration } from "./util/duration.ts";

export interface RunOptions {
  repos: string[];
  since: string;
  maxPrs: number;
  /** With --ai: reads the intent of human replies instead of matching phrases. */
  replyJudge?: ReplyJudge;
  /** With --ai: checks whether a nearby change actually fixed the finding. */
  fixJudge?: FixJudge;
  log?: (message: string) => void;
}

/** Summary items share their comment's id, so key findings by comment, file and line. */
const findingKey = (f: Finding) => `${f.commentId}:${f.path}:${f.line}`;

interface Diff {
  changes: ChangedLines | null;
  files: FileDiff[] | null;
}

export async function run(
  client: GitHubClient,
  cache: Cache,
  config: Config,
  options: RunOptions,
): Promise<Ledger> {
  const log = options.log ?? (() => {});
  const sinceMs = parseDuration(options.since);
  const records: PullRequestRecord[] = [];
  const classified: ClassifiedFinding[] = [];

  for (const repo of options.repos) {
    log(`${repo}: fetching merged PRs from the last ${options.since}…`);
    const raw = await fetchMergedPullRequests(client, cache, repo, sinceMs, options.maxPrs);
    const prs = raw.map((pr) => toRecord(repo, pr, config));
    const findingCount = prs.reduce((n, pr) => n + pr.findings.length, 0);
    log(`${repo}: ${prs.length} PRs, ${findingCount} AI findings`);

    // One diff per distinct commented commit, not per comment. Both calls hit the same cached responses.
    const withDiffs: { finding: Finding; diff: Diff }[] = [];
    for (const pr of prs) {
      const diffs = new Map<string, Diff>();
      for (const finding of pr.findings) {
        const oid = finding.commitOid;
        if (oid && !diffs.has(oid)) {
          diffs.set(oid, {
            changes: await changedLinesSince(client, cache, repo, oid, pr.headOid, pr.commits),
            files: options.fixJudge ? await filesSince(client, cache, repo, oid, pr.headOid, pr.commits) : null,
          });
        }
        withDiffs.push({ finding, diff: oid ? diffs.get(oid)! : { changes: null, files: null } });
      }
    }

    const intents = options.replyJudge
      ? await judgeReplies(options.replyJudge, withDiffs.map((d) => d.finding))
      : new Map();
    if (options.replyJudge) log(`${repo}: AI read the replies on ${intents.size} threads`);

    const verdicts = new Map<string, FixVerdict>();
    if (options.fixJudge) {
      const judge = options.fixJudge;
      const candidates = withDiffs.filter(({ finding, diff }) => diff.files && hasNearbyChange(finding, diff.changes, config));
      await eachLimited(candidates, 4, async ({ finding, diff }) => {
        const path = diff.changes ? resolvePath(finding.path!, diff.changes) : finding.path!;
        const verdict = await judge.judge({ ...finding, path }, patchesFor(diff.files!, path));
        if (verdict) verdicts.set(findingKey(finding), verdict);
      });
      const overturned = [...verdicts.values()].filter((v) => v.verdict === "unrelated").length;
      log(`${repo}: AI checked ${verdicts.size} of ${candidates.length} nearby changes; ${overturned} judged unrelated`);
    }

    for (const { finding, diff } of withDiffs) {
      classified.push(classify(finding, diff.changes, config, intents.get(finding.commentId), verdicts.get(findingKey(finding))));
    }
    records.push(...prs);
  }

  return buildLedger(records, classified, { since: options.since, repos: options.repos });
}
