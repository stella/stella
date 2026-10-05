import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import { caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  ECJ_LISTING_TIMEOUT_MS,
  fetchDecisionsByCelex,
  isValidCelex,
  listCelexVariants,
} from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { withPublisherRequestRateLimit } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { PROCESS_DECISION_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { createSourceContractResolver } from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
import { allocateSourceObservationOrder } from "@/api/handlers/case-law/ingestion/pipeline/source-observation";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import {
  openCaseLawReadOnlySession,
  enterCaseLawMaintenanceLane,
} from "@/api/lib/case-law/maintenance-lane";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { refreshCorpusS3, refreshS3 } from "@/api/lib/s3";
import { runEcjFormexRefresh } from "@/api/scripts/eu-ecj-formex-refresh";
import { operatorFlags } from "@/api/scripts/operator-flags";

/**
 * Refresh named EU decisions through the ingestion pipeline. Full refetches
 * take a CELEX list; Formex refreshes take stored row or document identities
 * and request only the manifestation named in each row's stored notice.
 *
 * Formex runs journal each outcome durably and release both the maintenance
 * lane and source ingestion lease between batches. Reuse --results-out to
 * recover after interruption, optionally with --after <row-id>.
 * A publisher rate-limit stop exits 1, matching a halted full refetch.
 *
 * bun run src/scripts/eu-ecj-refetch.ts --formex-only --ids-file ids.txt \
 *   --apply --results-out results.jsonl --requests-per-second 1
 */

const DEFAULT_DELAY_MS = 500;
/** Consecutive failed CELEX before the run halts; mirrors the crawl. */
const FAILURE_HALT_THRESHOLD = 10;
/** Whole-CELEX budget: one listing plus every language variant behind it. */
const CELEX_FETCH_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_FAILED_OUT = "eu-ecj-refetch-failed.json";

const USAGE = `Usage: bun run src/scripts/eu-ecj-refetch.ts [options]

  --formex-only       Replace only Formex from the stored notice.
  --ids-file <path>    Row ids or CELEX:lang, one per line (Formex mode).
  --results-out <path> Per-row JSONL results; required with Formex --apply.
                       Keep its .pending.json sidecar when resuming.
  --requests-per-second <n> Publisher requests per second (default 2, max 2).
  --census <path>      Census report whose refetchableCelex list is visited.
  --celex <a,b,c>      Visit these CELEX numbers instead of a census file.
  --celex-file <path>  Visit the JSON string array in this file (e.g. a
                       previous run's failed set).
  --apply              Fetch and write. Formex dry runs fetch without writing.
  --limit <n>          Maximum CELEX or stored rows to visit this run.
  --after <id>         Resume after a CELEX or Formex row id (sorted order).
  --delay-ms <n>       Pause between decisions (default ${DEFAULT_DELAY_MS}).
  --failed-out <path>  Where failed CELEX are written (default ${DEFAULT_FAILED_OUT}).

A publisher rate-limit stop exits 1; resume after its reported cooldown.`;

type FormexOnlyOptions = {
  flagValue: ReturnType<typeof operatorFlags>["flagValue"];
  apply: boolean;
  limit: number | null;
  after: string | null;
  resultsOut: string | undefined;
};
type StoredFormexRefreshOptions = Omit<FormexOnlyOptions, "flagValue"> & {
  idsFile: string;
};
const runStoredFormexRefresh = async ({
  idsFile,
  apply,
  limit,
  after,
  resultsOut,
}: StoredFormexRefreshOptions) => {
  const { ingestionDb } = await openCaseLawReadOnlySession();
  await refreshS3();
  if (apply) {
    await refreshCorpusS3();
  }
  const source = (
    await ingestionDb((tx) =>
      tx
        .select({ id: caseLawSources.id })
        .from(caseLawSources)
        .where(eq(caseLawSources.adapterKey, ADAPTER_KEYS.EU_ECJ))
        .limit(1),
    )
  ).at(0);
  if (source === undefined) {
    console.error("No case-law source configured for adapter eu-ecj");
    return null;
  }
  const resultsPath = resultsOut ?? "eu-ecj-refetch-results.jsonl";
  const interruption = new AbortController();
  const interrupt = () => interruption.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    return await runEcjFormexRefresh({
      signal: interruption.signal,
      ingestionDb,
      sourceId: source.id,
      idsFile,
      resultsOut: resultsPath,
      apply,
      after,
      limit,
      acquireBatch: async () => {
        const lane = await enterCaseLawMaintenanceLane();
        const acquired = await Result.tryPromise({
          try: async () =>
            await acquireCaseLawSourceIngestionLease({
              scopedDb: lane.ingestionDb,
              sourceId: source.id,
            }),
          catch: (cause) => cause,
        });
        if (Result.isError(acquired)) {
          await lane.release();
          throw acquired.error;
        }
        const sourceLease = acquired.value;
        if (sourceLease === null) {
          await lane.release();
          return null;
        }
        return {
          ingestionDb: lane.ingestionDb,
          sourceLease,
          release: async () => {
            try {
              await sourceLease.release();
            } finally {
              await lane.release();
            }
          },
        };
      },
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
};

const runFormexOnly = async ({
  flagValue,
  apply,
  limit,
  after,
  resultsOut,
  refresh,
}: FormexOnlyOptions & {
  refresh: typeof runStoredFormexRefresh;
}): Promise<number> => {
  const idsFile = flagValue("ids-file");
  if (
    idsFile === undefined ||
    ["celex", "celex-file", "census"].some(
      (name) => flagValue(name) !== undefined,
    )
  ) {
    console.error(
      "--formex-only requires --ids-file and cannot use CELEX list flags",
    );
    return 1;
  }
  const summary = await refresh({ idsFile, apply, limit, after, resultsOut });
  if (summary === null) {
    return 1;
  }
  const resultsPath = resultsOut ?? "eu-ecj-refetch-results.jsonl";
  switch (summary.type) {
    case "complete":
      console.log(
        JSON.stringify({
          type: summary.type,
          rows: summary.results.length,
          resultsOut: resultsPath,
        }),
      );
      return 0;
    case "rate-limited":
      console.log(
        JSON.stringify({
          type: summary.type,
          rows: summary.results.length,
          blockedId: summary.blockedId,
          resumeAfter: summary.resumeAfter,
          cooldownUntilEpochMs: summary.cooldownUntilEpochMs,
        }),
      );
      console.log(
        summary.resumeAfter === null
          ? "Resume with the same arguments and no --after cursor."
          : `Resume with the same arguments and --after ${summary.resumeAfter}.`,
      );
      return 1;
    default:
      summary satisfies never;
      return panic("Unhandled Formex refresh summary");
  }
};

type CelexInputOptions = {
  censusPath: string | undefined;
  celexFlag: string | undefined;
  celexFilePath: string | undefined;
};
const loadRequestedCelex = async ({
  censusPath,
  celexFlag,
  celexFilePath,
}: CelexInputOptions): Promise<string[]> => {
  const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string");

  const isCensusReport = (
    value: unknown,
  ): value is { refetchableCelex: string[] } =>
    typeof value === "object" &&
    value !== null &&
    "refetchableCelex" in value &&
    isStringArray(value.refetchableCelex);

  return await (async (): Promise<string[]> => {
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
    if (censusPath === undefined) {
      return panic("exactly one CELEX source was checked above");
    }
    const parsed: unknown = JSON.parse(await Bun.file(censusPath).text());
    if (!isCensusReport(parsed)) {
      console.error(`${censusPath} is not a census report`);
      process.exit(1);
    }
    return parsed.refetchableCelex;
  })();
};

type CelexRefreshOptions = Omit<FormexOnlyOptions, "resultsOut"> & {
  delayMs: number;
  failedOutPath: string;
};
const runCelexRefresh = async ({
  flagValue,
  apply,
  limit,
  after,
  delayMs,
  failedOutPath,
}: CelexRefreshOptions): Promise<number> => {
  const { ingestionDb } = await enterCaseLawMaintenanceLane();
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

  const requestedCelex = await loadRequestedCelex({
    censusPath,
    celexFlag,
    celexFilePath,
  });

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
    .toSorted()
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

  const resolveSourceContract = createSourceContractResolver(ingestionDb);

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
          // db-await-in-loop: lease-guarded counter: every write needs its own monotonic observation order
          const observationOrder = await allocateSourceObservationOrder({
            leaseToken: sourceLease.leaseToken,
            scopedDb: ingestionDb,
            sourceId: source.id,
          });
          // db-await-in-loop: per-decision ingest pipeline, ordered by the observation number allocated just above
          const processed = await processDecision(
            {
              input: result,
              sourceId: source.id,
              scopedDb: ingestionDb,
              observedAt: new Date(),
              observationOrder,
              refresh: DECISION_REFRESH.ALWAYS,
            },
            resolveSourceContract,
          );
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
  return haltReason === null || haltReason === "interrupted" ? 0 : 1;
};

type EuEcjRefetchOptions = {
  formexRefresh?: typeof runStoredFormexRefresh;
};
export const runEuEcjRefetch = async (
  argv: readonly string[],
  { formexRefresh = runStoredFormexRefresh }: EuEcjRefetchOptions = {},
): Promise<number> => {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const { flagValue, hasFlag, positiveInteger } = operatorFlags(USAGE, argv);

  const rateFlag = flagValue("requests-per-second");
  const requestsPerSecond = rateFlag === undefined ? 2 : Number(rateFlag);
  if (
    !Number.isFinite(requestsPerSecond) ||
    requestsPerSecond <= 0 ||
    requestsPerSecond > 2
  ) {
    console.error("--requests-per-second must be greater than 0 and at most 2");
    return 1;
  }
  return await withPublisherRequestRateLimit({
    gateId: "cellar-eu",
    requestsPerSecond,
    operation: async () => {
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

      const resultsOut = flagValue("results-out");
      if (apply && hasFlag("formex-only") && resultsOut === undefined) {
        console.error("--results-out is required with --apply");
        return 1;
      }
      if (hasFlag("formex-only")) {
        return await runFormexOnly({
          refresh: formexRefresh,
          flagValue,
          apply,
          limit,
          after,
          resultsOut,
        });
      }
      if (flagValue("ids-file") !== undefined || resultsOut !== undefined) {
        console.error("--ids-file and --results-out require --formex-only");
        return 1;
      }
      return await runCelexRefresh({
        flagValue,
        apply,
        limit,
        after,
        delayMs,
        failedOutPath,
      });
    },
  });
};

if (import.meta.main) {
  process.exit(await runEuEcjRefetch(process.argv.slice(2)));
}
