import type { Ledger } from "../aggregate/metrics.ts";

/**
 * Send per-reviewer gauges through DogStatsD so a Datadog dashboard can track
 * reviewer quality over time. Needs a Datadog agent (DD_AGENT_HOST). No comment
 * text is ever sent.
 */
export async function sendToDatadog(ledger: Ledger): Promise<void> {
  let StatsD: typeof import("hot-shots").StatsD;
  try {
    ({ StatsD } = await import("hot-shots"));
  } catch {
    throw new Error("The --datadog flag needs the optional `hot-shots` package. Run `npm install hot-shots`.");
  }

  const client = new StatsD({
    host: process.env.DD_AGENT_HOST ?? "localhost",
    port: Number(process.env.DD_DOGSTATSD_PORT ?? 8125),
    prefix: "mindthebot.",
    errorHandler: (error) => process.stderr.write(`DogStatsD error: ${error.message}\n`),
  });

  for (const s of ledger.byRepoAndBot) {
    const tags = [`bot:${s.bot}`, `repo:${s.repo}`];
    client.gauge("findings", s.findings, tags);
    client.gauge("addressed_rate", s.addressedRate, tags);
    client.gauge("dismissed_rate", s.dismissedRate, tags);
    client.gauge("acknowledged_rate", s.acknowledgedRate, tags);
    if (s.aiChecked > 0) client.gauge("ai_unrelated_changes", s.aiUnrelated, tags);
    client.gauge("ignored_rate", s.ignoredRate, tags);
    client.gauge("not_addressed_rate", s.notAddressedRate, tags);
    client.gauge("findings_per_pr", s.findingsPerPr, tags);
    if (s.medianFirstCommentMinutes !== null) {
      client.gauge("first_comment_minutes", s.medianFirstCommentMinutes, tags);
    }
  }

  await new Promise<void>((resolve) => client.close(() => resolve()));
}
