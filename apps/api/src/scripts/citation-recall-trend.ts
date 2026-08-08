/**
 * Publisher-citation recall trend: how much of the publishers' own
 * cited-decision lists the extractor reproduced over a recent window.
 *
 * The ingestion pipeline emits one `case_law.ingestion.citation_recall`
 * event per decision whose publisher ships a structured cited-case list
 * (see `handlers/case-law/ingestion/citation-recall.ts`). This script
 * reads those events back and aggregates them here, so the numbers a
 * scheduled reviewer reports are computed rather than eyeballed across
 * raw log lines.
 *
 * Deliberately `FilterLogEvents`, never Logs Insights: Insights is billed
 * per byte scanned, which makes it the wrong tool for a recurring trend
 * over a high-volume log group. Filtering happens server-side and is not
 * billed per byte.
 *
 *   AWS_REGION=eu-central-1 bun src/scripts/citation-recall-trend.ts \
 *     --log-group /stella/utility-worker [--hours 24] [--stream-prefix ingestion/]
 */
import { isRecord } from "@/api/lib/type-guards";

const RECALL_EVENT = "case_law.ingestion.citation_recall";
/** The emitter caps each event's `missed` list; the report says so. */
const MISSED_PER_EVENT_CAP = 10;
const TOP_MISSED = 10;
/** Bounds one run's read. A hit cap is reported, never silently applied. */
const MAX_EVENTS = 20_000;
const AWS_TIMEOUT_MS = 300_000;

const args = Bun.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
};

const fail = (message: string): never => {
  console.error(`citation-recall-trend: ${message}`);
  process.exit(2);
};

const logGroup = argValue("--log-group");
if (!logGroup) {
  fail("--log-group is required");
}
const hours = Number(argValue("--hours") ?? "24");
if (!Number.isInteger(hours) || hours <= 0 || hours > 168) {
  fail("--hours must be an integer between 1 and 168");
}
const streamPrefix = argValue("--stream-prefix");

if (!Bun.which("aws")) {
  fail("the aws CLI is not on PATH");
}

/**
 * The CLI paginates on its own and merges pages, so `--max-items` is the
 * only bound needed; it echoes a `NextToken` when it stops early, which
 * is how truncation becomes visible instead of silent.
 */
const runAwsJson = async (awsArgs: readonly string[]): Promise<unknown> => {
  const proc = Bun.spawn(["aws", ...awsArgs], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: AWS_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    // Pass stderr through verbatim: the caller has to tell a rejected
    // request apart from a transport failure, and only the CLI's own
    // message carries that.
    console.error(
      `citation-recall-trend: aws ${awsArgs.join(" ")} exited ${String(exitCode)}`,
    );
    console.error(stderr.trim());
    process.exit(2);
  }
  return JSON.parse(stdout) as unknown;
};

const startTime = Date.now() - hours * 60 * 60 * 1000;
const response = await runAwsJson([
  "logs",
  "filter-log-events",
  "--log-group-name",
  logGroup,
  "--start-time",
  String(startTime),
  "--filter-pattern",
  `"${RECALL_EVENT}"`,
  "--max-items",
  String(MAX_EVENTS),
  "--output",
  "json",
  ...(streamPrefix ? ["--log-stream-name-prefix", streamPrefix] : []),
]);

if (!isRecord(response) || !Array.isArray(response["events"])) {
  fail("filter-log-events returned no events array");
}
const rawEvents: readonly unknown[] = response["events"];
const truncated = typeof response["NextToken"] === "string";

type RecallTotals = {
  events: number;
  cited: number;
  missed: number;
  unparsed: number;
  cappedEvents: number;
};

const totals: RecallTotals = {
  events: 0,
  cited: 0,
  missed: 0,
  unparsed: 0,
  cappedEvents: 0,
};
const missedCounts = new Map<string, number>();

for (const rawEvent of rawEvents) {
  const message = isRecord(rawEvent) ? rawEvent["message"] : undefined;
  if (typeof message !== "string") {
    totals.unparsed += 1;
    continue;
  }
  // A log line is JSON per the structured logger, but the filter pattern
  // matches on substring: a line that merely mentions the event name is
  // not one, and must not be counted as a zero-recall sample.
  let parsed: unknown;
  try {
    parsed = JSON.parse(message) as unknown;
  } catch {
    totals.unparsed += 1;
    continue;
  }
  if (!isRecord(parsed) || parsed["message"] !== RECALL_EVENT) {
    totals.unparsed += 1;
    continue;
  }
  const cited = parsed["publisherCitedCount"];
  const missedCount = parsed["missedCount"];
  if (typeof cited !== "number" || typeof missedCount !== "number") {
    totals.unparsed += 1;
    continue;
  }
  totals.events += 1;
  totals.cited += cited;
  totals.missed += missedCount;
  if (missedCount > MISSED_PER_EVENT_CAP) {
    totals.cappedEvents += 1;
  }
  const missed = parsed["missed"];
  if (typeof missed !== "string") {
    continue;
  }
  for (const entry of missed.split(";")) {
    const spelling = entry.trim();
    if (spelling.length > 0) {
      missedCounts.set(spelling, (missedCounts.get(spelling) ?? 0) + 1);
    }
  }
}

const recallPct =
  totals.cited > 0
    ? (((totals.cited - totals.missed) / totals.cited) * 100).toFixed(1)
    : "n/a";

console.log(
  `RECALL window=${String(hours)}h events=${String(totals.events)} cited=${String(totals.cited)} missed=${String(totals.missed)} recall=${recallPct}%`,
);

for (const [spelling, count] of [...missedCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, TOP_MISSED)) {
  console.log(`MISSED ${String(count)} ${spelling}`);
}

if (totals.events === 0) {
  // Not a fault: the event only fires for publishers that ship a
  // structured cited-case list, so a window in which only sources
  // without one were ingested is legitimately empty.
  console.log(
    "NOTE no citation_recall events in the window; the event is emitted only for publishers that supply a cited-case list",
  );
}
if (totals.cappedEvents > 0) {
  console.log(
    `NOTE ${String(totals.cappedEvents)} event(s) missed more than ${String(MISSED_PER_EVENT_CAP)} citations; their MISSED strings are truncated at the emitter`,
  );
}
if (totals.unparsed > 0) {
  console.log(
    `NOTE ${String(totals.unparsed)} matched log line(s) were not usable recall events`,
  );
}
if (truncated) {
  console.log(
    `NOTE the window exceeded ${String(MAX_EVENTS)} events; totals cover the oldest ${String(MAX_EVENTS)} only`,
  );
}
