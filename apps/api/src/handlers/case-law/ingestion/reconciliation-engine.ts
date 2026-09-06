/**
 * One unit of listing reconciliation for one source.
 *
 * A forward-only crawl cursor is the only record of what it saw, so anything a
 * page dropped while the cursor moved past it is never revisited. Where a
 * publisher can be asked what it lists for a slice independently of that
 * cursor, the question becomes answerable: enumerate the slice, key each item
 * the way the ingest would key it, and compare against the identities already
 * held. The difference is the work.
 *
 * The hunt has to end. An item the publisher lists but never serves would
 * otherwise keep its slice short forever and be re-fetched on every visit, so
 * a repeatedly failing item is parked on a widening schedule and finally
 * retired; a retired item counts as accounted for, which is what lets a slice
 * settle and stay settled.
 *
 * Everything here runs under the source's ingestion lease, because it writes
 * through the same `processDecision` a crawl feeds and must not interleave
 * with one. Ledger semantics for a reconciled source are owned here:
 * `reported` is the distinct keyable identities the publisher listed for the
 * slice, `collected` is how many of those are held. Items with nothing to key
 * on are counted in the summary and excluded from both, since a slice that
 * counted them could never settle.
 */

import { panic } from "better-result";
import type { SQL } from "drizzle-orm";
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  min,
  notInArray,
} from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCoverageSlices,
  caseLawDecisions,
  RECONCILIATION_ITEM_STATUS,
} from "@/api/db/schema";
import {
  recordSliceCoverage,
  recordSliceWalkFailure,
  touchSliceCoverages,
} from "@/api/handlers/case-law/ingestion/coverage-ledger";
import {
  allocateSourceObservationOrder,
  PROCESS_DECISION_STATUS,
  processDecision,
} from "@/api/handlers/case-law/ingestion/pipeline";
import type {
  FailedSliceCandidate,
  LedgerSlice,
  ReconciliationWorkUnit,
  SliceWalkReason,
} from "@/api/handlers/case-law/ingestion/reconciliation-plan";
import {
  RECONCILIATION_FAILED_SLICE_RETRY_MS,
  RECONCILIATION_SETTLED_RECHECK_MS,
  RECONCILIATION_SLICE_STALE_MS,
  partitionShortSliceCandidates,
  selectReconciliationWorkUnit,
  tipWindowSlices,
} from "@/api/handlers/case-law/ingestion/reconciliation-plan";
import type { SafeId } from "@/api/lib/branded-types";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorSystemFields, errorTag } from "@/api/lib/errors/utils";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { storedObservationHasDetail } from "@/api/lib/legal-search/ingestion-normalization";
import type {
  ListingIdentity,
  ReconciliationListingItem,
  SourceReconciliation,
} from "@/api/lib/legal-search/ingestion-types";
import {
  listingIdentityKey,
  parseListingIdentityKey,
} from "@/api/lib/legal-search/ingestion-types";
import {
  countTerminalReconciliationItemsBySlice,
  parkReconciliationItem,
  pruneUnlistedTerminalItems,
  resolveReconciliationItem,
  resolveReconciliationItems,
  retireReconciliationItem,
  selectDueReconciliationItems,
  selectTrackedIdentityKeys,
} from "@/api/lib/legal-search/reconciliation-store";
import { logger } from "@/api/lib/observability/logger";
import { pgErrorFields } from "@/api/lib/pg-error";

/** Parked items rebuilt in one unit; each costs a publisher fetch. */
const PARKED_RETRY_BATCH = 25;
/**
 * Decisions ingested per slice walk unless the unit says otherwise. A slice
 * the source barely stored can be missing hundreds; the cap keeps one unit
 * finite, and the slice records short afterwards, so it is selected again
 * rather than forgotten.
 */
export const DEFAULT_SLICE_INGEST_BUDGET = 50;
/**
 * The most a unit may be asked to ingest. One walk holds the source lease for
 * its whole run, so the option is bounded here rather than trusted.
 *
 * A count is not a clock: this bounds how many documents a unit fetches, not
 * how long they take. `RECONCILIATION_INGEST_BUDGET_MS` is what keeps a unit
 * inside the caller's deadline.
 */
export const MAX_SLICE_INGEST_BUDGET = 1000;
/** Identity lookups per query, matching the publishers' own page size. */
const HELD_LOOKUP_CHUNK = 100;
/** Short ledger rows examined per unit when looking for an unsettled one. */
const SHORT_SLICE_CANDIDATES = 25;
/**
 * Politeness pause between listing requests. A slice is several requests and
 * a full history is thousands of them, so without a floor the survey would
 * hit a publisher harder than the crawl it reconciles.
 */
const LIST_DELAY_MS = 200;
const LIST_TIMEOUT_MS = 60_000;
/**
 * Pages requested for one slice before the walk gives up on it.
 *
 * `totalPages` is the publisher's number and the response validators only
 * require it to be a number at all. Without a ceiling one wrong value turns a
 * single work unit into an unbounded request sequence against that publisher.
 * Far above any real slice, so reaching it means the listing is not walkable
 * rather than merely large.
 */
const MAX_SLICE_PAGES = 200;
/** Terminal rows examined when pruning a walked slice. */
const PRUNE_ROW_LIMIT = 1000;
/** One document; nothing in an item's build should take longer. */
const ITEM_FETCH_TIMEOUT_MS = 2 * 60_000;
/**
 * Wall-clock the INGEST phase may spend before it stops fetching documents.
 *
 * The count ceilings above bound requests, not time: every document may spend
 * `ITEM_FETCH_TIMEOUT_MS` before it settles, so a budget's worth of them is
 * hours of lawful work, not the minutes the politeness gap alone suggests. The
 * caller runs a unit under a hard deadline that exits the process on the theory
 * that anything slower is wedged, so work that can outlast that deadline while
 * progressing is indistinguishable from a hang, and the walk that would have
 * finished is killed along with every other loop sharing the process.
 *
 * Bounding the ingest phase is safe because stopping is already a modelled
 * state: what it did not reach is `deferred` exactly as when the count budget
 * runs out, the slice records short, and the next unit resumes there.
 *
 * The LISTING phase deliberately has no such budget. It has nowhere to resume
 * from: `walkSlice` always starts at page 0, no page cursor is persisted, and a
 * partial listing may not be written (see the page ceiling). Cutting listing
 * off on a clock would turn a slice that lists slowly into one that restarts,
 * throws at the same page, and is never reconciled at all -- strictly worse
 * than letting it finish. So listing is bounded by `MAX_SLICE_PAGES` alone, and
 * the caller's deadline is derived to sit above that, not underneath it.
 */
export const RECONCILIATION_INGEST_BUDGET_MS = 30 * 60_000;
/**
 * The longest a lawful listing can take: every page may spend its timeout, and
 * the politeness pause separates them. Exported because the caller's hard
 * deadline has to clear it -- a backstop for a wedged await must sit above
 * everything a healthy unit can do, and a complete listing of a large slice is
 * the slowest of those things.
 */
export const RECONCILIATION_LISTING_WORST_CASE_MS =
  MAX_SLICE_PAGES * (LIST_DELAY_MS + LIST_TIMEOUT_MS);
/**
 * Headroom on top of the phases above: the request already in flight when the
 * ingest budget runs out, plus the ledger writes that close the unit.
 * Comfortably above `ITEM_FETCH_TIMEOUT_MS`, which is the longest of them.
 */
export const RECONCILIATION_UNIT_SETTLE_MS = 15 * 60_000;

export type ReconciliationUnitSummary = {
  unit: ReconciliationWorkUnit["type"];
  reason: SliceWalkReason | null;
  slice: string | null;
  /** Items the publisher listed, including repeats and unkeyable ones. */
  listed: number;
  /** Distinct keyable identities; this is what the ledger's `reported` is. */
  keyable: number;
  unidentifiable: number;
  duplicate: number;
  heldBefore: number;
  /**
   * Listed identities that are missing but already tracked, so this walk left
   * them to the due-retry path instead of re-fetching them.
   */
  scheduled: number;
  written: number;
  parked: number;
  terminal: number;
  resolved: number;
  failed: number;
  /** Misses left for the next visit because this unit's budget ran out. */
  deferred: number;
  /** Retired rows dropped because the slice no longer lists their identity. */
  pruned: number;
};

const emptySummary = (
  unit: ReconciliationWorkUnit["type"],
): ReconciliationUnitSummary => ({
  unit,
  reason: null,
  slice: null,
  listed: 0,
  keyable: 0,
  unidentifiable: 0,
  duplicate: 0,
  heldBefore: 0,
  scheduled: 0,
  written: 0,
  parked: 0,
  terminal: 0,
  resolved: 0,
  failed: 0,
  deferred: 0,
  pruned: 0,
});

/**
 * What one unit produced. `leased` is not a failure: another writer holds the
 * source, so this iteration has no work and the next one asks again.
 */
export type ReconciliationUnitOutcome =
  | { type: "worked"; summary: ReconciliationUnitSummary }
  | { type: "idle" }
  | { type: "leased" };

/**
 * How long this process holds a slice whose walk threw before offering it
 * again. The ledger records the failure durably and re-tests it on its own
 * cadence (`RECONCILIATION_FAILED_SLICE_RETRY_MS`, and the tip's own
 * staleness for tip slices); this hold is the process's short memory of a
 * failure it has just seen, so a walk whose ledger write itself failed is not
 * handed straight back. An hour: short against the daily cadences, long
 * enough that a slice nothing can serve costs its source one turn an hour
 * instead of one a minute.
 */
export const RECONCILIATION_SLICE_RETRY_MS = 60 * 60_000;

/** Longest `walk_error` text recorded; the ledger is a note, not a log. */
const WALK_ERROR_MAX_LENGTH = 500;

/** The failure as the ledger records it: its tag, then its message. */
const describeWalkError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return `${errorTag(error)}: ${message}`.slice(0, WALK_ERROR_MAX_LENGTH);
};

/**
 * When each slice whose walk threw may be tried again, by slice.
 *
 * Held by the caller, one map per source, for the same reason the loop holds
 * its per-source failure deadlines: the state is about this process's recent
 * attempts, not about the corpus, and a restart is entitled to try everything
 * once more.
 */
export type SliceRetrySchedule = Map<string, number>;

export type ReconciliationWorkUnitOptions = {
  adapterKey: string;
  sourceId: SafeId<"caseLawSource">;
  reconciliation: SourceReconciliation;
  scopedDb: ScopedDb;
  now: () => Date;
  /** Gap between two document fetches; the loop's politeness contract. */
  fetchDelayMs: number;
  /**
   * Decisions one slice walk may ingest, at most `MAX_SLICE_INGEST_BUDGET`;
   * `DEFAULT_SLICE_INGEST_BUDGET` when absent. Deployment configuration like the fetch delay: a walk lists the
   * whole slice whatever the budget, so the budget sets how much of one
   * listing a unit turns into writes before its deadline.
   */
  sliceIngestBudget?: number | undefined;
  sleep: (ms: number) => Promise<void>;
  /** Read and updated in place; see `SliceRetrySchedule`. */
  sliceRetries: SliceRetrySchedule;
};

type KeyedListingItem = ReconciliationListingItem & {
  identityKey: string;
  /** The slice this item was listed in; where a park records it. */
  slice: string;
};

/**
 * Run `visit` over the values in bounded chunks, one chunk at a time.
 *
 * The chunking is the point: a listing walk asks about as many identities as
 * the publisher paged, and one `IN` list of that size is an unbounded query.
 * Sequential rather than fanned out, so a walk cannot take the whole
 * connection pool from the crawl running beside it.
 */
const forEachChunk = async <T>(
  values: readonly T[],
  visit: (chunk: T[]) => Promise<void>,
): Promise<void> => {
  for (let index = 0; index < values.length; index += HELD_LOOKUP_CHUNK) {
    await visit(values.slice(index, index + HELD_LOOKUP_CHUNK));
  }
};

/**
 * The extra condition `heldRequiresDetail` adds to a held lookup, or nothing.
 *
 * Both halves of the identity index take it, and that is the point: a filter
 * applied to one query and not the other would make a source's heldness mean
 * two different things depending on whether the publisher happened to state a
 * document id for the item.
 */
const detailCondition = (requireDetail: boolean): SQL | undefined =>
  requireDetail
    ? storedObservationHasDetail(caseLawDecisions.metadata)
    : undefined;

type HeldDocumentIdsOptions = {
  sourceId: SafeId<"caseLawSource">;
  documentIds: readonly string[];
  /** See `SourceReconciliation.heldRequiresDetail`. */
  requireDetail: boolean;
};

/** Which of these publisher document ids this source already has rows for. */
const selectHeldDocumentIds = async (
  scopedDb: ScopedDb,
  { documentIds, requireDetail, sourceId }: HeldDocumentIdsOptions,
): Promise<string[]> => {
  if (documentIds.length === 0) {
    return [];
  }
  const rows = await scopedDb(
    async (tx) =>
      await tx
        .select({ sourceDocumentId: caseLawDecisions.sourceDocumentId })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.sourceId, sourceId),
            inArray(caseLawDecisions.sourceDocumentId, [...documentIds]),
            detailCondition(requireDetail),
          ),
        )
        .limit(documentIds.length),
  );
  return rows.flatMap((row) =>
    row.sourceDocumentId === null ? [] : [row.sourceDocumentId],
  );
};

type HeldCaseNumbersOptions = {
  sourceId: SafeId<"caseLawSource">;
  language: string;
  caseNumbers: readonly string[];
  /** See `SourceReconciliation.heldRequiresDetail`. */
  requireDetail: boolean;
};

/**
 * The same question for the fallback half of the identity index: rows stored
 * without a publisher document id are keyed on the docket and the language, so
 * only those rows can answer for a listing item that carries no id.
 */
const selectHeldCaseNumbers = async (
  scopedDb: ScopedDb,
  { caseNumbers, language, requireDetail, sourceId }: HeldCaseNumbersOptions,
): Promise<string[]> => {
  if (caseNumbers.length === 0) {
    return [];
  }
  const rows = await scopedDb(
    async (tx) =>
      await tx
        .select({ caseNumber: caseLawDecisions.caseNumber })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.sourceId, sourceId),
            inArray(caseLawDecisions.caseNumber, [...caseNumbers]),
            eq(caseLawDecisions.language, language),
            isNull(caseLawDecisions.sourceDocumentId),
            detailCondition(requireDetail),
          ),
        )
        .limit(caseNumbers.length),
  );
  return rows.map((row) => row.caseNumber);
};

/**
 * Record a held row under the same key its listing item would produce. The
 * key is never spelled out here: `listingIdentityKey` is the one rule, so a
 * held row and the item that asks about it cannot be keyed differently.
 */
const addHeldKey = (held: Set<string>, identity: ListingIdentity): void => {
  const key = listingIdentityKey(identity);
  if (key !== null) {
    held.add(key);
  }
};

type HeldIdentityKeysOptions = {
  sourceId: SafeId<"caseLawSource">;
  identities: readonly ListingIdentity[];
  /** See `SourceReconciliation.heldRequiresDetail`. */
  requireDetail: boolean;
};

/** The identity keys, out of the given ones, this source already holds. */
const selectHeldIdentityKeys = async (
  scopedDb: ScopedDb,
  { identities, requireDetail, sourceId }: HeldIdentityKeysOptions,
): Promise<Set<string>> => {
  const documentIds = new Set<string>();
  const caseNumbersByLanguage = new Map<string, Set<string>>();
  for (const identity of identities) {
    if (identity.type === "document") {
      documentIds.add(identity.sourceDocumentId);
      continue;
    }
    if (identity.type === "case-number") {
      const forLanguage =
        caseNumbersByLanguage.get(identity.language) ?? new Set<string>();
      forLanguage.add(identity.caseNumber);
      caseNumbersByLanguage.set(identity.language, forLanguage);
    }
  }

  const held = new Set<string>();
  await forEachChunk([...documentIds], async (chunk) => {
    for (const sourceDocumentId of await selectHeldDocumentIds(scopedDb, {
      sourceId,
      documentIds: chunk,
      requireDetail,
    })) {
      addHeldKey(held, { type: "document", sourceDocumentId });
    }
  });

  for (const [language, caseNumbers] of caseNumbersByLanguage) {
    await forEachChunk([...caseNumbers], async (chunk) => {
      for (const caseNumber of await selectHeldCaseNumbers(scopedDb, {
        sourceId,
        language,
        caseNumbers: chunk,
        requireDetail,
      })) {
        addHeldKey(held, { type: "case-number", caseNumber, language });
      }
    });
  }
  return held;
};

type LedgerRow = {
  slice: string;
  reported: number | null;
  collected: number | null;
  checkedAt: Date;
};

/**
 * The counted shape of a ledger row. Every read below that hands rows to the
 * selection filters on `walk_error IS NULL`, and the table's counted-or-failed
 * check makes both counts present on such a row; a null here is a violated
 * invariant, not a case.
 */
const countedLedgerSlice = ({
  checkedAt,
  collected,
  reported,
  slice,
}: LedgerRow): LedgerSlice => {
  if (reported === null || collected === null) {
    panic(`coverage slice ${slice} is neither counted nor failed`);
  }
  return { slice, reported, collected, checkedAt };
};

type TipCheckedAt = { slice: string; checkedAt: Date };

/**
 * When each of the named slices was last walked, counted or failed alike.
 * Bounded by the tip window. A failed tip row keeps its `checkedAt` here on
 * purpose: the tip arm walks a slice once it is stale, so a tip slice whose
 * walk failed rests the tip's own day, on every replica and across restarts,
 * rather than being taken for never walked and offered straight back.
 */
const selectTipCheckedAt = async (
  scopedDb: ScopedDb,
  sourceId: SafeId<"caseLawSource">,
  slices: readonly string[],
): Promise<TipCheckedAt[]> => {
  if (slices.length === 0) {
    return [];
  }
  return await scopedDb(
    async (tx) =>
      await tx
        .select({
          slice: caseLawCoverageSlices.slice,
          checkedAt: caseLawCoverageSlices.checkedAt,
        })
        .from(caseLawCoverageSlices)
        .where(
          and(
            eq(caseLawCoverageSlices.sourceId, sourceId),
            inArray(caseLawCoverageSlices.slice, [...slices]),
          ),
        )
        .limit(slices.length),
  );
};

type SelectStaleShortSlicesOptions = {
  sourceId: SafeId<"caseLawSource">;
  staleBefore: Date;
  /**
   * Slices held for retry, excluded in the query rather than by the caller.
   * The read is a bounded oldest-first window, so a held row filtered
   * afterwards still occupies a place in it: enough of them fill the window
   * and every short slice behind them becomes unreachable, which is the same
   * starvation the settled-row touch exists to prevent.
   */
  heldSlices: string[];
};

/**
 * Slices the ledger records as short and has not re-checked recently, oldest
 * first. This is the first reader of the ledger's short-slice partial index.
 */
const selectStaleShortSlices = async (
  scopedDb: ScopedDb,
  { heldSlices, sourceId, staleBefore }: SelectStaleShortSlicesOptions,
): Promise<LedgerSlice[]> => {
  const rows = await scopedDb(
    async (tx) =>
      await tx
        .select({
          slice: caseLawCoverageSlices.slice,
          reported: caseLawCoverageSlices.reported,
          collected: caseLawCoverageSlices.collected,
          checkedAt: caseLawCoverageSlices.checkedAt,
        })
        .from(caseLawCoverageSlices)
        .where(
          and(
            eq(caseLawCoverageSlices.sourceId, sourceId),
            lt(caseLawCoverageSlices.collected, caseLawCoverageSlices.reported),
            // A short row whose later walk failed belongs to the retry arm.
            isNull(caseLawCoverageSlices.walkError),
            // eslint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- staleness cutoff derived from the clock, not a cursor boundary: a slice landing within a microsecond of it is walked one turn earlier or later, which the widening tip cadence already tolerates
            lt(caseLawCoverageSlices.checkedAt, staleBefore),
            heldSlices.length === 0
              ? undefined
              : notInArray(caseLawCoverageSlices.slice, heldSlices),
          ),
        )
        .orderBy(caseLawCoverageSlices.checkedAt)
        .limit(SHORT_SLICE_CANDIDATES),
  );
  return rows.map(countedLedgerSlice);
};

/**
 * The oldest-checked settled slice below the tip window, or null. Whether it
 * is old enough to walk is the selection's decision, not this query's.
 *
 * Settled here means `collected >= reported`: the row says the publisher's own
 * count was met. Nothing else in the loop ever looks at such a row again, so it
 * keeps stating what the publisher listed on the day of the walk however long
 * the publisher goes on adding to that slice.
 *
 * That predicate is also what keeps this from fighting the settled-row touch in
 * the assembly below. The two populations are disjoint by construction: the
 * touch only ever re-stamps rows that are *short* and settled by retirement, so
 * those rows are permanently young, while the rows read here are never touched
 * at all and age freely. Sharing a population would break both — an oldest-first
 * read over the union would be answered by whichever half was larger, and the
 * rows that genuinely went stale would sit behind rows something else is
 * already re-stamping every turn.
 *
 * The boundary that leaves: a slice settled by retired items stays short, so it
 * lives in the touch population and its age is unobservable from `checkedAt`,
 * which today means both "walked" and "rotated out of the candidate window".
 * Separating the two is a schema change, not a query.
 *
 * One row, ordered, limit 1. The source's rows are reachable through
 * `case_law_coverage_slices_source_slice_idx`; the short partial index is the
 * exact complement of this predicate and deliberately does not serve it.
 */
type SelectRecheckCandidateOptions = {
  sourceId: SafeId<"caseLawSource">;
  /** The tip window's own start; slices at or above it are re-walked anyway. */
  belowSlice: string;
  /**
   * Held slices, excluded here for the same reason the backlog query excludes
   * them: this read is `LIMIT 1`, so a held row filtered afterwards is the
   * whole candidate set and the source reports idle while a later settled row
   * is due. Skipping one costs nothing, unlike the sweep — a settled slice
   * keeps its ledger row and stays selectable on a later turn.
   */
  heldSlices: string[];
};

const selectRecheckCandidate = async (
  scopedDb: ScopedDb,
  { belowSlice, heldSlices, sourceId }: SelectRecheckCandidateOptions,
): Promise<LedgerSlice | null> => {
  const row = (
    await scopedDb(
      async (tx) =>
        await tx
          .select({
            slice: caseLawCoverageSlices.slice,
            reported: caseLawCoverageSlices.reported,
            collected: caseLawCoverageSlices.collected,
            checkedAt: caseLawCoverageSlices.checkedAt,
          })
          .from(caseLawCoverageSlices)
          .where(
            and(
              eq(caseLawCoverageSlices.sourceId, sourceId),
              lt(caseLawCoverageSlices.slice, belowSlice),
              gte(
                caseLawCoverageSlices.collected,
                caseLawCoverageSlices.reported,
              ),
              isNull(caseLawCoverageSlices.walkError),
              heldSlices.length === 0
                ? undefined
                : notInArray(caseLawCoverageSlices.slice, heldSlices),
            ),
          )
          .orderBy(caseLawCoverageSlices.checkedAt)
          .limit(1),
    )
  ).at(0);
  return row === undefined ? null : countedLedgerSlice(row);
};

type SelectFailedSliceCandidateOptions = {
  sourceId: SafeId<"caseLawSource">;
  /** Held slices, excluded for the same reason the recheck excludes them. */
  heldSlices: string[];
};

/**
 * The oldest-checked slice whose last walk failed, or null. Whether it has
 * rested long enough is the selection's decision, not this query's. Served by
 * the ledger's failed partial index.
 */
const selectFailedSliceCandidate = async (
  scopedDb: ScopedDb,
  { heldSlices, sourceId }: SelectFailedSliceCandidateOptions,
): Promise<FailedSliceCandidate | null> =>
  (
    await scopedDb(
      async (tx) =>
        await tx
          .select({
            slice: caseLawCoverageSlices.slice,
            checkedAt: caseLawCoverageSlices.checkedAt,
          })
          .from(caseLawCoverageSlices)
          .where(
            and(
              eq(caseLawCoverageSlices.sourceId, sourceId),
              isNotNull(caseLawCoverageSlices.walkError),
              heldSlices.length === 0
                ? undefined
                : notInArray(caseLawCoverageSlices.slice, heldSlices),
            ),
          )
          .orderBy(caseLawCoverageSlices.checkedAt)
          .limit(1),
    )
  ).at(0) ?? null;

/**
 * The oldest slice this source has any ledger row for.
 *
 * The historical sweep fills downward and contiguously from the tip window, so
 * this single aggregate is its frontier: the slice below it is the newest one
 * never surveyed. Nothing else writes below the frontier, so the sweep cannot
 * skip a slice and call the source surveyed.
 */
const selectOldestLedgerSlice = async (
  scopedDb: ScopedDb,
  sourceId: SafeId<"caseLawSource">,
): Promise<string | null> => {
  const row = (
    await scopedDb(
      async (tx) =>
        await tx
          .select({ oldest: min(caseLawCoverageSlices.slice) })
          .from(caseLawCoverageSlices)
          .where(eq(caseLawCoverageSlices.sourceId, sourceId))
          .limit(1),
    )
  ).at(0);
  return row?.oldest ?? null;
};

/** Whether any parked item for this source has come due. */
const hasDueParkedItems = async (
  scopedDb: ScopedDb,
  sourceId: SafeId<"caseLawSource">,
  now: Date,
): Promise<boolean> =>
  (await selectDueReconciliationItems(scopedDb, { sourceId, now, limit: 1 }))
    .length > 0;

type IngestItemOptions = {
  adapterKey: string;
  item: KeyedListingItem;
  lease: CaseLawSourceIngestionLease;
  now: Date;
  reconciliation: SourceReconciliation;
  scopedDb: ScopedDb;
  slice: string;
  sourceId: SafeId<"caseLawSource">;
  summary: ReconciliationUnitSummary;
};

/**
 * Build and store one listed item, and dispose of it either way.
 *
 * The try/catch is the boundary around a publisher fetch and a pipeline
 * write: neither may take the loop down, and a throw is one more failed
 * attempt against this item rather than a lost one, so it is parked with the
 * same schedule an unavailable document gets.
 */
const ingestListedItem = async ({
  adapterKey,
  item,
  lease,
  now,
  reconciliation,
  scopedDb,
  slice,
  sourceId,
  summary,
}: IngestItemOptions): Promise<void> => {
  const park = async (tag: string): Promise<void> => {
    const parked = await parkReconciliationItem(scopedDb, {
      sourceId,
      slice,
      identityKey: item.identityKey,
      payload: item.payload,
      errorTag: tag,
      now,
    });
    if (parked.status === RECONCILIATION_ITEM_STATUS.TERMINAL) {
      summary.terminal += 1;
    } else {
      summary.parked += 1;
    }
  };

  try {
    const built = await reconciliation.buildDecision(
      item.payload,
      AbortSignal.timeout(ITEM_FETCH_TIMEOUT_MS),
    );
    switch (built.type) {
      case "unkeyable": {
        // The identity rule keyed this item and the build cannot: the two
        // disagree, and no retry resolves that, so it is retired straight
        // away rather than spending the whole schedule proving it.
        await retireReconciliationItem(scopedDb, {
          sourceId,
          slice,
          identityKey: item.identityKey,
          payload: item.payload,
          errorTag: "unkeyable",
          now,
        });
        summary.terminal += 1;
        return;
      }
      case "detail-unavailable": {
        // Deliberately not written: a listing-only row would make the
        // identity held, and the next walk would read the slice as
        // reconciled while the document stayed unread.
        await park("detail-unavailable");
        return;
      }
      case "built": {
        await lease.beforeDatabaseMark();
        const observationOrder = await allocateSourceObservationOrder({
          leaseToken: lease.leaseToken,
          scopedDb,
          sourceId,
        });
        const processed = await processDecision({
          input: built.decision,
          sourceId,
          scopedDb,
          observedAt: now,
          observationOrder,
        });
        if (processed.status === PROCESS_DECISION_STATUS.RETRYABLE) {
          await park(`retryable:${processed.reason}`);
          return;
        }
        summary.written += 1;
        await resolveReconciliationItem(scopedDb, {
          sourceId,
          identityKey: item.identityKey,
        });
        return;
      }
      default: {
        built satisfies never;
        panic(
          `Unhandled reconciliation build outcome: ${JSON.stringify(built)}`,
        );
      }
    }
  } catch (error) {
    summary.failed += 1;
    logger.warn("case_law.reconciliation.item_failed", {
      adapterKey,
      slice,
      identityKey: item.identityKey,
      // The park below keeps only the tag, which cannot separate a publisher
      // refusing one document from the corpus refusing to store it. These two
      // carry that distinction as fixed vocabulary (driver and system codes,
      // the SQLSTATE, the schema identifiers Postgres names) rather than as
      // message text, which quotes the statement and can quote the row that
      // failed; the logger's sanitizer is a key denylist, so text this sink
      // emitted would reach telemetry verbatim.
      ...errorSystemFields(error),
      ...pgErrorFields(error),
    });
    await park(errorTag(error));
  }
};

type WalkSliceOptions = {
  adapterKey: string;
  fetchDelayMs: number;
  ingestBudget: number;
  lease: CaseLawSourceIngestionLease;
  now: () => Date;
  reason: SliceWalkReason;
  reconciliation: SourceReconciliation;
  scopedDb: ScopedDb;
  slice: string;
  sleep: (ms: number) => Promise<void>;
  sourceId: SafeId<"caseLawSource">;
};

/**
 * List a slice end to end, ingest what is missing up to the unit's budget,
 * and record what the slice looks like afterwards.
 *
 * The ledger row is written from what this walk observed, not from what it
 * managed to fix: `collected` counts identities held after the walk, so a
 * slice whose misses exceeded the budget records short and is selected again.
 */
const walkSlice = async ({
  adapterKey,
  fetchDelayMs,
  ingestBudget,
  lease,
  now,
  reason,
  reconciliation,
  scopedDb,
  slice,
  sleep,
  sourceId,
}: WalkSliceOptions): Promise<ReconciliationUnitSummary> => {
  const summary = emptySummary("slice");
  summary.reason = reason;
  summary.slice = slice;

  const keyed = new Map<string, KeyedListingItem>();
  for (let page = 0; ; page += 1) {
    if (page > 0) {
      await sleep(LIST_DELAY_MS);
    }
    const listed = await reconciliation.listSlicePage({
      slice,
      page,
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    summary.listed += listed.items.length;
    for (const item of listed.items) {
      const identityKey = listingIdentityKey(item.identity);
      if (identityKey === null) {
        summary.unidentifiable += 1;
        continue;
      }
      if (keyed.has(identityKey)) {
        // A publisher lists a document once per docket it settles; ingesting
        // the same identity twice in one walk would only have the second
        // observation refresh the first.
        summary.duplicate += 1;
        continue;
      }
      keyed.set(identityKey, { ...item, identityKey, slice });
    }
    if (page + 1 >= listed.totalPages) {
      break;
    }
    if (page + 1 >= MAX_SLICE_PAGES) {
      // Refused rather than truncated: a partial listing would be written to
      // the ledger as if it were the whole slice, and an undercounted
      // `reported` can read as fully collected. Left unwritten, the slice
      // keeps its previous row and the failure surfaces in the loop's tally.
      throw new AdapterFetchError({
        message: `Slice listing exceeded ${MAX_SLICE_PAGES} pages`,
        adapterKey,
        cursor: slice,
      });
    }
    // No clock here on purpose; see RECONCILIATION_INGEST_BUDGET_MS. A listing
    // has nowhere to resume from, so cutting one off on time would make a
    // slowly-listing slice unreconcilable rather than merely slow.
  }

  const items = [...keyed.values()];
  summary.keyable = items.length;
  const ingestEndsAtMs = now().getTime() + RECONCILIATION_INGEST_BUDGET_MS;
  const held = await selectHeldIdentityKeys(scopedDb, {
    sourceId,
    identities: items.map(({ identity }) => identity),
    requireDetail: reconciliation.heldRequiresDetail === true,
  });
  const missing = items.filter(({ identityKey }) => !held.has(identityKey));
  summary.heldBefore = items.length - missing.length;

  // A missing identity the store already tracks belongs to the due-retry path,
  // not to this walk. Re-fetching it here would serve none of its backoff —
  // a tip slice is re-walked daily, so every parked item would be asked for
  // daily whatever its schedule said — and a terminal item would be pulled
  // back into the hunt it has already left. They would also spend the unit's
  // budget ahead of misses nothing is tracking yet.
  const tracked = await selectTrackedIdentityKeys(scopedDb, {
    sourceId,
    identityKeys: missing.map(({ identityKey }) => identityKey),
  });
  const untracked = missing.filter(
    ({ identityKey }) => !tracked.has(identityKey),
  );
  summary.scheduled = missing.length - untracked.length;

  const fillable = untracked.slice(0, ingestBudget);
  summary.deferred = untracked.length - fillable.length;
  for (const [index, item] of fillable.entries()) {
    if (index > 0) {
      await sleep(fetchDelayMs);
    }
    // After the pause, not before it: the pause can itself carry the unit past
    // the budget, and what has to stay inside it is the request, not the
    // decision to wait. Out of clock rather than out of count, and owed the
    // same way: what is left stays an untracked miss, so `collected` records
    // short below and the next unit resumes the walk here.
    if (now().getTime() >= ingestEndsAtMs) {
      summary.deferred += fillable.length - index;
      break;
    }
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- paced publisher fetch per item, under a lease and a wall-clock budget
    await ingestListedItem({
      adapterKey,
      item,
      lease,
      now: now(),
      reconciliation,
      scopedDb,
      slice,
      sourceId,
      summary,
    });
  }

  // This walk saw every page, so it is authoritative about what the slice
  // lists. Retired rows naming anything else no longer describe this slice and
  // must stop vouching for its shortfall: settledness weighs the terminal count
  // against `reported`/`collected`, and those two describe the listing as it is
  // now. Only reachable on a complete walk — a listing that failed part way
  // through throws above and never gets here.
  summary.pruned = await pruneUnlistedTerminalItems(scopedDb, {
    sourceId,
    slice,
    listedIdentityKeys: items.map(({ identityKey }) => identityKey),
    limit: PRUNE_ROW_LIMIT,
  });

  await recordSliceCoverage(scopedDb, {
    sourceId,
    coverage: {
      slice,
      reported: summary.keyable,
      collected: summary.heldBefore + summary.written,
    },
  });
  return summary;
};

type RetryParkedOptions = {
  adapterKey: string;
  fetchDelayMs: number;
  lease: CaseLawSourceIngestionLease;
  now: () => Date;
  reconciliation: SourceReconciliation;
  scopedDb: ScopedDb;
  sleep: (ms: number) => Promise<void>;
  sourceId: SafeId<"caseLawSource">;
};

/**
 * Re-attempt the parked items that have come due.
 *
 * The batch is checked against what is held first: the crawl keeps running,
 * and an item it stored since parking needs no publisher fetch at all — only
 * the row forgetting. A key no current rule produces reads as
 * `unidentifiable`, which no held row can match, so such an item is
 * re-attempted rather than assumed held.
 */
const retryParkedItems = async ({
  adapterKey,
  fetchDelayMs,
  lease,
  now,
  reconciliation,
  scopedDb,
  sleep,
  sourceId,
}: RetryParkedOptions): Promise<ReconciliationUnitSummary> => {
  const summary = emptySummary("parked-retries");
  const due = await selectDueReconciliationItems(scopedDb, {
    sourceId,
    now: now(),
    limit: PARKED_RETRY_BATCH,
  });
  summary.keyable = due.length;

  const outstanding: KeyedListingItem[] = due.map(
    ({ identityKey, payload, slice }) => ({
      identity: parseListingIdentityKey(identityKey) ?? {
        type: "unidentifiable",
      },
      identityKey,
      payload,
      slice,
    }),
  );

  const held = await selectHeldIdentityKeys(scopedDb, {
    sourceId,
    identities: outstanding.map(({ identity }) => identity),
    requireDetail: reconciliation.heldRequiresDetail === true,
  });
  const settled = outstanding.filter(({ identityKey }) =>
    held.has(identityKey),
  );
  summary.heldBefore = settled.length;
  summary.resolved = settled.length;
  await resolveReconciliationItems(scopedDb, {
    sourceId,
    identityKeys: settled.map(({ identityKey }) => identityKey),
  });

  const unheld = outstanding.filter(
    ({ identityKey }) => !held.has(identityKey),
  );
  const ingestEndsAtMs = now().getTime() + RECONCILIATION_INGEST_BUDGET_MS;
  let fetched = 0;
  for (const [index, item] of unheld.entries()) {
    if (fetched > 0) {
      await sleep(fetchDelayMs);
    }
    // After the pause, for the reason given in `walkSlice`. Their backoff
    // already decides when each is asked again, so the ones this unit did not
    // reach simply stay due for the next.
    if (now().getTime() >= ingestEndsAtMs) {
      summary.deferred += unheld.length - index;
      break;
    }
    fetched += 1;
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- paced publisher fetch per due item, under a lease and a clock budget
    await ingestListedItem({
      adapterKey,
      item,
      lease,
      now: now(),
      reconciliation,
      scopedDb,
      slice: item.slice,
      sourceId,
      summary,
    });
  }
  return summary;
};

/**
 * Decide what this source owes next and do exactly that much.
 *
 * The lease is taken per unit, not per loop: a unit is bounded work, and
 * holding the source between units would block the crawl for as long as the
 * daemon lives. A source another writer holds reports `leased`, which is not
 * an error — the next iteration asks again.
 */
export const runReconciliationWorkUnit = async ({
  adapterKey,
  fetchDelayMs,
  now,
  reconciliation,
  scopedDb,
  sleep,
  sliceIngestBudget = DEFAULT_SLICE_INGEST_BUDGET,
  sliceRetries,
  sourceId,
}: ReconciliationWorkUnitOptions): Promise<ReconciliationUnitOutcome> => {
  if (
    !Number.isInteger(sliceIngestBudget) ||
    sliceIngestBudget < 1 ||
    sliceIngestBudget > MAX_SLICE_INGEST_BUDGET
  ) {
    panic(
      `reconciliation slice ingest budget must be an integer in 1..${MAX_SLICE_INGEST_BUDGET}: ${sliceIngestBudget}`,
    );
  }
  const startedAt = now();
  const tipSlices = tipWindowSlices(reconciliation, startedAt);
  const staleBefore = new Date(
    startedAt.getTime() - RECONCILIATION_SLICE_STALE_MS,
  );
  // The tip window's own start, which is also the ceiling on everything the
  // sweep and the recheck may reach for: the tip is re-walked on its own
  // cadence and needs neither.
  const tipStart = tipSlices.at(-1) ?? reconciliation.sliceOf(startedAt);

  // Dropped as they come due rather than left to accumulate: the map is the
  // process's memory of what it has just failed to walk, and an expired entry
  // is a slice the selection is free to pick again. Before the reads, because
  // the backlog query excludes the held ones and must not exclude a slice
  // whose hold ended.
  for (const [slice, retryAtMs] of sliceRetries) {
    if (retryAtMs <= startedAt.getTime()) {
      sliceRetries.delete(slice);
    }
  }
  const heldSlices = [...sliceRetries.keys()];

  const [
    tipCheckedAt,
    shortRows,
    oldestLedgerSlice,
    dueParked,
    recheckCandidate,
    failedCandidate,
  ] = await Promise.all([
    selectTipCheckedAt(scopedDb, sourceId, tipSlices),
    selectStaleShortSlices(scopedDb, { sourceId, staleBefore, heldSlices }),
    selectOldestLedgerSlice(scopedDb, sourceId),
    hasDueParkedItems(scopedDb, sourceId, startedAt),
    // Asked every turn rather than only once the higher priorities come up
    // empty: idle is the steady state of a surveyed source, so the branch
    // that skipped it would almost never be taken, and one more bounded read
    // in the batch already in flight costs no extra round trip.
    selectRecheckCandidate(scopedDb, {
      sourceId,
      belowSlice: tipStart,
      heldSlices,
    }),
    selectFailedSliceCandidate(scopedDb, { sourceId, heldSlices }),
  ]);

  const terminalBySlice = await countTerminalReconciliationItemsBySlice(
    scopedDb,
    { sourceId, slices: shortRows.map(({ slice }) => slice) },
  );
  const { settled, unsettled } = partitionShortSliceCandidates(
    shortRows.map(({ checkedAt, collected, reported, slice }) => ({
      slice,
      reported,
      collected,
      checkedAt,
      terminal: terminalBySlice.get(slice) ?? 0,
    })),
  );

  // Touch the settled rows so they leave the stale window.
  //
  // A settled slice stays short by definition, so it is never re-walked and
  // its `checkedAt` never moves on its own — which makes it the oldest-checked
  // row forever. The candidate read is a bounded oldest-first window, so
  // enough settled rows fill it completely and the unsettled slices behind
  // them are never selected again: priority 3 dies silently while the loop
  // still looks busy. Every settled row takes the same stamp, so the whole
  // window costs one update and lands back at its young end, and a settled
  // backlog is paged through a window at a time instead of blocking the queue.
  //
  // Not a work unit: touching is bookkeeping, and selection continues over
  // whatever is genuinely owed in the same iteration. Outside the lease, like
  // the crawl's own ledger writes.
  await touchSliceCoverages(scopedDb, {
    sourceId,
    slices: settled.map(({ slice }) => slice),
  });

  // The sweep frontier: the oldest slice with any row, bounded above by the
  // tip window's own start so a source with only tip rows still sweeps.
  const frontier =
    oldestLedgerSlice === null || oldestLedgerSlice > tipStart
      ? tipStart
      : oldestLedgerSlice;

  const unit = selectReconciliationWorkUnit({
    now: startedAt,
    hasDueParkedItems: dueParked,
    tipSlices,
    tipCheckedAt: new Map(
      tipCheckedAt.map(({ slice, checkedAt }) => [slice, checkedAt]),
    ),
    unsettledShortSlices: unsettled,
    failedCandidate,
    sweepSlice: reconciliation.previousSlice(frontier),
    recheckCandidate,
    slicesHeldForRetry: new Set(heldSlices),
    staleAfterMs: RECONCILIATION_SLICE_STALE_MS,
    recheckAfterMs: RECONCILIATION_SETTLED_RECHECK_MS,
    failedRetryAfterMs: RECONCILIATION_FAILED_SLICE_RETRY_MS,
  });

  if (unit.type === "idle") {
    return { type: "idle" };
  }

  const lease = await acquireCaseLawSourceIngestionLease({
    scopedDb,
    sourceId,
  });
  if (lease === null) {
    return { type: "leased" };
  }

  try {
    switch (unit.type) {
      case "parked-retries":
        return {
          type: "worked",
          summary: await retryParkedItems({
            adapterKey,
            fetchDelayMs,
            lease,
            now,
            reconciliation,
            scopedDb,
            sleep,
            sourceId,
          }),
        };
      case "slice":
        return {
          type: "worked",
          summary: await walkSlice({
            adapterKey,
            fetchDelayMs,
            ingestBudget: sliceIngestBudget,
            lease,
            now,
            reason: unit.reason,
            reconciliation,
            scopedDb,
            slice: unit.slice,
            sleep,
            sourceId,
          }).catch(async (error: unknown) => {
            // The walk is all-or-nothing by design: a listing that failed part
            // way through writes no counts, so the slice is owed exactly as
            // much as before. Recorded as failed, so the sweep's frontier and
            // the backlog move past it and the retry arm owns it; and held in
            // this process for its retry, because the tip is re-derived from
            // the clock and would otherwise be handed straight back. Named
            // here because the loop's window tally reports how many turns
            // threw without saying over what; the slice a source cannot walk
            // is the one fact that turns a standing error rate into something
            // an operator can reproduce. Measured from the failure, not from
            // the unit's start: a slice is several paginated requests and a
            // walk can spend most of the runner's deadline before it throws,
            // which would leave the hold shorter than it says or already
            // expired.
            sliceRetries.set(
              unit.slice,
              now().getTime() + RECONCILIATION_SLICE_RETRY_MS,
            );
            await recordSliceWalkFailure(scopedDb, {
              sourceId,
              slice: unit.slice,
              walkError: describeWalkError(error),
            });
            logger.warn("case_law.reconciliation.slice_failed", {
              adapterKey,
              slice: unit.slice,
              reason: unit.reason,
              ...errorSystemFields(error),
              ...pgErrorFields(error),
            });
            throw error;
          }),
        };
      default: {
        unit satisfies never;
        return panic(
          `Unhandled reconciliation work unit: ${JSON.stringify(unit)}`,
        );
      }
    }
  } finally {
    await lease.release();
  }
};
