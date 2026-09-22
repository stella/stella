/**
 * What every case-law backfill script does around its own pass.
 *
 * A pass that spends publisher requests and writes through the ingestion
 * pipeline needs the same five things before it starts: the maintenance lane,
 * the source row for its adapter, a reader for stored payloads, the source's
 * ingestion lease, and the lease released whatever happens. Each script
 * carried its own copy of that, which is five chances for one of them to skip
 * the lease or leak it.
 *
 * The script keeps what is its own — what the pass is, what it reports — and
 * asks for the rest here.
 */

import { Result } from "better-result";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import type { StoredRawReader } from "@/api/handlers/case-law/ingestion/adapter";
import type { SafeId } from "@/api/lib/branded-types";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";
import { readS3ObjectIfPresent, refreshS3 } from "@/api/lib/s3";

const BUDGET_PREFIX = "--budget=";
/** A stored payload is one document; nothing here should take longer. */
const STORED_RAW_READ_TIMEOUT_MS = 30_000;

/** What a pass is handed once the source is held. */
export type CaseLawSourceBackfillContext = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  sourceLease: CaseLawSourceIngestionLease;
  readStoredRaw: StoredRawReader;
  /** Absent where the caller passed no `--budget=`; the pass then picks. */
  requestBudget?: number | undefined;
};

/**
 * What a failed pass tells the operator.
 *
 * A pass that stops part-way has already put rows on the corpus, so it may
 * carry the report it had reached; an operator who cannot see those counts
 * cannot tell a first request that failed from a last one.
 */
type CaseLawSourceBackfillFailure<TReport> = {
  message: string;
  report?: TReport;
};

type RunCaseLawSourceBackfillOptions<
  TReport,
  TError extends CaseLawSourceBackfillFailure<TReport>,
> = {
  /** The adapter whose source row the pass runs against. */
  adapterKey: AdapterKey;
  /** `process.argv.slice(2)`, read for `--budget=<requests>`. */
  argv: readonly string[];
  run: (
    context: CaseLawSourceBackfillContext,
  ) => Promise<Result<TReport, TError>>;
};

/**
 * Hold the source, run one bounded pass, print its report, exit.
 *
 * `null` from the payload reader only where the store confirmed it holds no
 * such object, which is a durable fact about that decision. Anything else is
 * raised: it says nothing about the row, and reading it as an absent payload
 * would step over rows whose payloads are there.
 */
export const runCaseLawSourceBackfill = async <
  TReport,
  TError extends CaseLawSourceBackfillFailure<TReport>,
>({
  adapterKey,
  argv,
  run,
}: RunCaseLawSourceBackfillOptions<TReport, TError>): Promise<never> => {
  const budgetArgument = argv.find((argument) =>
    argument.startsWith(BUDGET_PREFIX),
  );
  const requestBudget =
    budgetArgument === undefined
      ? undefined
      : Number(budgetArgument.slice(BUDGET_PREFIX.length));
  if (requestBudget !== undefined && !Number.isSafeInteger(requestBudget)) {
    console.error(`${BUDGET_PREFIX}<requests> takes a whole number`);
    process.exit(1);
  }

  // Hold the maintenance lane before the first statement: operator passes over
  // the case-law tables serialize here instead of deadlocking on row locks.
  const { ingestionDb } = await enterCaseLawMaintenanceLane();
  await refreshS3();

  const source = (
    await ingestionDb((tx) =>
      tx
        .select({ id: caseLawSources.id, name: caseLawSources.name })
        .from(caseLawSources)
        .where(eq(caseLawSources.adapterKey, adapterKey))
        .limit(1),
    )
  ).at(0);
  if (!source) {
    console.error(`No case-law source configured for ${adapterKey}`);
    process.exit(1);
  }

  const sourceLease = await acquireCaseLawSourceIngestionLease({
    scopedDb: ingestionDb,
    sourceId: source.id,
  });
  if (sourceLease === null) {
    console.error(
      `Source ${adapterKey} is being ingested right now (lease held). Retry later.`,
    );
    process.exit(1);
  }

  let outcome: Result<TReport, TError>;
  try {
    outcome = await run({
      scopedDb: ingestionDb,
      sourceId: source.id,
      sourceLease,
      readStoredRaw: async (key) => {
        const bytes = await readS3ObjectIfPresent(
          key,
          AbortSignal.timeout(STORED_RAW_READ_TIMEOUT_MS),
        );
        return bytes === null ? null : new Uint8Array(bytes);
      },
      requestBudget,
    });
  } finally {
    // Released on every path, including a rejection the pass does not turn
    // into a `Result`: a failed pass must not leave the source locked against
    // the crawl until the lease expires.
    await sourceLease.release();
  }

  if (Result.isError(outcome)) {
    console.error(outcome.error.message);
    // The rows this pass did commit, where it carries them, so a failure at
    // the end of a long run does not read like a failure at its start.
    if (outcome.error.report !== undefined) {
      console.error(JSON.stringify(outcome.error.report, null, 2));
    }
    process.exit(1);
  }

  console.log(JSON.stringify(outcome.value, null, 2));
  process.exit(0);
};
