import { isIgnored, type BotStats, type IgnoredFile, type Ledger, type MergeTimes } from "../aggregate/metrics.ts";
import type { ClassifiedFinding } from "../types.ts";

// ── Formatting helpers ──────────────────────────────────────────────────────

const pct = (n: number) => `${Math.round(n * 100)}%`;
const num = (n: number | null, digits = 1) => (n === null ? "–" : n.toFixed(digits));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A ten-cell bar, e.g. `█████░░░░░`, in code font so the cells line up. */
export function bar(rate: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round(rate * width)));
  return `\`${"█".repeat(filled)}${"░".repeat(width - filled)}\``;
}

function duration(minutes: number | null): string {
  if (minutes === null) return "–";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

/** "7d" → "7 days", "12h" → "12 hours", "2w" → "2 weeks". */
export function sinceLabel(since: string): string {
  const match = /^(\d+)([hdw])$/.exec(since.trim());
  if (!match) return since;
  const unit = { h: "hour", d: "day", w: "week" }[match[2] as "h" | "d" | "w"];
  return plural(Number(match[1]), unit);
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** "p1" → "P1", "warning" → "Warning". */
function severityLabel(severity: string): string {
  return /^p\d$/i.test(severity) ? severity.toUpperCase() : severity.charAt(0).toUpperCase() + severity.slice(1);
}

/** Make text safe inside a table cell or a list item. */
function escapeInline(text: string): string {
  // Inside `code`, GitHub shows < and > as typed (and would show &lt; literally),
  // so only escape them outside code spans. A backtick left unclosed by
  // truncation is dropped, so the rest isn't swallowed into code.
  const parts = text.split("`");
  if (parts.length % 2 === 0) parts.splice(-2, 2, `${parts.at(-2)}${parts.at(-1)}`);
  return parts
    .map((part, i) => {
      const piped = part.replace(/\|/g, "\\|");
      return i % 2 === 1 ? piped : piped.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    })
    .join("`");
}

/**
 * A one-line gist of a review comment. Prefers a bold title line (Greptile,
 * CodeRabbit, Codex), else the first readable line, without HTML, badges,
 * code blocks, markdown markers or leading severity emoji.
 */
/**
 * Real HTML tags that reviewers use for badges and layout. Anything else in
 * angle brackets, such as `app_id_<uuid>` or `Array<string>`, is kept.
 */
const HTML_TAG =
  /<\/?(?:a|img|picture|source|sub|sup|br|hr|p|div|span|b|i|em|strong|code|kbd|pre|blockquote|table|thead|tbody|tr|td|th|ul|ol|li|h[1-6]|summary)\b[^>]*>/gi;

export function snippet(body: string, max = 110): string {
  return escapeInline(gist(body, max));
}

/** The gist as plain text, unescaped. */
function gist(body: string, max: number): string {
  const lines = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<details>[\s\S]*?<\/details>/gi, "")
    .replace(HTML_TAG, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => /[a-z]{3}/i.test(l));

  const title = lines.slice(0, 4).map((l) => /^\*\*([^*]+)\*\*(?!\s*·)/.exec(l)?.[1]?.trim()).find((t) => t && /[a-z]{3}/i.test(t));
  const line = (title ?? lines[0] ?? "")
    .replace(/^[\s>#*\-+\d.)]+/, "")
    .replace(/^(?:[🔴🟠🟡🟢🟣🔵⚪⚠❗]|\uFE0F|\s)+/u, "")
    .replace(/^\[[A-Z]+\]:?\s*/, "")
    .replace(/\*\*|__/g, "")
    // Lowercase labels such as "(optional)", "nit:" or "pre-existing, not blocking:".
    .replace(/^(?:\([^)]{1,25}\)\s*|[a-z][a-z ,()-]{0,30}:\s*)+/, "")
    .trim();
  const tidy = line.charAt(0).toUpperCase() + line.slice(1);
  return tidy.length > max ? `${tidy.slice(0, max - 1).trimEnd()}…` : tidy;
}

/** The gist for an HTML <summary>, where markdown isn't rendered: escaped, with `code` as <code>. */
function summaryGist(body: string): string {
  const html = gist(body, 100).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return html.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/`/g, "");
}

/** Longest comment shown in full; anything longer is cut at a paragraph and links to the rest. */
export const MAX_COMMENT_CHARS = 4000;

/**
 * A reviewer's comment, made safe to embed in the report: no hidden HTML
 * comments, cut to MAX_COMMENT_CHARS at a paragraph break, with any code fence
 * or <details> block the cut left open closed again, and quoted.
 */
export function fullComment(body: string, url: string): string {
  let text = body.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n").trim();
  let cut = false;
  if (text.length > MAX_COMMENT_CHARS) {
    const at = text.lastIndexOf("\n\n", MAX_COMMENT_CHARS);
    text = text.slice(0, at > MAX_COMMENT_CHARS / 2 ? at : MAX_COMMENT_CHARS).trimEnd();
    cut = true;
  }
  if ((text.match(/^ {0,3}(```|~~~)/gm) ?? []).length % 2 === 1) text += "\n```";
  const unclosed = (text.match(/<details\b/gi) ?? []).length - (text.match(/<\/details>/gi) ?? []).length;
  if (unclosed > 0) text += "\n</details>".repeat(unclosed);
  // A stray closing tag would close the report's own <details>.
  if (unclosed < 0) text = text.replace(/<\/details>/gi, (m, offset: number, all: string) =>
    (all.slice(0, offset).match(/<details\b/gi) ?? []).length > (all.slice(0, offset).match(/<\/details>/gi) ?? []).length ? m : "");
  if (cut) text += `\n\n*…cut here. [Read the full comment on GitHub](${url}).*`;
  return text
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

// ── Links ───────────────────────────────────────────────────────────────────

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** The file name as a link, with its folder (and repo, if several) underneath. */
function fileCell(repo: string, path: string, multiRepo: boolean): string {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const folder = slash > 0 ? path.slice(0, slash) : "";
  const under = [multiRepo ? repo : "", folder].filter(Boolean).join(" · ");
  return `[\`${escapeInline(name)}\`](${fileUrl(repo, path)})${under ? `<br><sub>${escapeInline(under)}</sub>` : ""}`;
}

function fileUrl(repo: string, path: string): string {
  return `https://github.com/${repo}/blob/HEAD/${encodePath(path)}`;
}

/** The commented line(s) as the reviewer saw them, or the comment if there's no commit. */
function lineUrl(f: ClassifiedFinding): string {
  if (!f.path || !f.line || !f.commitOid) return f.url;
  const range = f.endLine && f.endLine !== f.line ? `#L${f.line}-L${f.endLine}` : `#L${f.line}`;
  return `https://github.com/${f.repo}/blob/${f.commitOid}/${encodePath(f.path)}${range}`;
}

function lineText(f: ClassifiedFinding): string {
  if (!f.line) return "file";
  return f.endLine && f.endLine !== f.line ? `L${f.line}–${f.endLine}` : `L${f.line}`;
}

// ── Status ──────────────────────────────────────────────────────────────────

/** Below this many findings, a rate says more about luck than about the reviewer. */
export const MIN_FINDINGS_FOR_STATUS = 5;

/**
 * A one-line status for a reviewer, from how often its findings are
 * addressed. The thresholds are deliberately simple.
 */
export function reviewerStatus(s: BotStats): { icon: string; label: string } {
  if (s.findings === 0) return { icon: "⚪", label: "No findings" };
  if (s.findings < MIN_FINDINGS_FOR_STATUS) return { icon: "⚪", label: "Too few findings" };
  if (s.addressedRate >= 0.6) return { icon: "🟢", label: "Mostly acted on" };
  if (s.addressedRate >= 0.4) return { icon: "🟡", label: "Partly acted on" };
  return { icon: "🔴", label: "Mostly not acted on" };
}

// ── Sections ────────────────────────────────────────────────────────────────

function details(summary: string, body: string): string {
  return `<details>\n<summary><b>${summary}</b></summary>\n\n${body}\n\n</details>`;
}

function headline(ledger: Ledger): string {
  const findings = ledger.findings.length;
  const addressed = ledger.findings.filter((f) => f.outcome === "addressed").length;
  const ignored = ledger.findings.filter(isIgnored).length;
  const reviewedShare = ledger.prsAnalysed === 0 ? "" : ` <sub>${pct(ledger.prsWithAi / ledger.prsAnalysed)}</sub>`;
  const rateOf = (n: number) => (findings === 0 ? "–" : `**${pct(n / findings)}**`);
  return [
    "| Merged PRs | Reviewed by AI | Findings | Addressed | Ignored |",
    "|:---:|:---:|:---:|:---:|:---:|",
    `| **${ledger.prsAnalysed}** | **${ledger.prsWithAi}**${reviewedShare} | **${findings}** | ${rateOf(addressed)} | ${rateOf(ignored)} |`,
  ].join("\n");
}

function reviewersTable(rows: BotStats[]): string {
  const lines = ["| Reviewer | Addressed | Findings | Breakdown |", "|:--|:--|--:|:--|"];
  for (const s of rows) {
    const { icon, label } = reviewerStatus(s);
    if (s.findings === 0) {
      lines.push(`| ${icon} **${s.bot}** | – | 0 | <sub>commented on ${plural(s.prsReviewed, "PR")}, no file-and-line findings</sub> |`);
      continue;
    }
    const parts = [
      `✅ ${s.addressed}`,
      `🚫 ${s.dismissed}`,
      ...(s.acknowledged > 0 ? [`💬 ${s.acknowledged}`] : []),
      `💤 ${s.ignored + s.notAddressed}`,
      ...(s.outdated > 0 ? [`🕸️ ${s.outdated}`] : []),
    ];
    lines.push(
      `| ${icon} **${s.bot}**<br><sub>${label}</sub> | ${bar(s.addressedRate)} **${pct(s.addressedRate)}** | ${s.findings} | ${parts.join(" · ")} |`,
    );
  }
  return lines.join("\n");
}

const LEGEND =
  "<sub>✅ addressed · 🚫 dismissed · 💬 acknowledged, not changed · 💤 ignored · 🕸️ outdated, no change found<br>" +
  `🟢 60%+ addressed · 🟡 40–59% · 🔴 under 40% · ⚪ fewer than ${MIN_FINDINGS_FOR_STATUS} findings</sub>`;

/** Line links shown per file in the table; the rest are in "What the reviewers said". */
const LINES_IN_TABLE = 3;

function ignoredFilesTable(files: IgnoredFile[], multiRepo: boolean): string {
  const lines = ["| | File | Ignored | Lines |", "|--:|:--|:--|:--|"];
  files.forEach((file, i) => {
    const shown = file.items.slice(0, LINES_IN_TABLE);
    const where = shown.map((f) => `[${lineText(f)}](${lineUrl(f)}) <sub>[#${f.pr}](${f.url})</sub>`).join(" · ");
    const more = file.ignored > shown.length ? ` · <sub>+${file.ignored - shown.length} more</sub>` : "";
    lines.push(`| ${i + 1} | ${fileCell(file.repo, file.path, multiRepo)} | **${file.ignored}** <sub>of ${file.findings}</sub> | ${where}${more} |`);
  });
  return lines.join("\n");
}

function ignoredFindingsList(files: IgnoredFile[], multiRepo: boolean, full: boolean): string {
  return files
    .map((file) => {
      const repo = multiRepo ? ` <sub>${file.repo}</sub>` : "";
      const heading = `[\`${escapeInline(file.path)}\`](${fileUrl(file.repo, file.path)})${repo}`;
      if (!full) {
        const items = file.items.map((f) => {
          const severity = f.severity ? ` · ${severityLabel(f.severity)}` : "";
          return `- [**${lineText(f)}**](${lineUrl(f)}) · ${f.bot}${severity} · [#${f.pr}](${f.url})<br>${snippet(f.body)}`;
        });
        return `${heading}\n\n${items.join("\n")}`;
      }
      const items = file.items.map((f) => {
        const severity = f.severity ? ` · ${severityLabel(f.severity)}` : "";
        return [
          "<details>",
          `<summary><b>${lineText(f)}</b> · ${f.bot}${severity} · #${f.pr} · ${summaryGist(f.body)}</summary>`,
          "",
          `[Code at ${lineText(f)}](${lineUrl(f)}) · [Comment on #${f.pr}](${f.url})`,
          "",
          fullComment(f.body, f.url),
          "",
          "</details>",
        ].join("\n");
      });
      return `${heading}\n\n${items.join("\n\n")}`;
    })
    .join("\n\n");
}

/** Most severe first; unknown labels go last, alphabetically. */
const SEVERITY_ORDER = ["critical", "p0", "p1", "major", "important", "high", "warning", "p2", "medium", "minor", "p3", "low", "nit", "note", "pre-existing"];
const severityRank = (s: string) => {
  const i = SEVERITY_ORDER.indexOf(s.toLowerCase());
  return i === -1 ? SEVERITY_ORDER.length : i;
};

function severityTable(ledger: Ledger): string {
  const rows = [...ledger.bySeverity].sort(
    (a, b) => a.bot.localeCompare(b.bot) || severityRank(a.severity) - severityRank(b.severity) || a.severity.localeCompare(b.severity),
  );
  return [
    "| Reviewer | Severity | Addressed | Findings |",
    "|:--|:--|:--|--:|",
    ...rows.map(
      (s) => `| ${s.bot} | ${severityLabel(s.severity)} | ${bar(s.addressedRate)} **${pct(s.addressedRate)}** | ${s.findings} |`,
    ),
  ].join("\n");
}

function fullTable(rows: BotStats[], withRepo: boolean): string {
  const rate = (count: number, r: number, total: number) => (total === 0 ? "–" : `${count} <sub>${pct(r)}</sub>`);
  const hasSummary = rows.some((s) => s.summaryFindings > 0);
  const columns: [string, (s: BotStats) => string | number, boolean?][] = [
    ...(withRepo ? ([["Repo", (s) => s.repo, true]] as [string, (s: BotStats) => string, boolean][]) : []),
    ["Reviewer", (s) => `**${s.bot}**`, true],
    ["PRs", (s) => s.prsReviewed],
    ...(hasSummary
      ? ([
          ["Inline", (s) => s.inlineFindings],
          ["Summary", (s) => s.summaryFindings],
        ] as [string, (s: BotStats) => number][])
      : ([["Findings", (s) => s.findings]] as [string, (s: BotStats) => number][])),
    ["Addressed", (s) => rate(s.addressed, s.addressedRate, s.findings)],
    ["Dismissed", (s) => rate(s.dismissed, s.dismissedRate, s.findings)],
    ["Acknowledged", (s) => rate(s.acknowledged, s.acknowledgedRate, s.findings)],
    ["Ignored", (s) => rate(s.ignored, s.ignoredRate, s.findings)],
    ...(hasSummary
      ? ([["Not addressed", (s) => rate(s.notAddressed, s.notAddressedRate, s.findings)]] as [string, (s: BotStats) => string][])
      : []),
    ["Outdated", (s) => (s.findings === 0 ? "–" : s.outdated)],
    ["Per PR", (s) => (s.findings === 0 ? "–" : num(s.findingsPerPr))],
    ["First comment", (s) => duration(s.medianFirstCommentMinutes)],
  ];
  return [
    `| ${columns.map(([h]) => h).join(" | ")} |`,
    `|${columns.map(([, , label]) => (label ? ":--" : "--:")).join("|")}|`,
    ...rows.map((s) => `| ${columns.map(([, cell]) => cell(s)).join(" | ")} |`),
  ].join("\n");
}

function mergeRow(label: string, m: MergeTimes): string {
  return `| ${label} | ${m.prs} | ${num(m.medianHours)}h | ${num(m.p75Hours)}h |`;
}

const HOW_IT_WORKS = [
  "Every comment an AI reviewer leaves on a file and line, and every file-and-line item in its summary comment, is one **finding**. Each finding is checked against the code that changed after it:",
  "",
  '- ✅ **Addressed**: code within 3 lines changed afterwards, or a reply such as "fixed" (or a 👍) came with a change to the file.',
  '- 🚫 **Dismissed**: a 👎, a reply such as "intentional" or "out of scope", or the thread was resolved with no nearby change.',
  '- 💬 **Acknowledged**: someone replied (for example "confirmed, leaving this open") or gave a 👍, but no nearby change followed and nobody dismissed it.',
  "- 💤 **Ignored**: no reply, reaction, resolution or nearby change. Summary items can't be replied to or resolved, so the full breakdown lists them separately as **not addressed**.",
  "- 🕸️ **Outdated**: GitHub marked the thread outdated, but no nearby change was found.",
  "",
  "These are heuristics: a nearby change isn't proof the comment caused it, and a fix made in a later PR looks ignored. The JSON report records the rule behind every outcome.",
].join("\n");

// ── Report ──────────────────────────────────────────────────────────────────

export interface RenderOptions {
  /** Include each ignored finding's full comment. Off for GitHub issues, whose bodies are capped at 65,536 characters. */
  fullComments?: boolean;
}

export function renderMarkdown(ledger: Ledger, { fullComments = true }: RenderOptions = {}): string {
  const out: string[] = [];
  const multiRepo = ledger.repos.length > 1;
  const repoList = ledger.repos.map((r) => `[${r}](https://github.com/${r})`).join(" · ");

  out.push("## 🤖 Mind the bot");
  out.push(
    "How often your team acts on what its AI code reviewers say.<br>" +
      `<sub>${repoList} · merged PRs from the last ${sinceLabel(ledger.since)} · ${dateLabel(ledger.generatedAt)}</sub>`,
  );
  out.push(headline(ledger));

  if (ledger.byBot.length === 0) {
    out.push("> [!NOTE]\n> No comments from the configured AI reviewers in this window.");
  } else {
    out.push("### Reviewers");
    out.push(reviewersTable(ledger.byBot));
    out.push(LEGEND);
  }

  if (ledger.topIgnoredFiles.length > 0) {
    out.push("### 💤 Files with the most ignored findings");
    out.push(
      "<sub>Findings nobody replied to, reacted to or changed code for. Line links open the code the reviewer saw; PR links open the comment.</sub>",
    );
    out.push(ignoredFilesTable(ledger.topIgnoredFiles, multiRepo));
    out.push(details("What the reviewers said", ignoredFindingsList(ledger.topIgnoredFiles, multiRepo, fullComments)));
  }

  if (ledger.bySeverity.length > 0) {
    out.push("### By severity");
    out.push(severityTable(ledger));
    out.push("<sub>Severity as labelled by the reviewer. A low rate on its highest severity is the number to look at first.</sub>");
  }

  const more: string[] = [];
  if (ledger.byBot.length > 0) {
    more.push(
      details(
        "📊 Full breakdown",
        `${fullTable(ledger.byBot, false)}\n\n<sub><b>Per PR</b>: findings per PR the reviewer commented on. <b>First comment</b>: median time from PR opened to the review arriving.</sub>`,
      ),
    );
  }
  if (multiRepo && ledger.byRepoAndBot.length > 0) {
    more.push(details("🗂️ By repo", fullTable(ledger.byRepoAndBot, true)));
  }
  if (ledger.topDismissedFiles.length > 0) {
    more.push(
      details(
        "🚫 Files where findings get dismissed most",
        [
          "Candidates for path exclusions or extra context in your review instructions.",
          "",
          "| File | Dismissed |",
          "|:--|--:|",
          ...ledger.topDismissedFiles.map(
            (f) =>
              `| ${fileCell(f.repo, f.path, multiRepo)} | ${f.dismissed} |`,
          ),
        ].join("\n"),
      ),
    );
  }
  more.push(
    details(
      "⏱️ Time to merge",
      [
        "| PRs | Count | Median | p75 |",
        "|:--|--:|--:|--:|",
        mergeRow("With AI findings", ledger.timeToMerge.withAiFindings),
        mergeRow("Without AI findings", ledger.timeToMerge.withoutAiFindings),
        "",
        "<sub>Context only: bigger PRs attract more findings and take longer to merge, so this doesn't show cause and effect.</sub>",
      ].join("\n"),
    ),
  );
  more.push(details("ℹ️ How findings are scored", HOW_IT_WORKS));

  out.push("---");
  out.push(more.join("\n\n"));
  const aiModels = [...new Set(ledger.findings.flatMap((f) => (f.replyIntent ? [f.replyIntent.model] : [])))];
  const aiNote = aiModels.length > 0 ? ` · replies read by ${aiModels.join(", ")}` : "";
  out.push(`<sub>Generated by mindthebot · read-only: it never comments on, changes or approves a PR${aiNote}</sub>`);

  return `${out.join("\n\n")}\n`;
}
