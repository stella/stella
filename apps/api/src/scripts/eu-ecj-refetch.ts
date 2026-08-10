import { eq } from "drizzle-orm";

import { rlsDb } from "@/api/db/root";
import { caseLawSources } from "@/api/db/schema";
import { createIngestionDb } from "@/api/db/scoped";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { fetchDecisionsByCelex } from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import {
  allocateSourceObservationOrder,
  DECISION_REFRESH,
  PROCESS_DECISION_STATUS,
  processDecision,
} from "@/api/handlers/case-law/ingestion/pipeline";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { refreshCorpusS3, refreshS3 } from "@/api/lib/s3";

/**
 * Re-fetch named CJEU decisions from Cellar and run them through the
 * ingestion pipeline.
 *
 * The stored eu-ecj corpus predates the CJEU parser: every row lacks an
 * AST, and re-parsing locally is impossible because the pre-parser crawl
 * kept no raw payload. A CELEX-driven re-fetch is the tractable shape —
 * the date-cursor reset walks ~27k publication days, almost all empty.
 *
 * The CELEX list comes from the census report
 * (`src/scripts/eu-ecj-census.ts`), which classifies stored rows against
 * Cellar's own listing; this runner visits the re-fetchable ones. Each
 * result goes through `processDecision` under `DECISION_REFRESH.ALWAYS`
 * (the publisher's document may hash identically while the payload the
 * parser derives is what changed), ordered on the source's observation
 * counter under its ingestion lease, so a run cannot interleave with a
 * live crawl. Interrupt with Ctrl-C: the current decision finishes, and
 * the report names the CELEX to resume `--after`.
 *
 *   # what a run would visit, contacting nothing
 *   bun run src/scripts/eu-ecj-refetch.ts --census eu-ecj-census.json
 *
 *   # re-fetch, resumable
 *   bun run src/scripts/eu-ecj-refetch.ts --census eu-ecj-census.json \
 *     --apply --limit 500 [--after <celex>]
 *
 * Not a scheduled job: a deliberate operation under an operator who reads
 * the report, exactly like the stored-raw replay.
 */

const DEFAULT_DELAY_MS = 500;
/** Consecutive failed CELEX before the run halts; mirrors the crawl. */
const FAILURE_HALT_THRESHOLD = 10;
const CELEX_FETCH_TIMEOUT_MS = 5 * 60_000;

const USAGE = `Usage: bun run src/scripts/eu-ecj-refetch.ts [options]

  --census <path>   Census report whose refetchableCelex list is visited.
  --celex <a,b,c>   Visit these CELEX numbers instead of a census file.
  --apply           Fetch and write. Omitted, the run prints the plan only.
  --limit <n>       Maximum CELEX to visit this run.
  --after <celex>   Resume strictly after this CELEX (sorted order).
  --delay-ms <n>    Pause between decisions (default ${DEFAULT_DELAY_MS}).`;

const flagValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`--${name} requires a value`);
    console.error(USAGE);
    process.exit(1);
  }
  return value;
};

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const positiveInteger = (
  raw: string | undefined,
  fallback: number,
  name: string,
): number => {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(`--${name} must be a positive integer, got: ${raw}`);
    process.exit(1);
  }
  return parsed;
};

const apply = hasFlag("apply");
const limitFlag = flagValue("limit");
const limit =
  limitFlag === undefined
    ? null
    : positiveInteger(limitFlag, Number.NaN, "limit");
const after = flagValue("after") ?? null;
const delayMs = positiveInteger(
  flagValue("delay-ms"),
  DEFAULT_DELAY_MS,
  "delay-ms",
);

const censusPath = flagValue("census");
const celexFlag = flagValue("celex");
if ((censusPath === undefined) === (celexFlag === undefined)) {
  console.error("Exactly one of --census or --celex is required.");
  console.error(USAGE);
  process.exit(1);
}

const isCensusReport = (
  value: unknown,
): value is { refetchableCelex: string[] } =>
  typeof value === "object" &&
  value !== null &&
  "refetchableCelex" in value &&
  Array.isArray(value.refetchableCelex) &&
  value.refetchableCelex.every((celex) => typeof celex === "string");

const requestedCelex = await (async (): Promise<string[]> => {
  if (celexFlag !== undefined) {
    return celexFlag.split(",").map((celex) => celex.trim());
  }
  const parsed: unknown = JSON.parse(await Bun.file(censusPath ?? "").text());
  if (!isCensusReport(parsed)) {
    console.error(`${censusPath} is not a census report`);
    process.exit(1);
  }
  return parsed.refetchableCelex;
})();

const plan = [...new Set(requestedCelex)]
  .sort()
  .filter((celex) => after === null || celex > after)
  .slice(0, limit ?? undefined);

console.log(`=== EU-ECJ RE-FETCH ===`);
console.log(`mode:        ${apply ? "apply" : "plan only"}`);
console.log(`celex total: ${new Set(requestedCelex).size}`);
console.log(
  `this run:    ${plan.length}${after === null ? "" : ` (after ${after})`}`,
);
if (!apply) {
  console.log(
    "Plan only: nothing fetched, nothing written. Re-run with --apply.",
  );
  process.exit(0);
}

const ingestionDb = createIngestionDb(rlsDb);
await refreshS3();
await refreshCorpusS3();

const source = (
  await ingestionDb((tx) =>
    tx
      .select({ id: caseLawSources.id })
      .from(caseLawSources)
      .where(eq(caseLawSources.adapterKey, ADAPTER_KEYS.EU_ECJ))
      .limit(1),
  )
).at(0);
if (!source) {
  console.error("No case-law source configured for adapter eu-ecj");
  process.exit(1);
}

const sourceLease = await acquireCaseLawSourceIngestionLease({
  scopedDb: ingestionDb,
  sourceId: source.id,
});
if (sourceLease === null) {
  console.error(
    "Source eu-ecj is being ingested right now (lease held). Retry later.",
  );
  process.exit(1);
}

let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  console.error("interrupt received; finishing the current decision…");
});

const counts = {
  visited: 0,
  variantsFetched: 0,
  complete: 0,
  retryable: 0,
  emptyCelex: 0,
};
let lastVisited: string | null = null;
let consecutiveFailures = 0;
let haltReason: string | null = null;

try {
  for (const celex of plan) {
    if (interrupted) {
      haltReason = "interrupted";
      break;
    }
    if (consecutiveFailures >= FAILURE_HALT_THRESHOLD) {
      haltReason = `${FAILURE_HALT_THRESHOLD} consecutive CELEX failed`;
      break;
    }
    counts.visited += 1;
    lastVisited = celex;
    let celexFailed = false;
    try {
      // oxlint-disable-next-line no-await-in-loop -- rate-limited publisher traffic stays sequential
      const results = await fetchDecisionsByCelex({
        celexNumbers: [celex],
        signal: AbortSignal.timeout(CELEX_FETCH_TIMEOUT_MS),
      });
      if (results.length === 0) {
        counts.emptyCelex += 1;
      }
      for (const result of results) {
        counts.variantsFetched += 1;
        // oxlint-disable-next-line no-await-in-loop -- observation orders are allocated sequentially under the lease
        await sourceLease.beforeDatabaseMark();
        // oxlint-disable-next-line no-await-in-loop -- observation orders are allocated sequentially under the lease
        const observationOrder = await allocateSourceObservationOrder({
          leaseToken: sourceLease.leaseToken,
          scopedDb: ingestionDb,
          sourceId: source.id,
        });
        // oxlint-disable-next-line no-await-in-loop -- each decision is one pipeline write
        const processed = await processDecision({
          input: result,
          sourceId: source.id,
          scopedDb: ingestionDb,
          observedAt: new Date(),
          observationOrder,
          refresh: DECISION_REFRESH.ALWAYS,
        });
        if (processed.status === PROCESS_DECISION_STATUS.RETRYABLE) {
          counts.retryable += 1;
          celexFailed = true;
          console.error(
            `${celex} (${result.language}): retryable — ${processed.reason}`,
          );
        } else {
          counts.complete += 1;
        }
      }
    } catch (error) {
      celexFailed = true;
      console.error(`${celex}: failed —`, error);
    }
    consecutiveFailures = celexFailed ? consecutiveFailures + 1 : 0;
    if (counts.visited % 25 === 0) {
      console.error(
        `progress: ${counts.visited}/${plan.length} celex, ${counts.complete} variants written`,
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- politeness pause between decisions, matching the crawl
    await Bun.sleep(delayMs);
  }
} finally {
  await sourceLease.release();
}

console.log("--- outcomes ---");
console.log(`celex visited:     ${counts.visited} of ${plan.length}`);
console.log(`variants fetched:  ${counts.variantsFetched}`);
console.log(`written:           ${counts.complete}`);
console.log(`retryable:         ${counts.retryable}`);
console.log(`celex w/o results: ${counts.emptyCelex}`);
if (haltReason !== null) {
  console.log(`halted:            ${haltReason}`);
}
if (lastVisited !== null && counts.visited < plan.length) {
  console.log(`resume with:       --after ${lastVisited}`);
}
process.exit(haltReason === null || haltReason === "interrupted" ? 0 : 1);
