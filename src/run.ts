import { buildLedger, type Ledger } from "./aggregate/metrics.ts";
import { judgeReplies, type ReplyJudge } from "./ai/reply-intent.ts";
import { classify } from "./classify/rules.ts";
import type { Cache } from "./collect/cache.ts";
import { changedLinesSince } from "./collect/changes.ts";
import type { GitHubClient } from "./collect/github.ts";
import { fetchMergedPullRequests, toRecord } from "./collect/pull-requests.ts";
import type { Config } from "./config.ts";
import type { ChangedLines, ClassifiedFinding, PullRequestRecord } from "./types.ts";
import { parseDuration } from "./util/duration.ts";

export interface RunOptions {
  repos: string[];
  since: string;
  maxPrs: number;
  /** With --ai: reads the intent of human replies instead of matching phrases. */
  replyJudge?: ReplyJudge;
  log?: (message: string) => void;
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

    const intents = options.replyJudge
      ? await judgeReplies(options.replyJudge, prs.flatMap((pr) => pr.findings))
      : new Map();
    if (options.replyJudge) log(`${repo}: AI read the replies on ${intents.size} threads`);

    for (const pr of prs) {
      // One diff per distinct commented commit, not per comment.
      const diffs = new Map<string, ChangedLines | null>();
      for (const finding of pr.findings) {
        let changes: ChangedLines | null | undefined;
        if (finding.commitOid) {
          if (!diffs.has(finding.commitOid)) {
            diffs.set(finding.commitOid, await changedLinesSince(client, cache, repo, finding.commitOid, pr.headOid, pr.commits));
          }
          changes = diffs.get(finding.commitOid);
        } else {
          changes = null;
        }
        classified.push(classify(finding, changes, config, intents.get(finding.commentId)));
      }
    }
    records.push(...prs);
  }

  return buildLedger(records, classified, { since: options.since, repos: options.repos });
}
