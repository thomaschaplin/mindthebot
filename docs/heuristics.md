# How mindthebot classifies findings

A **finding** is one issue raised by a configured AI reviewer. It comes from one of two places:

- **Inline:** the first comment of a pull request review thread. Replies from other bots are ignored; replies from people are kept.
- **Summary:** a numbered or bulleted item in a summary comment (a PR conversation comment or a review body) that points at a file and line. Some reviewers, such as `claude-code-action` set up for sticky comments, *only* report this way.

For each finding, mindthebot works out which lines of the commented file changed after the comment:

- **Normally**, it compares the commit the comment was made on with the PR's final head (`GET /repos/{owner}/{repo}/compare/{base}...{head}`). Line numbers are exact, in the commented commit's coordinates.
- **If the base branch was merged into the PR after the comment** (common in big repos such as VS Code and PostHog), that comparison would include everyone else's changes. It can also span thousands of commits and hit GitHub's 300-file limit, hiding the real fix. In that case, and whenever the comparison is truncated, it combines the diffs of the PR's own non-merge commits after the comment (up to 50). Line numbers are then approximate, because each commit's diff is relative to its own parent.

On a 30-day sample of 8 public repos, this fallback changed 84 of 646 outcomes, almost all from "dismissed" to "addressed" on threads whose replies said "Fixed in <sha>".

## Summary items

An item is extracted from a summary comment when it:

1. starts a list item (`1.`, `1)`, `-` or `*`),
2. cites a location: `` `path/file.ts:12` ``, `` `path/file.ts:12-20` ``, `` `path/file.ts:39,63` `` (the first line is used), or a GitHub `/blob/…#L12-L20` link, **and**
3. carries a severity label (`[WARNING]`, `[NOTE]`, `**Critical**`, a Greptile P1 badge, 🔴/🟡/🟣). Set `summaryRequiresSeverity: false` to drop this rule, at the cost of picking up evidence-style bullets that aren't issues ("the parser will pick it up: see `build.mjs:190`").

Then:

- **Delivery time:** bots often post a placeholder and edit it when the review finishes, so the last edit time is used.
- **Commit:** the item is checked against the newest PR commit made at or before the review was delivered.
- **Repeats:** re-reviews often restate an issue that's still open. Items from the same reviewer in the same file with overlapping lines or similar titles (word overlap ≥ 0.4) are merged into one finding. It keeps the time it was **first** raised, but is checked against the code at the **latest** review that raised it, because repeating it means it wasn't fixed by then.
- **Duplicates of inline comments:** if the same reviewer already left an inline comment within `proximity` lines, the summary item is dropped.
- **Paths:** a bare filename or package-relative path (`adapter.ts:103`) is matched to the one changed file whose path ends with it. Ambiguous matches are left unresolved.

Summary items have no replies, reactions or resolution, so they can only be **addressed** (rule 1) or **not addressed**. A "not addressed" item might have been dismissed or ignored; the tool can't tell which.

## Rules

The first rule that matches wins.

| # | Outcome | Rule |
|---|---|---|
| 0 | dismissed | A person replied with a dismissal phrase ("leaving as is", "out of scope", "false positive") and no reply says it was fixed. An explicit human decision beats an unrelated nearby change. |
| 1 | addressed | A line within `proximity` (default 3) of the commented line (or range) changed after the comment. |
| 2 | addressed | A person replied with an "addressed" phrase or gave the comment a 👍, **and** the file changed after the comment. |
| 2b | addressed | The same as rule 2, but the diff couldn't be fetched (for example after a force-push), so the reply is taken at its word. |
| 3 | dismissed | The comment got a 👎. |
| 4 | dismissed | A person replied with a "dismissed" phrase. |
| 5 | dismissed | The thread was resolved with no nearby change. |
| 6 | acknowledged | A person replied or gave a 👍, but none of the rules above matched: no nearby change, no dismissal. For example "Confirmed, leaving this open until the author decides". |
| 7 | outdated | GitHub marked the thread outdated, but no nearby change was found. |
| 8 | ignored | None of the above: no reply, reaction, resolution or nearby change. |
| – | not-addressed | Summary items only: rule 1 didn't match. |

### With `--ai`

The phrase lists in rules 0, 2 and 4 only catch the wording they list. With `--ai`, Claude reads each thread that has a human reply and labels what the replies mean: **fixed**, **will-fix**, **disagrees**, **acknowledged**, **question** or **unclear**. The rules then use that label instead of the phrases: "fixed" counts as a fixed reply, "disagrees" as a dismissal, and the rest fall through to acknowledged. Everything else is unchanged: a nearby change still counts as addressed, and threads with no replies never go to the model.

Rule 1 ("code within 3 lines changed") is the weakest assumption: a nearby change isn't proof that it dealt with the comment. With `--ai`, every finding that rule 1 matches is also checked. Claude gets the comment, the diff hunks within 10 lines of it, and every other change made to the same file after the comment (a fix often lands elsewhere in the file, such as in a helper the commented code calls). It judges the changes **fixed**, **partly**, **unrelated** or **unclear**. An **unrelated** verdict cancels rule 1, so the finding falls through to the rules below it: a reply saying it was fixed still counts as addressed, and a resolved thread counts as acknowledged rather than dismissed, because the fix may be in another file. The other verdicts keep it addressed.

For replies, a fix the author says is in, or about to go into, this PR's next push counts as **fixed**; **will-fix** means a fix promised outside the PR, such as a follow-up PR or an issue. A reply that keeps the code as it is but documents the limitation ("kept, and documented in security.md") counts as **acknowledged**: the issue was recognised and recorded, but it still exists. Documentation counts as fixed only when the comment asked for nothing but documentation. The report shows how many nearby changes were checked and how many were judged unrelated.

Each finding the model looked at records its answers in `replyIntent` and `fixVerdict`, with a one-line reason that is also added to the finding's `reason`. Answers are cached by the text sent and the model, so a re-run only pays for new threads and changes. If a request fails or the model declines, that finding keeps the plain rules, with a warning. Missing credentials stop the run.

What's sent to Anthropic: the comment text, human replies, and diff hunks near the comment. Nothing else from the repo.

Each classified finding in the JSON output carries a `reason` field saying which rule matched, so you can audit any number.

### Changed lines
- A deleted or replaced line counts as changed.
- A pure insertion counts as changing the old lines either side of it.
- A file that changed but has no patch (binary, or too large for the API) counts as changed for rule 2, but not for rule 1.

## Limits

These are heuristics. They are cheap, explainable and mostly right, but not always.

- **Nearby isn't the same as caused by.** A change near the comment might be unrelated. Rule 1 can overcount "addressed", especially on busy files.
- **Merging the base branch into the PR** is handled by using the PR's own commits instead, but line numbers are then approximate: an earlier commit that adds lines above the comment shifts later ones.
- **Force-pushes** can make the commented commit unreachable. Those findings fall back to replies and reactions.
- **Fixes made in a different PR** look ignored or dismissed.
- **Resolving a thread is ambiguous.** Some teams resolve threads to tidy up after fixing something elsewhere in the PR. Rule 5 counts that as dismissed.
- **Summary items need a location and (by default) a severity.** Items that name a file without a line, or carry no severity label, are skipped. On one real repo this covered 24 of 42 issues the reviewer said it found; most of the rest named a file but no line.
- **Free-form reviews** (prose without a numbered list, e.g. from an interactive `@claude review` request) aren't parsed.
- **Phrase matching** is English-only and naive: "not done" matches "done".

## Checking the heuristics

Before trusting the numbers for a repo:

1. Run with `--format json`.
2. Take a random sample of about 30 findings.
3. Label each one by hand, reading the thread and the diff.
4. Compare your labels with the tool's `outcome`, and adjust `proximity` and the phrase lists in your config.

A first spot-check of 6 random findings on `anthropics/claude-code-action` (16 Nov 2026) agreed with the tool every time. That's too small a sample to quote as an agreement rate; a 30-finding check is still to do.
