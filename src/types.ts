import type { ReplyIntent } from "./ai/reply-intent.ts";

/** A human reply in a review thread, after the bot's opening comment. */
export interface Reply {
  author: string;
  body: string;
  createdAt: string;
}

/**
 * One issue raised by an AI reviewer. It comes either from an inline review
 * thread, or from a numbered item in a summary comment that points at a file
 * and line.
 */
export interface Finding {
  repo: string;
  pr: number;
  bot: string;
  source: "inline" | "summary";
  /** Normalised severity label (e.g. "p1", "warning", "important"), if the reviewer gave one. */
  severity: string | null;
  commentId: number;
  url: string;
  createdAt: string;
  body: string;
  path: string | null;
  /** Line in the file at `commitOid` that the comment points at. */
  line: number | null;
  /** Last line, when the reviewer pointed at a range. */
  endLine: number | null;
  /** The commit the comment was made against. */
  commitOid: string | null;
  isResolved: boolean;
  isOutdated: boolean;
  reactions: { up: number; down: number };
  replies: Reply[];
  /** Summary items only: how many later reviews raised the same issue again. */
  repeats: number;
}

/** A bot comment that isn't tied to a line: a review body or a PR conversation comment. */
export interface SummaryComment {
  bot: string;
  /** When the review was delivered: the last edit if the bot posts a placeholder and edits it. */
  createdAt: string;
  /** How many file-and-line items were extracted from it. */
  items: number;
}

export interface PrCommit {
  oid: string;
  committedDate: string;
  /** True for merge commits, e.g. merging the base branch into the PR. */
  isMerge: boolean;
}

export interface PullRequestRecord {
  repo: string;
  number: number;
  url: string;
  createdAt: string;
  mergedAt: string;
  headOid: string;
  /** The PR's commits, oldest first (up to the last 100). */
  commits: PrCommit[];
  findings: Finding[];
  summaries: SummaryComment[];
}

/**
 * Lines changed after a comment, keyed by file path, in the coordinates of the
 * commented commit. `null` means the file changed but no patch was available.
 */
export type ChangedLines = Record<string, number[] | null>;

/**
 * "not-addressed" is for summary items: they have no replies, reactions or
 * resolution, so a dismissal can't be told apart from no response.
 */
export type Outcome = "addressed" | "dismissed" | "acknowledged" | "ignored" | "outdated" | "not-addressed";

export interface ClassifiedFinding extends Finding {
  outcome: Outcome;
  /** Which rule decided the outcome, for transparency and manual checks. */
  reason: string;
  /** With --ai: what the model read the human replies as. */
  replyIntent?: ReplyIntent;
}
