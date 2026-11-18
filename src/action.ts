import { writeFile } from "node:fs/promises";
import * as core from "@actions/core";
import Anthropic from "@anthropic-ai/sdk";
import { ClaudeFixJudge } from "./ai/fix-judge.ts";
import { DEFAULT_AI_MODEL, resolveModel } from "./ai/claude.ts";
import { ClaudeReplyJudge } from "./ai/reply-intent.ts";
import { Cache } from "./collect/cache.ts";
import { createClient, splitRepo } from "./collect/github.ts";
import { loadConfig } from "./config.ts";
import { upsertIssue } from "./report/issue.ts";
import { renderMarkdown } from "./report/markdown.ts";
import { run } from "./run.ts";
import { parseDuration } from "./util/duration.ts";
import { listInput, parseOutputs } from "./action-inputs.ts";

const ISSUE_BODY_LIMIT = 65_000;

async function main(): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  core.setSecret(token);

  const repos = listInput(core.getInput("repos") || process.env.GITHUB_REPOSITORY || "");
  if (repos.length === 0) throw new Error("No repos given, and GITHUB_REPOSITORY isn't set.");
  repos.forEach(splitRepo);

  const since = core.getInput("since") || "7d";
  parseDuration(since);
  const maxPrs = Number(core.getInput("max-prs") || "200");
  if (!Number.isInteger(maxPrs) || maxPrs < 1) throw new Error("max-prs must be a positive whole number.");

  const outputs = parseOutputs(core.getInput("output") || "job-summary");
  const config = await loadConfig(core.getInput("config") || undefined);
  const client = createClient(token);

  const cache = new Cache(".mindthebot/cache", false);
  let replyJudge: ClaudeReplyJudge | undefined;
  let fixJudge: ClaudeFixJudge | undefined;
  if (core.getBooleanInput("ai")) {
    const apiKey = core.getInput("anthropic-api-key");
    if (!apiKey) throw new Error("ai: true needs the anthropic-api-key input.");
    core.setSecret(apiKey);
    const ai = {
      cache,
      model: resolveModel(core.getInput("ai-model") || DEFAULT_AI_MODEL),
      client: new Anthropic({ apiKey }),
      warn: (m: string) => core.warning(m),
    };
    core.info(`AI: using ${ai.model}`);
    replyJudge = new ClaudeReplyJudge(ai);
    fixJudge = new ClaudeFixJudge(ai);
  }
  const ledger = await run(client, cache, config, {
    repos,
    since,
    maxPrs,
    replyJudge,
    fixJudge,
    log: (m) => core.info(m),
  });
  const markdown = renderMarkdown(ledger);

  const markdownPath = core.getInput("markdown-path") || "mindthebot.md";
  const jsonPath = core.getInput("json-path") || "mindthebot.json";
  await writeFile(markdownPath, markdown);
  await writeFile(jsonPath, `${JSON.stringify(ledger, null, 2)}\n`);
  core.setOutput("markdown-path", markdownPath);
  core.setOutput("json-path", jsonPath);
  core.setOutput("findings", ledger.findings.length);
  core.setOutput(
    "by-bot",
    JSON.stringify(
      Object.fromEntries(
        ledger.byBot.map((s) => [
          s.bot,
          {
            findings: s.findings,
            addressedRate: s.addressedRate,
            dismissedRate: s.dismissedRate,
            acknowledgedRate: s.acknowledgedRate,
            ignoredRate: s.ignoredRate,
            notAddressedRate: s.notAddressedRate,
          },
        ]),
      ),
    ),
  );

  if (outputs.includes("job-summary")) {
    await core.summary.addRaw(markdown).write();
  }

  if (outputs.includes("issue")) {
    const issueRepo = core.getInput("issue-repo") || process.env.GITHUB_REPOSITORY;
    if (!issueRepo) throw new Error("issue output needs issue-repo or GITHUB_REPOSITORY.");
    const title = core.getInput("issue-title") || "Mind the bot";
    // Issue bodies are capped at 65,536 characters, so drop the full comments if needed.
    const body = markdown.length <= ISSUE_BODY_LIMIT ? markdown : renderMarkdown(ledger, { fullComments: false });
    const issue = await upsertIssue(client, issueRepo, title, body.slice(0, ISSUE_BODY_LIMIT));
    core.info(`${issue.created ? "Created" : "Updated"} ${issue.url}`);
    core.setOutput("issue-url", issue.url);
  }
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
