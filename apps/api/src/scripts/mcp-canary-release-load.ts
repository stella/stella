/**
 * The staging release proof's MCP load: about a minute of concurrent calls
 * to the heavy public-corpus tools, while the scheduled corpus jobs run, each
 * tool's 95th percentile judged against its budget in
 * `mcp/tool-latency-budgets.ts`, the table the canary and the latency alarm
 * read.
 *
 * What it can catch: a tool that slows down under concurrent callers (lock
 * waits, pool exhaustion, a shared computation every caller repeats), and a
 * scheduled job whose reads crowd out user reads while it runs. Both need
 * overlap, so the proof brings the corpus jobs forward and fails when none of
 * them ran inside the window.
 *
 * What it cannot catch: a cost that only appears at a full corpus's size.
 * Staging's corpus is smaller, so a statement that reads the whole table can
 * still be fast here. The read budgets measured on the corpus fixture
 * (`apps/api/src/lib/read-budgets.ts`) are the data-volume gate; this step is
 * the concurrency gate.
 *
 * Bounded cost: a fixed duration and concurrency against the existing staging
 * stack, inside the MCP transport rate limit.
 */
import { Temporal } from "@stll/time";

import { mcpToolLatencyBudgetMs } from "@/api/mcp/tool-latency-budgets";

export const RELEASE_LOAD = {
  durationMs: 60_000,
  /** Callers in flight at once; with second-long calls, about 240 per minute. */
  concurrency: 4,
  /** A tool with fewer answered calls has no meaningful 95th percentile. */
  minSamplesPerTool: 5,
} as const;

/** Fixed inputs, rotated so the load is not one cached answer repeated. */
const LEGISLATION_QUERIES = [
  "zákoník práce",
  "smlouva",
  "nájem bytu",
  "daň z příjmů",
  "občanský zákoník",
] as const;
const CASE_LAW_QUERIES = [
  "contract",
  "náhrada škody",
  "výpověď z pracovního poměru",
  "nájem",
  "odpovědnost za vady",
] as const;

export type ReleaseLoadCall = {
  toolName:
    | "search_legislation"
    | "search_case_law"
    | "case_law_coverage"
    | "read_case_law_decision";
  arguments: Record<string, unknown>;
};

/** One round of the mix: every heavy tool once, inputs chosen by round. */
export const releaseLoadRound = (
  round: number,
  decisionIds: readonly string[],
): ReleaseLoadCall[] => {
  const pick = <T>(values: readonly T[]): T | undefined =>
    values.at(round % values.length);
  const decisionId = pick(decisionIds);
  return [
    {
      toolName: "search_legislation",
      arguments: { query: pick(LEGISLATION_QUERIES), country: "CZ", limit: 5 },
    },
    {
      toolName: "search_case_law",
      arguments: { queries: [pick(CASE_LAW_QUERIES)], country: "CZ", limit: 5 },
    },
    { toolName: "case_law_coverage", arguments: { country: "CZ" } },
    ...(decisionId === undefined
      ? []
      : [
          {
            toolName: "read_case_law_decision" as const,
            arguments: { decision_ids: [decisionId], max_chars: 4000 },
          },
        ]),
  ];
};

type ReleaseLoadOutcome = "answered" | "failed" | "rate_limited";

export type ReleaseLoadSample = {
  toolName: ReleaseLoadCall["toolName"];
  elapsedMs: number;
  outcome: ReleaseLoadOutcome;
};

type RunReleaseLoadOptions = {
  call: (call: ReleaseLoadCall) => Promise<ReleaseLoadOutcome>;
  decisionIds: readonly string[];
  now?: () => number;
  durationMs?: number;
  concurrency?: number;
};

/**
 * Runs the mix from `concurrency` callers until the duration has passed.
 * Calls started before the end finish and count; none starts after it.
 */
export const runReleaseLoad = async ({
  call,
  decisionIds,
  now = () => performance.now(),
  durationMs = RELEASE_LOAD.durationMs,
  concurrency = RELEASE_LOAD.concurrency,
}: RunReleaseLoadOptions): Promise<ReleaseLoadSample[]> => {
  const endsAt = now() + durationMs;
  const samples: ReleaseLoadSample[] = [];
  let next = 0;
  const nextCall = (): ReleaseLoadCall | undefined => {
    const index = next;
    next += 1;
    const round = releaseLoadRound(Math.floor(index / 4), decisionIds);
    return round.at(index % 4) ?? round.at(0);
  };
  const caller = async () => {
    while (now() < endsAt) {
      const planned = nextCall();
      if (planned === undefined) {
        return;
      }
      const startedAt = now();
      // Each caller runs one call at a time; the concurrency is the callers.
      const outcome = await call(planned);
      samples.push({
        toolName: planned.toolName,
        elapsedMs: now() - startedAt,
        outcome,
      });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, caller));
  return samples;
};

/** Nearest-rank percentile of nonempty samples. */
export const nearestRankPercentile = (
  values: readonly number[],
  percentile: number,
): number => {
  const sorted = values.toSorted((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted.at(rank - 1) ?? 0;
};

type ReleaseLoadVerdict = {
  toolName: ReleaseLoadCall["toolName"];
  answered: number;
  failed: number;
  rateLimited: number;
  p95Ms: number;
  budgetMs: number;
};

const LOAD_TOOLS: readonly ReleaseLoadCall["toolName"][] = [
  "search_legislation",
  "search_case_law",
  "case_law_coverage",
  "read_case_law_decision",
];

export const judgeReleaseLoad = (samples: readonly ReleaseLoadSample[]) => {
  const verdicts: ReleaseLoadVerdict[] = LOAD_TOOLS.map((toolName) => {
    const own = samples.filter((sample) => sample.toolName === toolName);
    const answered = own.filter(({ outcome }) => outcome === "answered");
    return {
      toolName,
      answered: answered.length,
      failed: own.filter(({ outcome }) => outcome === "failed").length,
      rateLimited: own.filter(({ outcome }) => outcome === "rate_limited")
        .length,
      p95Ms:
        answered.length === 0
          ? 0
          : nearestRankPercentile(
              answered.map(({ elapsedMs }) => elapsedMs),
              95,
            ),
      budgetMs: mcpToolLatencyBudgetMs(toolName),
    };
  });
  const failures = verdicts.flatMap((verdict) => {
    const reasons: string[] = [];
    if (verdict.answered < RELEASE_LOAD.minSamplesPerTool) {
      reasons.push(
        `${verdict.toolName} answered ${String(verdict.answered)} calls, fewer than ${String(RELEASE_LOAD.minSamplesPerTool)}`,
      );
    }
    if (verdict.failed > 0 || verdict.rateLimited > 0) {
      reasons.push(
        `${verdict.toolName} had ${String(verdict.failed)} failed and ${String(verdict.rateLimited)} rate-limited calls`,
      );
    }
    if (verdict.answered > 0 && verdict.p95Ms > verdict.budgetMs) {
      reasons.push(
        `${verdict.toolName} p95 ${String(Math.round(verdict.p95Ms))} ms is over its ${String(verdict.budgetMs)} ms budget`,
      );
    }
    return reasons;
  });
  return { verdicts, failures };
};

export const describeReleaseLoad = (verdicts: readonly ReleaseLoadVerdict[]) =>
  verdicts
    .map(
      (verdict) =>
        `${verdict.toolName} p95 ${String(Math.round(verdict.p95Ms))}/${String(verdict.budgetMs)} ms (n=${String(verdict.answered)})`,
    )
    .join("; ");

type ScheduledLoadJob = {
  id: string;
  lastRunAt: string | null;
  lockedAt: string | null;
};

/** The listed jobs that started at or after `dueAt`, finished or still running. */
export const jobsRunSince = (
  jobs: readonly ScheduledLoadJob[],
  dueAt: string,
): string[] => {
  const at = (instant: string) =>
    Temporal.Instant.from(instant).epochMilliseconds;
  const due = at(dueAt);
  return jobs
    .filter(
      ({ lastRunAt, lockedAt }) =>
        (lastRunAt !== null && at(lastRunAt) >= due) ||
        (lockedAt !== null && at(lockedAt) >= due),
    )
    .map(({ id }) => id);
};
