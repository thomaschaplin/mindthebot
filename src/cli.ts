import { writeFile } from "node:fs/promises";
import { Command, InvalidArgumentError } from "commander";
import { ClaudeFixJudge } from "./ai/fix-judge.ts";
import { AI_MODELS, DEFAULT_AI_MODEL, resolveModel } from "./ai/claude.ts";
import { ClaudeReplyJudge } from "./ai/reply-intent.ts";
import { Cache } from "./collect/cache.ts";
import { createClient, resolveToken, splitRepo } from "./collect/github.ts";
import { loadConfig } from "./config.ts";
import { sendToDatadog } from "./report/datadog.ts";
import { renderMarkdown } from "./report/markdown.ts";
import { run } from "./run.ts";
import { parseDuration } from "./util/duration.ts";

const collect = (value: string, previous: string[]) => [...previous, ...value.split(",").map((v) => v.trim()).filter(Boolean)];

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("Must be a positive whole number.");
  return n;
}

const program = new Command()
  .name("mindthebot")
  .description("Measure whether AI code review comments on GitHub pull requests get acted on.")
  .requiredOption("-r, --repo <owner/name>", "repo to analyse (repeat or comma-separate for several)", collect, [])
  .option("-s, --since <duration>", "how far back to look: 12h, 30d, 2w", "30d")
  .option("--max-prs <n>", "maximum merged PRs per repo", positiveInt, 200)
  .option("-c, --config <path>", "YAML config file (bots, proximity, phrases)")
  .option("-f, --format <format>", "md or json", "md")
  .option("-o, --out <path>", "write the report to a file instead of stdout")
  .option("--datadog", "also send metrics to Datadog through DogStatsD")
  .option("--no-cache", "don't read or write the .mindthebot/cache directory")
  .option("--ai", "use Claude to read what human replies mean and to check whether nearby changes fixed each finding (needs ANTHROPIC_API_KEY; sends comment text, replies and diff hunks to Anthropic)")
  .option(
    "--ai-model <model>",
    `Claude model for --ai: ${Object.keys(AI_MODELS).join(", ")}, or a full model ID`,
    (value: string) => {
      try {
        return resolveModel(value);
      } catch (error) {
        throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
      }
    },
    resolveModel(DEFAULT_AI_MODEL),
  )
  .action(async (opts) => {
    if (opts.format !== "md" && opts.format !== "json") throw new InvalidArgumentError("--format must be md or json.");
    opts.repo.forEach(splitRepo);
    parseDuration(opts.since);

    const config = await loadConfig(opts.config);
    const client = createClient(resolveToken());
    const cache = new Cache(".mindthebot/cache", opts.cache);
    const log = (m: string) => process.stderr.write(`${m}\n`);
    if (opts.ai) log(`AI: using ${opts.aiModel}`);
    const replyJudge = opts.ai ? new ClaudeReplyJudge({ cache, model: opts.aiModel, warn: log }) : undefined;
    const fixJudge = opts.ai ? new ClaudeFixJudge({ cache, model: opts.aiModel, warn: log }) : undefined;
    const ledger = await run(client, cache, config, {
      repos: opts.repo,
      since: opts.since,
      maxPrs: opts.maxPrs,
      replyJudge,
      fixJudge,
      log,
    });
    if (replyJudge && fixJudge) {
      const calls = replyJudge.calls + fixJudge.calls;
      log(`AI: ${calls} new Claude request${calls === 1 ? "" : "s"} (the rest came from the cache)`);
    }

    const output = opts.format === "json" ? `${JSON.stringify(ledger, null, 2)}\n` : renderMarkdown(ledger);
    if (opts.out) {
      await writeFile(opts.out, output);
      process.stderr.write(`Wrote ${opts.out}\n`);
    } else {
      process.stdout.write(output);
    }
    if (opts.datadog) await sendToDatadog(ledger);
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`mindthebot: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
