# Mind the bot

**How often does your team act on what its AI code reviewers say?**

Teams are adding AI reviewers to every pull request: Claude, Greptile, Copilot, CodeRabbit, Cursor Bugbot, Cubic, Codex. Few teams check whether those comments lead to anything. Without data, people who find a bot noisy can't prove it, people who like it can't prove it catches real issues, and nobody knows whether a prompt or model change made it better or worse.

`mindthebot` reads your merged PRs and scores every issue an AI reviewer raised, whether as an inline comment or as an item in a summary comment, as **addressed**, **dismissed**, **acknowledged** or **ignored**:

```bash
npx mindthebot --repo owner/name --since 30d
```

It's read-only and needs no setup inside the repo.

## Example

Every report opens with headline numbers and one line per reviewer:

| Reviewer | Addressed | Findings |
|:--|:--|--:|
| 🟢 **Copilot**<br><sub>Mostly acted on</sub> | `████████░░` **79%** | 152 |
| 🟢 **Greptile**<br><sub>Mostly acted on</sub> | `██████░░░░` **64%** | 173 |
| 🟡 **CodeRabbit**<br><sub>Partly acted on</sub> | `██████░░░░` **57%** | 206 |
| 🟡 **Claude**<br><sub>Partly acted on</sub> | `█████░░░░░` **54%** | 112 |

🟢 **Mostly acted on**: at least 60% of findings addressed. 🟡 **Partly acted on**: 40–59%. 🔴 **Mostly not acted on**: under 40%. ⚪ With fewer than 5 findings, a reviewer gets no status: the sample is too small to mean much.

These numbers come from eight well-known public repos (VS Code, supabase, TanStack Query, cline, cal.com, PostHog, openai/codex and claude-code-action): merged PRs from the last 30 days, up to 80 per repo, run on 16 Nov 2026. Below that, the report has:

- **the files with the most ignored findings**, each linked to the exact lines the reviewer commented on and to the comment itself, with a one-line gist of what it said
- every reviewer's addressed, dismissed, acknowledged and ignored counts, overall and per repo
- a breakdown by the severity each reviewer gave. On this sample, Greptile's P1s were addressed 73% of the time against 59% for P2s, and CodeRabbit's "major" 60% against 58% for "minor".
- time to merge for PRs with and without AI findings
- the files where findings get dismissed most

These numbers describe how each team responds to its reviewer, not which reviewer is "best": teams, codebases and settings differ.

## How it decides

For each AI comment, it works out what changed in the code after the comment:

- **Addressed:** code within 3 lines of the comment changed afterwards, or someone replied "fixed" / "good catch" (or gave a 👍) and the file changed.
- **Dismissed:** a 👎, a reply like "intentional", "out of scope" or "leaving as is", or the thread was resolved with no nearby change.
- **Acknowledged:** someone replied ("confirmed, leaving this open") or gave a 👍, but no nearby change followed and nobody dismissed it.
- **Ignored:** no reply, reaction, resolution or nearby change.
- **Not addressed:** for issues listed in a summary comment, which have no replies or resolution: no nearby change.

**Summary comments** are parsed for numbered items with a severity and a `file:line`, such as `claude-code-action`'s sticky "Code Review -- 2 issue(s) found" comment. A re-review that repeats an open issue is merged with the original, and the issue is checked from the last review that repeated it.

**Branches that merge `main` back in** (common in big monorepos) are handled. Comparing against the final commit would pull in everyone else's changes, so the tool combines the PR's own commits instead.

Every finding in the JSON output records the rule that decided it, so any number can be audited. These are heuristics, and they have limits: a nearby change isn't proof of cause, and a fix made in another PR looks ignored. **[docs/heuristics.md](docs/heuristics.md)** explains the rules, the known limits, and how to check them against your own labels.

## Usage

```bash
# Token: GITHUB_TOKEN, or your GitHub CLI login (`gh auth login`). Read-only access is enough.
npx mindthebot --repo owner/name                       # markdown, last 30 days
npx mindthebot --repo owner/a,owner/b --since 2w       # several repos
npx mindthebot --repo owner/name --format json -o report.json
npx mindthebot --repo owner/name --config mindthebot.yml
npx mindthebot --repo owner/name --datadog             # also send gauges to Datadog
```

| Option | Default | |
|---|---|---|
| `--repo` | required | `owner/name`, repeatable or comma-separated |
| `--since` | `30d` | `12h`, `30d`, `2w` |
| `--max-prs` | `200` | per repo |
| `--config` | built-in | YAML: reviewers, proximity, phrases. See [mindthebot.example.yml](mindthebot.example.yml) |
| `--format` | `md` | `md` or `json` |
| `--out` | stdout | write to a file |
| `--datadog` | off | DogStatsD gauges such as `mindthebot.addressed_rate{bot,repo}`; needs `hot-shots` and a Datadog agent. No comment text is sent. |
| `--no-cache` | cache on | API responses are cached in `.mindthebot/cache/` |
| `--ai` | off | Use Claude to read what human replies mean (fixed, will fix, disagrees, acknowledged, question) instead of matching phrases, and to check whether each nearby change actually fixed the finding. Needs `ANTHROPIC_API_KEY`. Sends the comment, human replies and nearby diff hunks, nothing else. See [docs/heuristics.md](docs/heuristics.md#with---ai). |
| `--ai-model` | `haiku` | Claude model for `--ai`: `haiku`, `sonnet`, `opus` or `fable` (the newest of each), or a full model ID. See [Choosing a model](#choosing-a-model-for---ai) |

### Choosing a model for `--ai`

| `--ai-model` | Model | Price per million tokens (in / out) | Use it for |
|---|---|---|---|
| `haiku` (default) | Claude Haiku 5.5 | $0.10 / $0.50 | trying `--ai` out, and large backfills |
| `sonnet` | Claude Sonnet 5.5 | $2 / $10 | a good balance for regular weekly runs |
| `opus` | Claude Opus 5.5 | $4 / $20 | the most careful fix verdicts at a moderate price |
| `fable` | Claude Fable 5.2 | $8 / $40 | the hardest code, when cost matters least |

Reading replies is easy for every model; judging whether a diff fixed a comment is where bigger models earn their price. Answers are cached per model, so switching models re-asks every question once.

### Reviewers it knows about

Claude (`claude[bot]`, or `github-actions[bot]` comments that mention Claude), Greptile, Copilot, CodeRabbit, Cursor Bugbot, Cubic, Codex and Gemini. You can add any other bot login in the config.

## Weekly report (GitHub Action)

Run it on a schedule and publish the report as a job summary, a living issue, or both:

```yaml
name: Mind the bot
on:
  schedule:
    - cron: "0 8 * * 1"   # Mondays
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: read
  issues: write           # only needed for output: issue

jobs:
  mindthebot:
    runs-on: ubuntu-latest
    steps:
      - uses: thomaschaplin/mindthebot@v1
        with:
          since: 7d
          output: job-summary,issue
```

| Input | Default | |
|---|---|---|
| `repos` | current repo | `owner/name`, comma- or newline-separated |
| `since` | `7d` | `12h`, `7d`, `2w` |
| `max-prs` | `200` | per repo |
| `config` | built-in | path to a YAML config |
| `output` | `job-summary` | `job-summary`, `issue`, `none` (comma-separated) |
| `issue-title` | `Mind the bot` | an open issue with this title and the `mindthebot` label is updated instead of creating a new one |
| `issue-repo` | current repo | where to post the issue |
| `github-token` | `${{ github.token }}` | use a PAT or GitHub App token to read other private repos |
| `ai` | `false` | read replies and check fixes with Claude, as `--ai` |
| `anthropic-api-key` | – | required with `ai: true`; pass it from a secret |
| `ai-model` | `haiku` | Claude model for `ai`, as `--ai-model` |

Outputs: `markdown-path`, `json-path`, `findings`, `by-bot` (JSON of per-reviewer rates, handy for alerting in a later step) and `issue-url`. The full JSON report is written to `mindthebot.json`, so you can upload it with `actions/upload-artifact`.

This repo runs the Action on itself every week: see [.github/workflows/mindthebot.yml](.github/workflows/mindthebot.yml).

## Development

```bash
npm install
npm test            # vitest: classifier rules, diff parsing, summary parsing, a fixture-based pipeline test
npm run typecheck
npm run dev -- --repo owner/name   # run from source (Node 22.18+)
npm run build       # bundle the CLI (dist/cli.js) and the Action (action/dist/index.js)
npm run check-dist  # rebuild and fail if the committed Action bundle is out of date (CI runs this)
```

## Roadmap

- [x] GitHub Action: a weekly report as a job summary or an issue
- [x] Score issues listed in summary comments, with a severity breakdown
- [ ] A 30-finding hand-labelled agreement check, with the rate published here
- [x] Read reply intent with Claude (`--ai`)
- [x] Judge whether a nearby change actually fixed the comment, with Claude (`--ai`)
- [ ] Group findings by category (bug, security, style)
- [ ] Pair with an eval harness of planted bugs, to measure what reviewers *miss*, not just what they say

## Licence

MIT.
