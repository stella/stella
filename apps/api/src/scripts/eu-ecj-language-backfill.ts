import { and, eq, inArray, isNull } from "drizzle-orm";
import { appendFile } from "node:fs/promises";

import { chunk as chunkItems } from "@stll/concurrency/chunk";
import { initialBatchState } from "@stll/db-load-gate/health";
import { Temporal } from "@stll/time";

import {
  caseLawDecisions,
  caseLawSources,
  databaseBackfillStates,
} from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  ECJ_FIRST_MONTH,
  ECJ_LISTING_TIMEOUT_MS,
  type EcjCelexVariant,
  ecjSourceDocumentId,
  fetchDecisionsByCelex,
  listEcjMonthVariants,
} from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { withPublisherRequestRateLimit } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import {
  type EcjBackfillJournalEntry,
  type EcjBackfillMonth,
  type EcjVariantIngestOutcome,
  isEcjBackfillMonth,
  runEcjLanguageBackfill,
} from "@/api/handlers/case-law/ingestion/eu-ecj-language-backfill";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { PROCESS_DECISION_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { createSourceContractResolver } from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
import { allocateSourceObservationOrder } from "@/api/handlers/case-law/ingestion/pipeline/source-observation";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  type CaseLawIngestionHandle,
  type CaseLawRootHandle,
  enterCaseLawMaintenanceLane,
} from "@/api/lib/case-law/maintenance-lane";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { errorTag } from "@/api/lib/errors/utils";
import {
  acquireCaseLawSourceIngestionLease,
  type CaseLawSourceIngestionLease,
} from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { refreshCorpusS3, refreshS3 } from "@/api/lib/s3";
import { operatorFlags } from "@/api/scripts/operator-flags";

/**
 * Fill in the language versions of EU decisions no stored row holds, one
 * listed month at a time from the newest back to the oldest. See
 * `handlers/case-law/ingestion/eu-ecj-language-backfill.ts` for the walk and
 * its replay guarantees.
 *
 * Shipped as a mode of the `eu-ecj-refetch` runner, so it runs wherever that
 * runner does and needs no entrypoint of its own:
 *
 *   legal-atlas run eu-ecj-refetch --missing-languages --newest 2026-10 --oldest 2023-01
 *   legal-atlas run eu-ecj-refetch --missing-languages --apply \
 *     --results-out eu-ecj-language-backfill.jsonl --max-months 12
 *
 * Plan first: without --apply it lists and counts, writes nothing and leaves
 * the cursor alone. With --apply it holds the maintenance lane and the
 * source's ingestion lease, writes through the ingestion pipeline, journals
 * every variant's outcome to --results-out before the cursor can pass it, and
 * resumes from the durable cursor on the next run.
 */

/** The durable cursor's name in `database_backfill_states`. */
const CHECKPOINT = "eu-ecj-language-versions";
const HELD_LOOKUP_CHUNK = 500;
/** Whole-variant budget: one listing plus one variant's three responses. */
const VARIANT_FETCH_TIMEOUT_MS = 2 * 60_000;

const USAGE = `Usage: bun run src/scripts/eu-ecj-refetch.ts --missing-languages [options]

  --apply                    Fetch and write. Without it: list and count only.
  --results-out <path>       Per-variant JSONL outcomes; required with --apply.
  --newest <YYYY-MM>         Newest month to walk (default: the current month).
  --oldest <YYYY-MM>         Oldest month to walk (default: ${ECJ_FIRST_MONTH}).
  --max-months <n>           Months this run may finish (default 12).
  --max-ingests <n>          Variants this run may write (default 500).
  --requests-per-second <n>  Publisher requests per second (default 1, max 2).
  --restart                  Clear the cursor first, re-surveying every month.

A retryable failure stops the run with the cursor on the last finished month;
run again with the same arguments to resume.`;

type BackfillFlags = {
  apply: boolean;
  restart: boolean;
  resultsOut: string | undefined;
  newest: EcjBackfillMonth;
  oldest: EcjBackfillMonth;
  requestsPerSecond: number;
  maxMonths: number;
  maxIngests: number;
};

/** The run's flags, or the exit code a malformed command line ends with. */
const readFlags = (argv: readonly string[]): BackfillFlags | number => {
  const { flagValue, hasFlag, positiveInteger } = operatorFlags(USAGE, argv);
  const apply = hasFlag("apply");
  const resultsOut = flagValue("results-out");
  if (apply && resultsOut === undefined) {
    console.error("--results-out is required with --apply");
    return 1;
  }
  const newest =
    flagValue("newest") ??
    Temporal.Now.plainDateISO("UTC").toPlainYearMonth().toString();
  const oldest = flagValue("oldest") ?? ECJ_FIRST_MONTH;
  if (!isEcjBackfillMonth(newest) || !isEcjBackfillMonth(oldest)) {
    console.error("--newest and --oldest must be YYYY-MM");
    return 1;
  }
  const rateFlag = flagValue("requests-per-second");
  const requestsPerSecond = rateFlag === undefined ? 1 : Number(rateFlag);
  if (
    !Number.isFinite(requestsPerSecond) ||
    requestsPerSecond <= 0 ||
    requestsPerSecond > 2
  ) {
    console.error("--requests-per-second must be greater than 0 and at most 2");
    return 1;
  }
  return {
    apply,
    restart: hasFlag("restart"),
    resultsOut,
    newest,
    oldest,
    requestsPerSecond,
    maxMonths: positiveInteger(flagValue("max-months"), 12, "max-months"),
    maxIngests: positiveInteger(flagValue("max-ingests"), 500, "max-ingests"),
  };
};

/** The durable cursor, advanced only by compare-and-set. */
const checkpointStore = (rootDb: CaseLawRootHandle) => ({
  loadCursor: async (): Promise<EcjBackfillMonth | null> =>
    (
      await withAggregateTransaction(rootDb, async (tx) =>
        tx
          .select({ cursor: databaseBackfillStates.cursor })
          .from(databaseBackfillStates)
          .where(eq(databaseBackfillStates.name, CHECKPOINT))
          .limit(1),
      )
    ).at(0)?.cursor ?? null,
  advanceCursor: async (
    expected: EcjBackfillMonth | null,
    next: EcjBackfillMonth,
  ): Promise<boolean> =>
    await withAggregateTransaction(rootDb, async (tx) => {
      await tx
        .insert(databaseBackfillStates)
        .values({ name: CHECKPOINT, batch: initialBatchState() })
        .onConflictDoNothing();
      const advanced = await tx
        .update(databaseBackfillStates)
        .set({ cursor: next, updatedAt: new Date() })
        .where(
          and(
            eq(databaseBackfillStates.name, CHECKPOINT),
            expected === null
              ? isNull(databaseBackfillStates.cursor)
              : eq(databaseBackfillStates.cursor, expected),
          ),
        )
        .returning({ name: databaseBackfillStates.name });
      return advanced.length === 1;
    }),
  restart: async (): Promise<void> => {
    await withAggregateTransaction(rootDb, async (tx) => {
      await tx
        .update(databaseBackfillStates)
        .set({ cursor: null, updatedAt: new Date() })
        .where(eq(databaseBackfillStates.name, CHECKPOINT));
    });
  },
});

/** Which source document identities a stored eu-ecj row already holds. */
const heldIdentitiesIn =
  (ingestionDb: CaseLawIngestionHandle, sourceId: SafeId<"caseLawSource">) =>
  async (identities: readonly string[]): Promise<Set<string>> => {
    const held = new Set<string>();
    for (const identityChunk of chunkItems(identities, HELD_LOOKUP_CHUNK)) {
      // db-await-in-loop: bounded IN-list chunks over the (source, document) identity index
      const rows = await ingestionDb((tx) =>
        tx
          .select({ sourceDocumentId: caseLawDecisions.sourceDocumentId })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.sourceId, sourceId),
              inArray(caseLawDecisions.sourceDocumentId, identityChunk),
            ),
          )
          .limit(identityChunk.length),
      );
      for (const { sourceDocumentId } of rows) {
        if (sourceDocumentId !== null) {
          held.add(sourceDocumentId);
        }
      }
    }
    return held;
  };

type VariantIngestOptions = {
  ingestionDb: CaseLawIngestionHandle;
  sourceId: SafeId<"caseLawSource">;
  /** Null in a plan run, which never ingests. */
  sourceLease: CaseLawSourceIngestionLease | null;
  signal: AbortSignal;
};

/** Fetch one variant through the adapter and write it through the pipeline. */
const ingestVariantWith = ({
  ingestionDb,
  sourceId,
  sourceLease,
  signal,
}: VariantIngestOptions) => {
  const resolveSourceContract = createSourceContractResolver(ingestionDb);
  return async ({
    celex,
    language,
  }: EcjCelexVariant): Promise<EcjVariantIngestOutcome> => {
    try {
      const decision = (
        await fetchDecisionsByCelex({
          celexNumbers: [celex],
          languages: [language],
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(VARIANT_FETCH_TIMEOUT_MS),
          ]),
        })
      ).at(0);
      if (decision === undefined) {
        return { type: "unavailable" };
      }
      if (sourceLease === null) {
        return { type: "retryable", reason: "no-ingestion-lease" };
      }
      await sourceLease.beforeDatabaseMark();
      const observationOrder = await allocateSourceObservationOrder({
        leaseToken: sourceLease.leaseToken,
        scopedDb: ingestionDb,
        sourceId,
      });
      const processed = await processDecision(
        {
          input: decision,
          sourceId,
          scopedDb: ingestionDb,
          observedAt: new Date(),
          observationOrder,
          refresh: DECISION_REFRESH.ALWAYS,
        },
        resolveSourceContract,
      );
      return processed.status === PROCESS_DECISION_STATUS.RETRYABLE
        ? { type: "retryable", reason: processed.reason }
        : { type: "written" };
    } catch (error) {
      return { type: "retryable", reason: errorTag(error) };
    }
  };
};

/** Plan runs never journal: the walk writes outcomes only when it ingests. */
const journalTo =
  (resultsOut: string | undefined) =>
  async (entry: EcjBackfillJournalEntry): Promise<void> => {
    if (resultsOut !== undefined) {
      await appendFile(resultsOut, `${JSON.stringify(entry)}\n`, {
        mode: 0o600,
      });
    }
  };

const listMonthWith =
  (signal: AbortSignal) =>
  async (month: EcjBackfillMonth): Promise<readonly EcjCelexVariant[]> => {
    const [year = 0, index = 0] = month.split("-").map(Number);
    return await listEcjMonthVariants({
      year,
      month: index,
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(ECJ_LISTING_TIMEOUT_MS),
      ]),
    });
  };

type BackfillSessionOptions = {
  flags: BackfillFlags;
  rootDb: CaseLawRootHandle;
  ingestionDb: CaseLawIngestionHandle;
  sourceId: SafeId<"caseLawSource">;
  sourceLease: CaseLawSourceIngestionLease | null;
};

const runBackfillSession = async ({
  flags,
  rootDb,
  ingestionDb,
  sourceId,
  sourceLease,
}: BackfillSessionOptions): Promise<number> => {
  const checkpoint = checkpointStore(rootDb);
  if (flags.apply && flags.restart) {
    await checkpoint.restart();
  }
  const interruption = new AbortController();
  process.once("SIGINT", () => interruption.abort());
  process.once("SIGTERM", () => interruption.abort());
  const ingest = ingestVariantWith({
    ingestionDb,
    sourceId,
    sourceLease,
    signal: interruption.signal,
  });
  const report = await withPublisherRequestRateLimit({
    gateId: "cellar-eu",
    requestsPerSecond: flags.requestsPerSecond,
    operation: async () =>
      await runEcjLanguageBackfill({
        newest: flags.newest,
        oldest: flags.oldest,
        apply: flags.apply,
        maxMonths: flags.maxMonths,
        maxIngests: flags.maxIngests,
        signal: interruption.signal,
        listMonth: listMonthWith(interruption.signal),
        identityOf: ({ celex, language }) =>
          ecjSourceDocumentId(celex, language.toLowerCase()),
        heldIdentities: heldIdentitiesIn(ingestionDb, sourceId),
        loadCursor: checkpoint.loadCursor,
        advanceCursor: checkpoint.advanceCursor,
        journal: journalTo(flags.resultsOut),
        ingest,
      }),
  });
  console.log(
    JSON.stringify({ mode: flags.apply ? "apply" : "plan", ...report }),
  );
  return report.status === "held" ? 1 : 0;
};

export const runEuEcjLanguageBackfill = async (
  argv: readonly string[],
): Promise<number> => {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const flags = readFlags(argv);
  if (typeof flags === "number") {
    return flags;
  }
  const lane = await enterCaseLawMaintenanceLane();
  const { rootDb, ingestionDb } = lane;
  try {
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
      return 1;
    }
    const sourceLease = flags.apply
      ? await acquireCaseLawSourceIngestionLease({
          scopedDb: ingestionDb,
          sourceId: source.id,
        })
      : null;
    if (flags.apply && sourceLease === null) {
      console.error(
        "Source eu-ecj is being ingested right now (lease held). Retry later.",
      );
      return 1;
    }
    if (flags.apply) {
      await refreshS3();
      await refreshCorpusS3();
    }
    try {
      return await runBackfillSession({
        flags,
        rootDb,
        ingestionDb,
        sourceId: source.id,
        sourceLease,
      });
    } finally {
      await sourceLease?.release();
    }
  } finally {
    await lane.release();
  }
};
