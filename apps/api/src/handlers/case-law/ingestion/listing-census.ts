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
 *
 * A completed census is extended rather than recounted when its end moves
 * later: the tip slice moved on, or the same end slice is asked for at a later
 * instant. The old end slice was the publisher's still-mutable tip when it was
 * counted, so the extension recounts it (the checkpoint keeps its count to
 * take back out) and continues from there; the earlier slices are not listed
 * again.
 */

import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources, SOURCE_TOTAL_ORIGIN } from "@/api/db/schema";
import { floorSliceWalk } from "@/api/handlers/case-law/ingestion/reconciliation-plan";
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
    /** The end slice's own count, taken back out when it is recounted. */
    lastSliceCount: nonNegativeInteger,
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
  /** A completed census whose end moved later; its end slice is recounted. */
  | { type: "extend"; completed: CompleteCheckpoint }
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
  /**
   * Floor date; the census starts at the slice holding it. Absent: the
   * source's sweep floor. Either way it must be one of the two floors below.
   */
  from?: Date | undefined;
  /**
   * End date, and the as-of of the total. Absent: resume the stored census,
   * or extend a completed one to the current tip, or start one ending `now`.
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

type ResolveStartOptions = {
  checkpoint: ListingCensusCheckpoint | undefined;
  fromSlice: string;
  toSlice: string;
  end: Date;
  /** Whether the caller named the end, rather than taking the tip. */
  explicitEnd: boolean;
};

type ResolvedStart = {
  toSlice: string;
  asOf: Date;
  start: ListingCensusStart;
};

const resolveStart = ({
  checkpoint,
  end,
  explicitEnd,
  fromSlice,
  toSlice,
}: ResolveStartOptions): ResolvedStart => {
  const requested = (start: ListingCensusStart): ResolvedStart => ({
    toSlice,
    asOf: end,
    start,
  });
  const adopted = (
    stored: ListingCensusCheckpoint,
    start: ListingCensusStart,
  ): ResolvedStart => ({
    toSlice: stored.toSlice,
    asOf: new Date(stored.asOf),
    start,
  });

  if (checkpoint === undefined) {
    return requested({ type: "fresh" });
  }
  if (checkpoint.fromSlice !== fromSlice) {
    return requested({ type: "restart", replaced: checkpoint });
  }
  switch (checkpoint.status) {
    case LISTING_CENSUS_STATUS.COUNTING:
      // An in-progress census keeps its own end until it completes; only an
      // explicitly different end replaces it.
      return !explicitEnd || checkpoint.toSlice === toSlice
        ? adopted(checkpoint, { type: "resume", checkpoint })
        : requested({ type: "restart", replaced: checkpoint });
    case LISTING_CENSUS_STATUS.COMPLETE: {
      if (toSlice < checkpoint.toSlice) {
        return requested({ type: "restart", replaced: checkpoint });
      }
      const later =
        toSlice > checkpoint.toSlice ||
        (explicitEnd && end.getTime() > new Date(checkpoint.asOf).getTime());
      return later
        ? requested({ type: "extend", completed: checkpoint })
        : adopted(checkpoint, { type: "complete", checkpoint });
    }
    default: {
      checkpoint satisfies never;
      return panic("unhandled listing census checkpoint");
    }
  }
};

/**
 * Read the stored checkpoint and decide what a call over this range would do,
 * without contacting the publisher or writing anything. A dry run is this.
 *
 * The floor is either the first slice the publisher lists or the source's
 * configured reconciliation floor, and nothing in between. The stored total
 * the census is compared against counts every decision the source holds, so
 * the denominator has to cover the range the source is meant to hold: the
 * whole listing, or, where an operator has floored the source because its
 * earlier years are held under another source (the Polish Supreme Court
 * before 2016-06-23 is republished by SAOS under `pl-courts`), the range from
 * that floor. The sweep never ingests below the floor, so only a floor raised
 * after older rows were ingested can leave the numerator wider; lowering the
 * floor back is the remedy, and a census from it recounts.
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
  if (to !== undefined && to.getTime() > now.getTime()) {
    return refuse(adapter.key, `end ${to.toISOString()} is in the future`);
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

  const floored = floorSliceWalk({
    adapterKey: adapter.key,
    config: row.config,
    now,
    walk,
  });
  if (Result.isError(floored)) {
    return Result.err(floored.error);
  }
  const sweepFloor = floored.value.firstSlice;
  const fromSlice = from === undefined ? sweepFloor : walk.sliceOf(from);
  if (fromSlice !== walk.firstSlice && fromSlice !== sweepFloor) {
    return refuse(
      adapter.key,
      `floor ${fromSlice} is neither the publisher's first slice ${walk.firstSlice} nor this source's reconciliation floor ${sweepFloor}`,
    );
  }
  const end = to ?? now;
  const toSlice = walk.sliceOf(end);
  if (toSlice < fromSlice) {
    return refuse(adapter.key, `end precedes floor ${fromSlice}`);
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

  return Result.ok({
    sourceId: row.id,
    fromSlice,
    ...resolveStart({
      checkpoint: parsed?.output,
      fromSlice,
      toSlice,
      end,
      explicitEnd: to !== undefined,
    }),
  });
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

type RecordSliceOptions = {
  tx: Transaction;
  adapterKey: string;
  sourceId: SafeId<"caseLawSource">;
  asOf: Date;
  observed: ListingCensusCheckpoint | null;
  next: ListingCensusCheckpoint;
};

type RecordedSlice = "advanced" | "completed" | "nothing-listed" | "superseded";

/**
 * Compare-and-set the checkpoint, and on the last slice write the total in
 * the same transaction. `IS NOT DISTINCT FROM` compares the stored jsonb with
 * the value this call read, so a checkpoint another call moved in between
 * matches no row and nothing is written.
 */
const recordSlice = async ({
  adapterKey,
  asOf,
  next,
  observed,
  sourceId,
  tx,
}: RecordSliceOptions): Promise<RecordedSlice> => {
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
  if (updated.length === 0) {
    return "superseded";
  }
  switch (next.status) {
    case LISTING_CENSUS_STATUS.COUNTING:
      return "advanced";
    case LISTING_CENSUS_STATUS.COMPLETE:
      if (next.total === 0) {
        return "nothing-listed";
      }
      await setSourceReportedTotal({
        scopedDb: async (write) => await write(tx),
        adapterKey,
        total: next.total,
        asOf,
        origin: SOURCE_TOTAL_ORIGIN.LISTING_CENSUS,
      });
      return "completed";
    default: {
      next satisfies never;
      return panic("unhandled listing census checkpoint");
    }
  }
};

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
  return listing.andThen((listed) => listed).map(({ keyed }) => keyed.size);
};

/** The checkpoint a call starts counting from, and the value it replaces. */
const startingCheckpoint = (
  plan: ListingCensusPlan,
): {
  checkpoint: CountingCheckpoint;
  observed: ListingCensusCheckpoint | null;
} => {
  const range = {
    status: LISTING_CENSUS_STATUS.COUNTING,
    fromSlice: plan.fromSlice,
    toSlice: plan.toSlice,
    asOf: plan.asOf.toISOString(),
  };
  const { start } = plan;
  switch (start.type) {
    case "fresh":
      return {
        checkpoint: {
          ...range,
          slicesCounted: 0,
          nextSlice: plan.fromSlice,
          counted: 0,
        },
        observed: null,
      };
    case "restart":
      return {
        checkpoint: {
          ...range,
          slicesCounted: 0,
          nextSlice: plan.fromSlice,
          counted: 0,
        },
        observed: start.replaced,
      };
    case "resume":
      return { checkpoint: start.checkpoint, observed: start.checkpoint };
    case "extend":
      return {
        checkpoint: {
          ...range,
          slicesCounted: start.completed.slicesCounted - 1,
          nextSlice: start.completed.toSlice,
          counted: start.completed.total - start.completed.lastSliceCount,
        },
        observed: start.completed,
      };
    case "complete":
      return panic("a complete census has no starting checkpoint");
    default: {
      start satisfies never;
      return panic("unhandled listing census start");
    }
  }
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
  if (plan.start.type === "complete") {
    return Result.ok({
      type: "already-complete",
      checkpoint: plan.start.checkpoint,
    });
  }

  let { checkpoint, observed } = startingCheckpoint(plan);
  for (let slicesThisRun = 0; slicesThisRun < maxSlices; slicesThisRun += 1) {
    if (slicesThisRun > 0) {
      await sleep(adapter.minRequestIntervalMs);
    }
    const target = checkpoint.nextSlice;
    const counted = await countSlice({ adapter, slice: target, sleep });
    if (Result.isError(counted)) {
      return counted;
    }
    const range = {
      fromSlice: checkpoint.fromSlice,
      toSlice: checkpoint.toSlice,
      asOf: checkpoint.asOf,
      slicesCounted: checkpoint.slicesCounted + 1,
    };
    const next: ListingCensusCheckpoint =
      target === plan.toSlice
        ? {
            status: LISTING_CENSUS_STATUS.COMPLETE,
            ...range,
            total: checkpoint.counted + counted.value,
            lastSliceCount: counted.value,
          }
        : {
            status: LISTING_CENSUS_STATUS.COUNTING,
            ...range,
            nextSlice:
              adapter.reconciliation.nextSlice(target) ??
              panic(
                `${adapter.key}: no slice after ${target}, before ${plan.toSlice}`,
              ),
            counted: checkpoint.counted + counted.value,
          };
    const previous = observed;
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- durable progress: each listed slice is checkpointed before the next is requested, so an interrupted census resumes instead of relisting
    const recorded = await scopedDb(
      async (tx) =>
        await recordSlice({
          tx,
          adapterKey: adapter.key,
          sourceId: plan.sourceId,
          asOf: plan.asOf,
          observed: previous,
          next,
        }),
    );
    switch (recorded) {
      case "superseded":
        return Result.ok({ type: "superseded", slicesThisRun });
      case "completed":
      case "nothing-listed":
        if (next.status !== LISTING_CENSUS_STATUS.COMPLETE) {
          return panic("a counting checkpoint cannot complete a census");
        }
        return Result.ok({
          type: recorded,
          checkpoint: next,
          slicesThisRun: slicesThisRun + 1,
        });
      case "advanced":
        if (next.status !== LISTING_CENSUS_STATUS.COUNTING) {
          return panic("a complete checkpoint cannot leave a census counting");
        }
        observed = next;
        checkpoint = next;
        break;
      default: {
        recorded satisfies never;
        return panic("unhandled listing census slice record");
      }
    }
  }

  return Result.ok({
    type: "counting",
    checkpoint,
    slicesThisRun: maxSlices,
  });
};
