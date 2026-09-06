import { eq } from "drizzle-orm";

import { caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  ECJ_LISTING_TIMEOUT_MS,
  fetchDecisionsByCelex,
  isValidCelex,
  listCelexVariants,
} from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import {
  allocateSourceObservationOrder,
  DECISION_REFRESH,
  PROCESS_DECISION_STATUS,
  processDecision,
} from "@/api/handlers/case-law/ingestion/pipeline";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { refreshCorpusS3, refreshS3 } from "@/api/lib/s3";

// Hold the maintenance lane before the first statement: operator passes over
// the case-law tables serialize here instead of deadlocking on row locks.
const { ingestionDb } = await enterCaseLawMaintenanceLane();

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
 * CELEX is listed again before it is fetched, so a variant the fetch
 * silently drops (transient non-OK, timeout, short body) is detected by
 * count and the CELEX lands in the failed set instead of being advanced
 * past. Results go through `processDecision` under
 * `DECISION_REFRESH.ALWAYS` (the publisher's document may hash
 * identically while the payload the parser derives is what changed),
 * ordered on the source's observation counter under its ingestion lease,
 * so a run cannot interleave with a live crawl.
 *
 * Failed CELEX are written to a JSON file at the end; feed it back via
 * `--celex-file` to retry exactly those. Interrupt with Ctrl-C: the
 * current decision finishes and the report names the resume point.
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
/** Whole-CELEX budget: one listing plus every language variant behind it. */
const CELEX_FETCH_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_FAILED_OUT = "eu-ecj-refetch-failed.json";

const USAGE = `Usage: bun run src/scripts/eu-ecj-refetch.ts [options]

  --census <path>      Census report whose refetchableCelex list is visited.
  --celex <a,b,c>      Visit these CELEX numbers instead of a census file.
  --celex-file <path>  Visit the JSON string array in this file (e.g. a
                       previous run's failed set).
  --apply              Fetch and write. Omitted, the run prints the plan only.
  --limit <n>          Maximum CELEX to visit this run.
  --after <celex>      Resume strictly after this CELEX (sorted order).
  --delay-ms <n>       Pause between decisions (default ${DEFAULT_DELAY_MS}).
  --failed-out <path>  Where failed CELEX are written (default ${DEFAULT_FAILED_OUT}).`;

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

const DECIMAL_INTEGER = /^\d+$/u;

const positiveInteger = (
  raw: string | undefined,
  fallback: number,
  name: string,
): number => {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = DECIMAL_INTEGER.test(raw)
    ? Number.parseInt(raw, 10)
    : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(`--${name} must be a positive integer, got: ${raw}`);
    process.exit(1);
  }
  return parsed;
};

const apply = hasFlag("apply");
const limitFlag = flagValue("limit");
const limit =
  limitFlag === undefined ? null : positiveInteger(limitFlag, 0, "limit");
const after = flagValue("after") ?? null;
const delayMs = positiveInteger(
  flagValue("delay-ms"),
  DEFAULT_DELAY_MS,
  "delay-ms",
);
const failedOutPath = flagValue("failed-out") ?? DEFAULT_FAILED_OUT;

const censusPath = flagValue("census");
const celexFlag = flagValue("celex");
const celexFilePath = flagValue("celex-file");
const sourcesGiven = [censusPath, celexFlag, celexFilePath].filter(
  (value) => value !== undefined,
);
if (sourcesGiven.length !== 1) {
  console.error(
    "Exactly one of --census, --celex or --celex-file is required.",
  );
  console.error(USAGE);
  process.exit(1);
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isCensusReport = (
  value: unknown,
): value is { refetchableCelex: string[] } =>
  typeof value === "object" &&
  value !== null &&
  "refetchableCelex" in value &&
  isStringArray(value.refetchableCelex);

const requestedCelex = await (async (): Promise<string[]> => {
  if (celexFlag !== undefined) {
    return celexFlag.split(",").map((celex) => celex.trim());
  }
  if (celexFilePath !== undefined) {
    const parsed: unknown = JSON.parse(await Bun.file(celexFilePath).text());
    if (!isStringArray(parsed)) {
      console.error(`${celexFilePath} is not a JSON array of CELEX strings`);
      process.exit(1);
    }
    return parsed;
  }
  const parsed: unknown = JSON.parse(await Bun.file(censusPath ?? "").text());
  if (!isCensusReport(parsed)) {
    console.error(`${censusPath} is not a census report`);
    process.exit(1);
  }
  return parsed.refetchableCelex;
})();

// Validated here, before the lease: a malformed entry deep in the plan
// would otherwise burn the consecutive-failure budget mid-run and could
// halt a valid recovery.
const malformed = requestedCelex.filter((celex) => !isValidCelex(celex));
if (malformed.length > 0) {
  console.error(
    `Invalid CELEX number(s): ${malformed.slice(0, 5).join(", ")}${malformed.length > 5 ? ` (+${malformed.length - 5} more)` : ""}`,
  );
  process.exit(1);
}
if (after !== null && !isValidCelex(after)) {
  console.error(`--after must be a CELEX number, got: ${after}`);
  process.exit(1);
}

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

// Object-held so the flag's cross-callback mutation is visible to
// per-site flow analysis; a plain boolean reads as always-false.
const runState = { interrupted: false };
process.on("SIGINT", () => {
  runState.interrupted = true;
  console.error("interrupt received; finishing the current decision…");
});

const counts = {
  visited: 0,
  variantsExpected: 0,
  variantsFetched: 0,
  complete: 0,
  retryable: 0,
  missingVariants: 0,
};
const failedCelex: string[] = [];
let lastVisited: string | null = null;
let consecutiveFailures = 0;
let haltReason: string | null = null;

try {
  for (const celex of plan) {
    if (runState.interrupted) {
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
      // Listed again right before the fetch: the count is what detects a
      // variant the fetch dropped silently, and the extra query per CELEX
      // is noise next to the manifestation downloads themselves.
      const expected = await listCelexVariants({
        celexNumbers: [celex],
        signal: AbortSignal.timeout(ECJ_LISTING_TIMEOUT_MS),
      });
      counts.variantsExpected += expected.length;
      const results = await fetchDecisionsByCelex({
        celexNumbers: [celex],
        signal: AbortSignal.timeout(CELEX_FETCH_TIMEOUT_MS),
      });
      if (results.length < expected.length) {
        // The missing variants stay stored as they were; the CELEX goes to
        // the failed set so a retry revisits every variant.
        counts.missingVariants += expected.length - results.length;
        celexFailed = true;
        console.error(
          `${celex}: fetched ${results.length} of ${expected.length} listed variants`,
        );
      }
      for (const result of results) {
        counts.variantsFetched += 1;
        await sourceLease.beforeDatabaseMark();
        // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- lease-guarded counter: every write needs its own monotonic observation order
        const observationOrder = await allocateSourceObservationOrder({
          leaseToken: sourceLease.leaseToken,
          scopedDb: ingestionDb,
          sourceId: source.id,
        });
        // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- per-decision ingest pipeline, ordered by the observation number allocated just above
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
    if (celexFailed) {
      failedCelex.push(celex);
      consecutiveFailures += 1;
    } else {
      consecutiveFailures = 0;
    }
    if (counts.visited % 25 === 0) {
      console.error(
        `progress: ${counts.visited}/${plan.length} celex, ${counts.complete} variants written, ${failedCelex.length} celex failed`,
      );
    }
    await Bun.sleep(delayMs);
  }
} finally {
  await sourceLease.release();
}

console.log("--- outcomes ---");
console.log(`celex visited:     ${counts.visited} of ${plan.length}`);
console.log(`variants listed:   ${counts.variantsExpected}`);
console.log(`variants fetched:  ${counts.variantsFetched}`);
console.log(`written:           ${counts.complete}`);
console.log(`retryable:         ${counts.retryable}`);
console.log(`variants missing:  ${counts.missingVariants}`);
if (failedCelex.length > 0) {
  await Bun.write(failedOutPath, `${JSON.stringify(failedCelex, null, 2)}\n`);
  console.log(`celex failed:      ${failedCelex.length} → ${failedOutPath}`);
  console.log(`retry them with:   --celex-file ${failedOutPath} --apply`);
}
if (haltReason !== null) {
  console.log(`halted:            ${haltReason}`);
}
if (lastVisited !== null && counts.visited < plan.length) {
  console.log(`resume with:       --after ${lastVisited}`);
}
process.exit(haltReason === null || haltReason === "interrupted" ? 0 : 1);
