/**
 * A reported total for a source whose publisher states none, summed from the
 * publisher's own listing.
 *
 * Held-vs-total coverage needs a denominator. Where `getTotalCount` answers
 * `no-count-endpoint`, the reconciliation contract can still ask the publisher
 * what it lists for each slice; the sum over every slice from a floor to an
 * end is the total, recorded with origin `listing-census` and as of the end.
 * The standing reconciliation loop records the same per-slice counts, but it
 * sweeps newest-first at its own pace, so a total cannot wait for its ledger.
 *
 * A census is thousands of listing requests, so it runs in bounded calls and
 * resumes. The checkpoint lives in the source's `config` under
 * {@link LISTING_CENSUS_CONFIG_KEY}, not in the coverage ledger: a ledger row
 * is the reconciliation loop's own state (its `checkedAt` moves the historical
 * sweep's frontier, and a short row is re-walked), and a census that lists
 * without ingesting would tell the loop that slices it never reconciled were
 * surveyed. `config` is operator-owned and already carries the sweep's floor;
 * the ingestion role holds no grant on it, so the caller passes a handle from
 * the maintenance lane's owner connection.
 *
 * Replay safety: the checkpoint holds the running sum and the next slice, and
 * advances by compare-and-set against the value this call read, once per
 * slice, after that slice listed completely. An interrupted call loses at most
 * the slice in flight, which the next call lists again; an overlapping call
 * finds the checkpoint moved and stops as `superseded`. The last slice, the
 * completed checkpoint and the total are written in one transaction, so a
 * completed census writes the total exactly once.
 */

import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources, SOURCE_TOTAL_ORIGIN } from "@/api/db/schema";
import { listReconciliationSlice } from "@/api/handlers/case-law/ingestion/slice-listing";
import { setSourceReportedTotal } from "@/api/handlers/case-law/ingestion/source-totals";
import type { SafeId } from "@/api/lib/branded-types";
import {
  AdapterFetchError,
  ConfigurationError,
} from "@/api/lib/errors/tagged-errors";
import { ADAPTER_TIMEOUT } from "@/api/lib/legal-search/ingestion-constants";
import type { SourceAdapter } from "@/api/lib/legal-search/ingestion-types";
import { isRecord } from "@/api/lib/type-guards";

/** The key under the source's `config` that holds the census checkpoint. */
export const LISTING_CENSUS_CONFIG_KEY = "listingCensus";

/**
 * The most slices one call may list. One call holds the maintenance lane for
 * its whole run, so the caller's budget is bounded here rather than trusted;
 * at a one-second publisher gate this is well under an hour of listing.
 */
export const MAX_LISTING_CENSUS_SLICES_PER_RUN = 1000;

export const LISTING_CENSUS_STATUS = {
  COUNTING: "counting",
  COMPLETE: "complete",
} as const;

const nonNegativeInteger = v.pipe(v.number(), v.integer(), v.minValue(0));
const slice = v.pipe(v.string(), v.minLength(1));

const censusRangeFields = {
  fromSlice: slice,
  toSlice: slice,
  /** The instant the total is stated as of: the census's end. */
  asOf: v.pipe(v.string(), v.isoTimestamp()),
  slicesCounted: nonNegativeInteger,
};

const checkpointSchema = v.variant("status", [
  v.strictObject({
    status: v.literal(LISTING_CENSUS_STATUS.COUNTING),
    ...censusRangeFields,
    /** The first slice not yet counted. */
    nextSlice: slice,
    /** Distinct listed identities over every slice before `nextSlice`. */
    counted: nonNegativeInteger,
  }),
  v.strictObject({
    status: v.literal(LISTING_CENSUS_STATUS.COMPLETE),
    ...censusRangeFields,
    total: nonNegativeInteger,
  }),
]);

export type ListingCensusCheckpoint = v.InferOutput<typeof checkpointSchema>;

type CountingCheckpoint = Extract<
  ListingCensusCheckpoint,
  { status: typeof LISTING_CENSUS_STATUS.COUNTING }
>;

type CompleteCheckpoint = Extract<
  ListingCensusCheckpoint,
  { status: typeof LISTING_CENSUS_STATUS.COMPLETE }
>;

/**
 * What the adapter has to provide; the census touches nothing else. The key
 * is the source row's, which is a plain string column.
 */
export type ListingCensusAdapter = Pick<
  SourceAdapter,
  "minRequestIntervalMs" | "pageTimeoutMs" | "reconciliation"
> & { key: string };

/** How a call begins, decided from the stored checkpoint and the request. */
export type ListingCensusStart =
  | { type: "fresh" }
  /** A census over a different range was stored; this one replaces it. */
  | { type: "restart"; replaced: ListingCensusCheckpoint }
  | { type: "resume"; checkpoint: CountingCheckpoint }
  | { type: "complete"; checkpoint: CompleteCheckpoint };

export type ListingCensusPlan = {
  sourceId: SafeId<"caseLawSource">;
  fromSlice: string;
  toSlice: string;
  asOf: Date;
  start: ListingCensusStart;
};

type InspectListingCensusOptions = {
  scopedDb: ScopedDb;
  adapter: ListingCensusAdapter;
  /** Floor date; the census starts at the slice holding it. */
  from: Date;
  /**
   * End date, and the as-of of the total. Absent: resume the stored census
   * over the same floor whatever its end, or start one ending `now`.
   */
  to?: Date | undefined;
  now: Date;
};

const refuse = (
  adapterKey: string,
  detail: string,
): Result<never, ConfigurationError> =>
  Result.err(
    new ConfigurationError({
      message: `${adapterKey}: listing census refused: ${detail}`,
    }),
  );

const sameRange = (
  checkpoint: ListingCensusCheckpoint,
  { fromSlice, toSlice }: { fromSlice: string; toSlice: string },
): boolean =>
  checkpoint.fromSlice === fromSlice && checkpoint.toSlice === toSlice;

const startFrom = (checkpoint: ListingCensusCheckpoint): ListingCensusStart => {
  switch (checkpoint.status) {
    case LISTING_CENSUS_STATUS.COUNTING:
      return { type: "resume", checkpoint };
    case LISTING_CENSUS_STATUS.COMPLETE:
      return { type: "complete", checkpoint };
    default: {
      checkpoint satisfies never;
      return panic("unhandled listing census checkpoint");
    }
  }
};

/**
 * Read the stored checkpoint and decide what a call over this range would do,
 * without contacting the publisher or writing anything. A dry run is this.
 */
export const inspectListingCensus = async ({
  scopedDb,
  adapter,
  from,
  to,
  now,
}: InspectListingCensusOptions): Promise<
  Result<ListingCensusPlan, ConfigurationError>
> => {
  const walk = adapter.reconciliation;
  const fromSlice = walk.sliceOf(from);
  if (fromSlice < walk.firstSlice) {
    return refuse(
      adapter.key,
      `floor ${fromSlice} precedes the first slice the publisher lists, ${walk.firstSlice}`,
    );
  }
  if (to !== undefined && to.getTime() > now.getTime()) {
    return refuse(adapter.key, `end ${to.toISOString()} is in the future`);
  }
  if (to !== undefined && walk.sliceOf(to) < fromSlice) {
    return refuse(adapter.key, `end precedes floor ${fromSlice}`);
  }

  const row = (
    await scopedDb(
      async (tx) =>
        await tx
          .select({ id: caseLawSources.id, config: caseLawSources.config })
          .from(caseLawSources)
          .where(eq(caseLawSources.adapterKey, adapter.key))
          .limit(1),
    )
  ).at(0);
  if (row === undefined) {
    return refuse(adapter.key, "no case-law source row holds this adapter key");
  }
  // The checkpoint is written with `jsonb_set`, which needs an object to set
  // it in; replacing a config of another shape would drop what it holds.
  if (row.config !== null && !isRecord(row.config)) {
    return refuse(adapter.key, "the source's config is not a JSON object");
  }

  const stored = row.config?.[LISTING_CENSUS_CONFIG_KEY];
  const parsed =
    stored === undefined ? undefined : v.safeParse(checkpointSchema, stored);
  if (parsed !== undefined && !parsed.success) {
    return refuse(
      adapter.key,
      `the stored checkpoint is malformed: ${v.summarize(parsed.issues)}`,
    );
  }
  const checkpoint = parsed?.output;

  const fresh = (end: Date): ListingCensusPlan => ({
    sourceId: row.id,
    fromSlice,
    toSlice: walk.sliceOf(end),
    asOf: end,
    start:
      checkpoint === undefined
        ? { type: "fresh" }
        : { type: "restart", replaced: checkpoint },
  });
  const adopt = (existing: ListingCensusCheckpoint): ListingCensusPlan => ({
    sourceId: row.id,
    fromSlice: existing.fromSlice,
    toSlice: existing.toSlice,
    asOf: new Date(existing.asOf),
    start: startFrom(existing),
  });

  if (to === undefined) {
    return Result.ok(
      checkpoint?.fromSlice === fromSlice ? adopt(checkpoint) : fresh(now),
    );
  }
  const toSlice = walk.sliceOf(to);
  return Result.ok(
    checkpoint !== undefined && sameRange(checkpoint, { fromSlice, toSlice })
      ? adopt(checkpoint)
      : fresh(to),
  );
};

/** What one call did. */
export type ListingCensusOutcome =
  /** The budget ran out first; the next call resumes at `nextSlice`. */
  | {
      type: "counting";
      checkpoint: CountingCheckpoint;
      slicesThisRun: number;
    }
  /** The last slice was counted and the total written, by this call. */
  | { type: "completed"; checkpoint: CompleteCheckpoint; slicesThisRun: number }
  /**
   * Every slice was counted and the publisher listed nothing at all. No total
   * is written: zero is not a figure a publisher reports, and the writer
   * refuses it. The checkpoint still completes, so a re-run stays a no-op.
   */
  | {
      type: "nothing-listed";
      checkpoint: CompleteCheckpoint;
      slicesThisRun: number;
    }
  /** Already complete for this range; nothing was listed or written. */
  | { type: "already-complete"; checkpoint: CompleteCheckpoint }
  /** Another call moved the checkpoint first; this one stopped. */
  | { type: "superseded"; slicesThisRun: number };

export type RunListingCensusOptions = InspectListingCensusOptions & {
  /** Slices this call may list, at most `MAX_LISTING_CENSUS_SLICES_PER_RUN`. */
  maxSlices: number;
  sleep: (ms: number) => Promise<void>;
};

type AdvanceCheckpointOptions = {
  tx: Transaction;
  sourceId: SafeId<"caseLawSource">;
  observed: ListingCensusCheckpoint | null;
  next: ListingCensusCheckpoint;
};

/**
 * Compare-and-set the checkpoint. `IS NOT DISTINCT FROM` compares the stored
 * jsonb with the value this call read, so a checkpoint another call moved in
 * between matches no row.
 */
const advanceCheckpoint = async ({
  next,
  observed,
  sourceId,
  tx,
}: AdvanceCheckpointOptions): Promise<boolean> => {
  // audit: skip — public case-law corpus bookkeeping, no workspace data
  const updated = await tx
    .update(caseLawSources)
    .set({
      config: sql`jsonb_set(coalesce(${caseLawSources.config}, '{}'::jsonb), ${`{${LISTING_CENSUS_CONFIG_KEY}}`}::text[], ${JSON.stringify(next)}::text::jsonb)`,
    })
    .where(
      and(
        eq(caseLawSources.id, sourceId),
        sql`${caseLawSources.config} -> ${LISTING_CENSUS_CONFIG_KEY}::text IS NOT DISTINCT FROM ${observed === null ? null : JSON.stringify(observed)}::text::jsonb`,
      ),
    )
    .returning({ id: caseLawSources.id });
  return updated.length > 0;
};

const initialCheckpoint = (plan: ListingCensusPlan): CountingCheckpoint => ({
  status: LISTING_CENSUS_STATUS.COUNTING,
  fromSlice: plan.fromSlice,
  toSlice: plan.toSlice,
  asOf: plan.asOf.toISOString(),
  slicesCounted: 0,
  nextSlice: plan.fromSlice,
  counted: 0,
});

type CountSliceOptions = {
  adapter: ListingCensusAdapter;
  slice: string;
  sleep: (ms: number) => Promise<void>;
};

const countSlice = async ({
  adapter,
  slice: target,
  sleep,
}: CountSliceOptions): Promise<Result<number, AdapterFetchError>> => {
  const listing = await Result.tryPromise({
    try: async () =>
      await listReconciliationSlice({
        adapterKey: adapter.key,
        listSlicePage: adapter.reconciliation.listSlicePage,
        pageDelayMs: adapter.minRequestIntervalMs,
        pageTimeoutMs: adapter.pageTimeoutMs ?? ADAPTER_TIMEOUT.PAGE,
        slice: target,
        sleep,
      }),
    catch: (cause) =>
      AdapterFetchError.is(cause)
        ? cause
        : new AdapterFetchError({
            message: `Listing census could not list slice ${target}`,
            adapterKey: adapter.key,
            cursor: target,
            cause,
          }),
  });
  return listing.map(({ keyed }) => keyed.size);
};

/**
 * Count up to `maxSlices` more slices of a census, and write the total when
 * the last one is counted.
 *
 * Counted per slice is the distinct keyable identities the publisher listed,
 * which is what the reconciliation ledger records as `reported`, so the census
 * total and the ledger agree wherever both have counted a slice.
 *
 * A listing failure returns the error with every slice before it kept: the
 * next call resumes at the slice that failed.
 */
export const runListingCensus = async (
  options: RunListingCensusOptions,
): Promise<
  Result<ListingCensusOutcome, ConfigurationError | AdapterFetchError>
> => {
  const { adapter, maxSlices, scopedDb, sleep } = options;
  if (
    !Number.isSafeInteger(maxSlices) ||
    maxSlices < 1 ||
    maxSlices > MAX_LISTING_CENSUS_SLICES_PER_RUN
  ) {
    return refuse(
      adapter.key,
      `max slices must be an integer from 1 to ${MAX_LISTING_CENSUS_SLICES_PER_RUN}, got ${maxSlices}`,
    );
  }

  const planned = await inspectListingCensus(options);
  if (Result.isError(planned)) {
    return planned;
  }
  const plan = planned.value;
  const { start } = plan;
  if (start.type === "complete") {
    return Result.ok({
      type: "already-complete",
      checkpoint: start.checkpoint,
    });
  }

  let observed: ListingCensusCheckpoint | null = null;
  let checkpoint = initialCheckpoint(plan);
  switch (start.type) {
    case "resume":
      observed = start.checkpoint;
      checkpoint = start.checkpoint;
      break;
    case "restart":
      observed = start.replaced;
      break;
    case "fresh":
      break;
    default: {
      start satisfies never;
      return panic("unhandled listing census start");
    }
  }

  for (let slicesThisRun = 0; slicesThisRun < maxSlices; slicesThisRun += 1) {
    if (slicesThisRun > 0) {
      await sleep(adapter.minRequestIntervalMs);
    }
    const target = checkpoint.nextSlice;
    const counted = await countSlice({ adapter, slice: target, sleep });
    if (Result.isError(counted)) {
      return counted;
    }
    const counting = {
      ...checkpoint,
      counted: checkpoint.counted + counted.value,
      slicesCounted: checkpoint.slicesCounted + 1,
    };

    if (target === plan.toSlice) {
      const complete = {
        status: LISTING_CENSUS_STATUS.COMPLETE,
        fromSlice: counting.fromSlice,
        toSlice: counting.toSlice,
        asOf: counting.asOf,
        slicesCounted: counting.slicesCounted,
        total: counting.counted,
      };
      const previous = observed;
      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- the loop's last iteration: completes the census once
      const finished = await scopedDb(async (tx) => {
        if (
          !(await advanceCheckpoint({
            tx,
            sourceId: plan.sourceId,
            observed: previous,
            next: complete,
          }))
        ) {
          return "superseded" as const;
        }
        if (complete.total === 0) {
          return "nothing-listed" as const;
        }
        await setSourceReportedTotal({
          scopedDb: async (write) => await write(tx),
          adapterKey: adapter.key,
          total: complete.total,
          asOf: plan.asOf,
          origin: SOURCE_TOTAL_ORIGIN.LISTING_CENSUS,
        });
        return "completed" as const;
      });
      if (finished === "superseded") {
        return Result.ok({ type: "superseded", slicesThisRun });
      }
      return Result.ok({
        type: finished,
        checkpoint: complete,
        slicesThisRun: slicesThisRun + 1,
      });
    }

    const nextSlice =
      adapter.reconciliation.nextSlice(target) ??
      panic(`${adapter.key}: no slice after ${target}, before ${plan.toSlice}`);
    const next = { ...counting, nextSlice };
    const previous = observed;
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- checkpoint after each listed slice, so an interruption loses at most one
    const advanced = await scopedDb(
      async (tx) =>
        await advanceCheckpoint({
          tx,
          sourceId: plan.sourceId,
          observed: previous,
          next,
        }),
    );
    if (!advanced) {
      return Result.ok({ type: "superseded", slicesThisRun });
    }
    observed = next;
    checkpoint = next;
  }

  return Result.ok({
    type: "counting",
    checkpoint,
    slicesThisRun: maxSlices,
  });
};
