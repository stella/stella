/**
 * Count what the search engine actually holds against what Postgres says
 * it holds, one physical index at a time.
 *
 * The ingest path marks a row indexed on the strength of the engine
 * accepting its batch. `commit=wait_for` makes that acceptance mean the
 * split is published, which closes the window where an indexer death
 * loses documents Postgres has already recorded — but only for the
 * requests that use it. Bulk rebuild pages deliberately keep `auto` for
 * throughput, and no request-level signal can prove a whole generation
 * landed anyway: a lost split leaves a row that is neither missing (it
 * has an `indexedHash`) nor stale (the hash matches), so nothing selects
 * it again and the gap is permanent and invisible.
 *
 * A census is what makes it visible. It compares counts rather than
 * identities: naming the missing documents would mean streaming the whole
 * index out of the engine, while the number alone needs one engine aggregate
 * and one exact PostgreSQL counter lookup. That is enough to decide that an
 * index needs re-indexing. The repair is correspondingly blunt — un-mark a slice of
 * the index's rows and let the ordinary backfill re-project it — because
 * the projection is idempotent and re-ingesting a document the engine
 * already holds converges on the same split.
 *
 * The unit is the physical index, not the country: from generation 3 on
 * several countries share one index (`corpusIndexId`), and the engine
 * count is per index either way. The rows an index answers for are the
 * ones whose country the index holds (`corpusIndexJurisdictions`, the
 * inverse of that derivation), in the state the search path accepts.
 *
 * Bounded by construction: one index per call, one engine aggregate, one
 * constant-time PostgreSQL lookup, and a caller that decides how often to run
 * it.
 */

import { Result, TaggedError, panic } from "better-result";
import {
  and,
  asc,
  count,
  eq,
  exists,
  gt,
  inArray,
  lte,
  min,
  type SQL,
  sql,
} from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS,
  CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUS,
  type CaseLawCorpusIndexCountBackfillStatus,
  caseLawCorpusIndexBackfills,
  caseLawCorpusIndexCountBackfills,
  caseLawCorpusIndexCounts,
  caseLawCorpusIndexDeleteWatermarks,
  caseLawCorpusIndexPendingDeletes,
  caseLawCorpusIndexProjections,
  caseLawCorpusJurisdictions,
  caseLawDecisions,
} from "@/api/db/schema";
import { errorTag } from "@/api/lib/errors/error-tag";
import {
  caseLawCorpusProjectionJoin,
  currentCaseLawCorpusProjection,
} from "@/api/lib/legal-search/case-law-corpus-projection";
import type { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  corpusIndexIdsFor,
  corpusIndexJurisdictions,
} from "@/api/lib/legal-search/index-naming";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Counts documents rather than passages. A passage-granular index holds
 * one entry per chunk and exactly one of them per document carries
 * `seq:0`, so this is the document count on the engine side whichever
 * granularity the family is indexed at.
 */
const DOCUMENT_COUNT_QUERY = "seq:0";

/** One short transaction's maximum accounting seed work. */
export const CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_BATCH_SIZE = 1000;

export class CaseLawCorpusIndexCountNotReadyError extends TaggedError(
  "CaseLawCorpusIndexCountNotReadyError",
)<{
  message: string;
  generation: string;
}> {}

export type CaseLawCorpusIndexCountBackfillStep = {
  generation: string;
  processed: number;
  status: CaseLawCorpusIndexCountBackfillStatus;
};

type AdvanceCaseLawCorpusIndexCountBackfill = (
  scopedDb: ScopedDb,
  generation: string,
) => Promise<CaseLawCorpusIndexCountBackfillStep>;

/**
 * Account one keyset page of projections that predate the aggregate.
 *
 * The row trigger derives `accountedIndexId` under the same row lock, and the
 * statement trigger applies the net per-index delta once. Inserts and updates
 * racing behind the cursor are already accounted by that trigger, so replay,
 * overlap, and a process restart all converge without a snapshot transaction.
 */
export const advanceCaseLawCorpusIndexCountBackfill = async (
  scopedDb: ScopedDb,
  generation: string,
): Promise<CaseLawCorpusIndexCountBackfillStep> =>
  await scopedDb(async (tx) => {
    const checkpoint = (
      await tx
        .select({
          cursorDecisionId: caseLawCorpusIndexCountBackfills.cursorDecisionId,
          generationStatus: caseLawCorpusIndexBackfills.status,
          status: caseLawCorpusIndexCountBackfills.status,
        })
        .from(caseLawCorpusIndexCountBackfills)
        .innerJoin(
          caseLawCorpusIndexBackfills,
          eq(
            caseLawCorpusIndexBackfills.generation,
            caseLawCorpusIndexCountBackfills.generation,
          ),
        )
        .where(eq(caseLawCorpusIndexCountBackfills.generation, generation))
        .for("update")
    ).at(0);

    if (checkpoint === undefined) {
      throw new CaseLawCorpusIndexCountNotReadyError({
        generation,
        message: `No corpus-index count checkpoint exists for ${generation}`,
      });
    }
    if (
      checkpoint.status === CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUS.COMPLETE
    ) {
      return {
        generation,
        processed: 0,
        status: CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUS.COMPLETE,
      };
    }

    const page = await tx
      .select({ decisionId: caseLawCorpusIndexProjections.decisionId })
      .from(caseLawCorpusIndexProjections)
      .where(
        and(
          eq(caseLawCorpusIndexProjections.generation, generation),
          checkpoint.cursorDecisionId === null
            ? undefined
            : gt(
                caseLawCorpusIndexProjections.decisionId,
                checkpoint.cursorDecisionId,
              ),
        ),
      )
      .orderBy(asc(caseLawCorpusIndexProjections.decisionId))
      .limit(CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_BATCH_SIZE)
      .for("update");

    if (page.length === 0) {
      // A running generation can still be served through the legacy decision
      // marker before its projection walk reaches every row. Keep the count
      // unavailable until that walk removes the fallback population; newly
      // written projections are already exact through the accounting trigger.
      if (
        checkpoint.generationStatus ===
        CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.RUNNING
      ) {
        return {
          generation,
          processed: 0,
          status: CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUS.RUNNING,
        };
      }
      await tx
        .update(caseLawCorpusIndexCountBackfills)
        .set({
          status: CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUS.COMPLETE,
          updatedAt: new Date(),
        })
        .where(eq(caseLawCorpusIndexCountBackfills.generation, generation));
      return {
        generation,
        processed: 0,
        status: CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUS.COMPLETE,
      };
    }

    const decisionIds = sql.join(
      page.map(({ decisionId }) => sql`${decisionId}::uuid`),
      sql`, `,
    );
    // Deliberately assign the accounting marker to itself. The database's
    // BEFORE trigger derives the current bucket; raw SQL avoids changing the
    // projection's application-level updated_at CAS token.
    await tx.execute(sql`
      UPDATE ${caseLawCorpusIndexProjections}
      SET accounted_index_id = accounted_index_id
      WHERE generation = ${generation}
        AND decision_id IN (${decisionIds})
    `);

    const cursorDecisionId = page.at(-1)?.decisionId;
    if (cursorDecisionId === undefined) {
      throw new CaseLawCorpusIndexCountNotReadyError({
        generation,
        message: `Corpus-index count page for ${generation} lost its cursor`,
      });
    }
    await tx
      .update(caseLawCorpusIndexCountBackfills)
      .set({ cursorDecisionId, updatedAt: new Date() })
      .where(eq(caseLawCorpusIndexCountBackfills.generation, generation));

    return {
      generation,
      processed: page.length,
      status: CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUS.RUNNING,
    };
  });

type CaseLawCorpusIndexCountSeedOptions = {
  scopedDb: ScopedDb;
  generation: string;
  advance?: AdvanceCaseLawCorpusIndexCountBackfill;
};

/**
 * Drive the rollout-only count seed one bounded page per corpus-worker cycle.
 *
 * Completion is remembered in-process, so the steady-state worker pays no
 * database round-trip. A failure is reported and retried on the next cycle;
 * it never stops the corpus projection loop that owns this maintenance work.
 */
export const createCaseLawCorpusIndexCountSeed = ({
  scopedDb,
  generation,
  advance = advanceCaseLawCorpusIndexCountBackfill,
}: CaseLawCorpusIndexCountSeedOptions): { step: () => Promise<void> } => {
  let complete = false;

  return {
    step: async (): Promise<void> => {
      if (complete) {
        return;
      }
      const outcome = await Result.tryPromise(
        async () => await advance(scopedDb, generation),
      );
      if (Result.isError(outcome)) {
        logger.warn("case_law.corpus_index.count_seed_failed", {
          generation,
          "error.type": errorTag(outcome.error),
        });
        return;
      }
      complete =
        outcome.value.status ===
        CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUS.COMPLETE;
    },
  };
};

/**
 * How far the two sides may disagree in one observation.
 *
 * Small and absolute, never proportional: a fraction of the corpus lets
 * a large index hide more documents the larger it gets, which is
 * backwards — the whole failure this detects is a fixed-size batch going
 * missing. A tolerance at or above the ingest batch size would make the
 * smallest real loss, exactly one lost commit window, invisible.
 *
 * It is not zero either, because the bulk rebuild path marks rows before
 * the engine publishes their split, so an in-flight page reads as a
 * shortfall for as long as it takes to commit. That transient is what
 * the confirmation below is for: a shortfall has to survive into the
 * index's next census before it is reported, and an in-flight page will
 * have published by then while a lost split never will.
 */
export const CENSUS_TOLERANCE = 5;

/** Pending engine deletion old enough to require operator attention. */
export const DELETE_SETTLEMENT_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * What one observation says about an index.
 *
 * Two counts can only report their difference, and the difference nets
 * two independent defects: documents the engine never received, and
 * entries it holds that no row points at. An orphan cancels a missing
 * document, so a census that only looked for a shortfall would go quiet
 * on the pair. Reporting the surplus direction too is what keeps that
 * from being silent — an index holding more than the corpus claims is
 * itself worth acting on, and it says the shortfall number cannot be
 * trusted until it is cleared. Exact cancellation to inside the
 * tolerance remains this mechanism's blind spot; closing it needs an
 * identity comparison, which means streaming the index rather than
 * counting it.
 */
export const CENSUS_DISPOSITION = {
  /** Both sides agree inside the tolerance. */
  aligned: "aligned",
  /** The engine holds fewer documents than the corpus claims. */
  short: "short",
  /** Surplus is explained by a recorded delete not yet applied to every split. */
  pendingDelete: "surplus_pending_delete",
  /** The engine holds documents the corpus does not account for. */
  surplus: "surplus",
} as const;

export type CensusDisposition =
  (typeof CENSUS_DISPOSITION)[keyof typeof CENSUS_DISPOSITION];

export type IndexCensus = {
  indexId: string;
  /** Documents the engine reports for this index. */
  engineDocuments: number;
  /** Rows Postgres reports as indexed into it for this generation. */
  markedIndexed: number;
  /** Positive where the corpus claims more than the engine holds. */
  shortfall: number;
  disposition: CensusDisposition;
  deleteSettlement: {
    requiredOpstamp: number;
    publishedSplits: number;
    laggingSplits: number;
    minAppliedOpstamp: number | null;
    pendingDocuments: number;
    oldestPendingAt: Date | null;
    stale: boolean;
    settled: boolean;
  } | null;
};

const dispositionOf = (
  shortfall: number,
  deleteSettlement: IndexCensus["deleteSettlement"],
): CensusDisposition => {
  if (shortfall > CENSUS_TOLERANCE) {
    return CENSUS_DISPOSITION.short;
  }
  if (shortfall >= -CENSUS_TOLERANCE) {
    return CENSUS_DISPOSITION.aligned;
  }
  const surplus = -shortfall;
  return deleteSettlement !== null &&
    deleteSettlement.pendingDocuments > 0 &&
    surplus <= deleteSettlement.pendingDocuments + CENSUS_TOLERANCE
    ? CENSUS_DISPOSITION.pendingDelete
    : CENSUS_DISPOSITION.surplus;
};

const readDeleteSettlement = async (
  scopedDb: ScopedDb,
  indexId: string,
): Promise<Result<IndexCensus["deleteSettlement"], CorpusIndexError>> => {
  const watermark = (
    await scopedDb((tx) =>
      tx
        .select({ opstamp: caseLawCorpusIndexDeleteWatermarks.opstamp })
        .from(caseLawCorpusIndexDeleteWatermarks)
        .where(eq(caseLawCorpusIndexDeleteWatermarks.indexId, indexId)),
    )
  ).at(0);
  if (watermark === undefined) {
    return Result.ok(null);
  }
  const settlement = await getCorpusIndexClient().readDeleteSettlement(
    indexId,
    watermark.opstamp,
  );
  if (Result.isError(settlement)) {
    return Result.err(settlement.error);
  }
  const appliedOpstamp =
    settlement.value.publishedSplits === 0
      ? watermark.opstamp
      : settlement.value.minAppliedOpstamp;
  const pending = await scopedDb(async (tx) => {
    if (appliedOpstamp !== null) {
      // audit: skip — bounded derived settlement state; append-only index-job
      // rows retain the deletion audit trail
      await tx
        .delete(caseLawCorpusIndexPendingDeletes)
        .where(
          and(
            eq(caseLawCorpusIndexPendingDeletes.indexId, indexId),
            lte(caseLawCorpusIndexPendingDeletes.opstamp, appliedOpstamp),
          ),
        );
    }
    return await tx
      .select({
        oldestPendingAt: min(caseLawCorpusIndexPendingDeletes.createdAt),
        pendingDocuments: count(),
      })
      .from(caseLawCorpusIndexPendingDeletes)
      .where(eq(caseLawCorpusIndexPendingDeletes.indexId, indexId));
  });
  const state = pending.at(0);
  const pendingDocuments = state?.pendingDocuments ?? 0;
  const oldestPendingAt = state?.oldestPendingAt ?? null;
  return Result.ok({
    ...settlement.value,
    pendingDocuments,
    oldestPendingAt,
    stale:
      oldestPendingAt !== null &&
      Date.now() - oldestPendingAt.getTime() >= DELETE_SETTLEMENT_STALE_MS,
    settled: pendingDocuments === 0,
  });
};

/**
 * Rows this generation has marked as indexed into this physical index:
 * every row whose country the index holds, in the state the search path
 * accepts.
 *
 * The country list is the inverse of the id derivation, so the census
 * counts exactly the rows a query would expect the engine to answer for,
 * and `country` is a plain column predicate the country index serves. The
 * projection state is the same predicate the search path rehydrates
 * through; defining it a second time here would let the two drift, which
 * is the failure this whole module exists to catch.
 */
const censusPopulation = (generation: string, indexId: string): SQL =>
  sql`${inArray(caseLawDecisions.country, [
    ...corpusIndexJurisdictions(generation, indexId),
  ])} AND ${currentCaseLawCorpusProjection(generation)}`;

const countMarkedIndexed = async (
  scopedDb: ScopedDb,
  { generation, indexId }: { generation: string; indexId: string },
): Promise<{ markedIndexed: number; hasPendingDelete: boolean }> => {
  const rows = await scopedDb((tx) =>
    tx
      .select({
        marked: caseLawCorpusIndexCounts.markedIndexed,
        status: caseLawCorpusIndexCountBackfills.status,
        hasPendingDelete: exists(
          tx
            .select({ indexId: caseLawCorpusIndexPendingDeletes.indexId })
            .from(caseLawCorpusIndexPendingDeletes)
            .where(eq(caseLawCorpusIndexPendingDeletes.indexId, indexId)),
        ),
      })
      .from(caseLawCorpusIndexCountBackfills)
      .leftJoin(
        caseLawCorpusIndexCounts,
        and(
          eq(
            caseLawCorpusIndexCounts.generation,
            caseLawCorpusIndexCountBackfills.generation,
          ),
          eq(caseLawCorpusIndexCounts.indexId, indexId),
        ),
      )
      .where(eq(caseLawCorpusIndexCountBackfills.generation, generation)),
  );
  const row = rows.at(0);
  if (row?.status !== CASE_LAW_CORPUS_INDEX_COUNT_BACKFILL_STATUS.COMPLETE) {
    throw new CaseLawCorpusIndexCountNotReadyError({
      generation,
      message: `Corpus-index count for ${generation} is not ready`,
    });
  }
  return {
    markedIndexed: row.marked ?? 0,
    hasPendingDelete: row.hasPendingDelete === true,
  };
};

export type CensusIndexOptions = {
  scopedDb: ScopedDb;
  generation: string;
  /** The physical index id, as `corpusIndexId` derives it. */
  indexId: string;
};

/**
 * One index's census, or the engine error that stopped it.
 *
 * A census that cannot reach the engine is not drift, so it is reported
 * as a failure rather than folded into the count: treating an
 * unreachable index as an empty one would clear every row in the index
 * and re-ingest the whole corpus.
 */
export const censusIndex = async ({
  scopedDb,
  generation,
  indexId,
}: CensusIndexOptions): Promise<Result<IndexCensus, CorpusIndexError>> => {
  // Postgres first, deliberately. The two counts are taken at different
  // instants, and a batch landing between them shifts the difference by
  // a whole batch; taking the claim before the evidence makes that shift
  // go the harmless way, because a row marked after the Postgres count
  // is still visible to the engine count that follows. The other order
  // would need a tolerance the size of a batch, which is exactly the
  // size of the smallest loss worth finding.
  const marked = await countMarkedIndexed(scopedDb, {
    generation,
    indexId,
  });
  const counted = await getCorpusIndexClient().search({
    indexId,
    query: DOCUMENT_COUNT_QUERY,
    maxHits: 1,
  });
  if (Result.isError(counted)) {
    return Result.err(counted.error);
  }

  const shortfall = marked.markedIndexed - counted.value.numHits;
  const deleteSettlementResult = marked.hasPendingDelete
    ? await readDeleteSettlement(scopedDb, indexId)
    : Result.ok(null);
  if (Result.isError(deleteSettlementResult)) {
    return Result.err(deleteSettlementResult.error);
  }
  const deleteSettlement = deleteSettlementResult.value;

  return Result.ok({
    indexId,
    engineDocuments: counted.value.numHits,
    markedIndexed: marked.markedIndexed,
    shortfall,
    disposition: dispositionOf(shortfall, deleteSettlement),
    deleteSettlement,
  });
};

export type ReportIndexCensusOptions = {
  generation: string;
  census: IndexCensus;
  /**
   * The disposition this index had when it was last censused. A bulk
   * page marks its rows before the engine publishes their split, so a
   * single disagreeing observation may just be work in flight; a lost
   * split or an orphaned entry is there forever, so it survives into the
   * next observation and a publishing page does not.
   */
  previous: CensusDisposition | undefined;
};

/**
 * Report a census, warning where the two sides disagree twice running.
 *
 * Both directions are reported. A surplus is a defect in its own right —
 * entries no row points at are unreachable weight in the index — and,
 * more to the point here, an unaccounted-for surplus is what could be
 * cancelling a shortfall in the same count.
 *
 * A warning rather than an error because the corpus is still serving:
 * the missing documents are unsearchable, not wrong, and the repair
 * below is an operator decision rather than something to page on.
 */
export const reportIndexCensus = ({
  generation,
  census,
  previous,
}: ReportIndexCensusOptions): void => {
  if (census.deleteSettlement?.stale === true) {
    logger.warn("case_law.corpus_index.delete_settlement_stalled", {
      generation,
      indexId: census.indexId,
      deleteLaggingSplits: census.deleteSettlement.laggingSplits,
      deleteOldestPendingAt:
        census.deleteSettlement.oldestPendingAt?.toISOString() ?? "unknown",
      deletePendingDocuments: census.deleteSettlement.pendingDocuments,
      deleteRequiredOpstamp: census.deleteSettlement.requiredOpstamp,
    });
  }
  if (
    census.disposition === CENSUS_DISPOSITION.aligned ||
    census.disposition === CENSUS_DISPOSITION.pendingDelete ||
    census.disposition !== previous
  ) {
    return;
  }
  const deleteSettlementAttributes =
    census.deleteSettlement === null
      ? {}
      : {
          deleteLaggingSplits: census.deleteSettlement.laggingSplits,
          deleteRequiredOpstamp: census.deleteSettlement.requiredOpstamp,
        };
  logger.warn("case_law.corpus_index.census_drift", {
    generation,
    disposition: census.disposition,
    indexId: census.indexId,
    engineDocuments: census.engineDocuments,
    markedIndexed: census.markedIndexed,
    shortfall: census.shortfall,
    ...deleteSettlementAttributes,
    tolerance: CENSUS_TOLERANCE,
  });
};

/**
 * Ceiling on the jurisdictions one sweep covers. The corpus is
 * partitioned by ISO country code, so this is far above the real
 * cardinality; it exists so the census cannot become an unbounded read
 * if the column ever holds something it should not.
 */
const MAX_CENSUSED_JURISDICTIONS = 256;

/**
 * Jurisdictions the corpus holds. Read from the decisions themselves
 * rather than from a hand-kept list, so a new country's index cannot be
 * uncensused because nobody remembered to add it.
 */
export const listCaseLawJurisdictions = async (
  scopedDb: ScopedDb,
): Promise<string[]> => {
  const rows = await scopedDb((tx) =>
    tx
      .select({ country: caseLawCorpusJurisdictions.country })
      .from(caseLawCorpusJurisdictions)
      .orderBy(caseLawCorpusJurisdictions.country)
      .limit(MAX_CENSUSED_JURISDICTIONS + 1),
  );
  if (rows.length > MAX_CENSUSED_JURISDICTIONS) {
    return panic(
      `Case-law corpus exceeds the ${MAX_CENSUSED_JURISDICTIONS} jurisdiction census ceiling`,
    );
  }
  return rows.map(({ country }) => country);
};

/**
 * Physical indexes the corpus should have for this generation: the
 * distinct ids its jurisdictions derive to, one per country up to
 * generation 2 and one per index group from generation 3 on.
 */
export const listCaseLawIndexIds = async (
  scopedDb: ScopedDb,
  generation: string,
): Promise<string[]> =>
  corpusIndexIdsFor(generation, await listCaseLawJurisdictions(scopedDb));

/**
 * Backfill cycles between one census and the next.
 *
 * The census is a diagnostic, not a gate: the engine aggregate still costs
 * query budget and the drift it looks for accumulates over hours, so running
 * it on every batch would answer the same question repeatedly. One index per
 * census means a corpus of N indexes is fully covered every N of these.
 */
export const CENSUS_CYCLE_INTERVAL = 20;

export type CaseLawCensusOptions = {
  scopedDb: ScopedDb;
  generation: string;
  /**
   * Where in the cycle and the index list this process starts, in
   * `[0, 1)`. Random per process so restarts spread their coverage;
   * tests pin it.
   */
  startAt?: number;
};

/**
 * The census as the backfill loop consumes it: called every cycle,
 * doing work on a few of them, and never able to fail its caller.
 *
 * A census that throws would take the backfill down with it, which
 * would trade a silent index gap for a stopped index. It reports and
 * moves on instead; the next pass round-robins to the next index either
 * way, so one unreachable index cannot pin the sweep.
 */
export const createCaseLawCensus = ({
  scopedDb,
  generation,
  startAt = Math.random(),
}: CaseLawCensusOptions): { step: () => Promise<void> } => {
  // Both the countdown and the sweep position start somewhere random.
  // They live in this process, so a runner replaced mid-sweep loses them;
  // starting every replacement at the same place would mean frequent
  // deployments always censusing the head of the alphabet and never the
  // tail. A random phase covers every index in expectation instead. A
  // durable cursor would remove the "in expectation", and is the next
  // step if deployments ever outpace the sweep.
  let cyclesUntilCensus = 1 + Math.floor(startAt * CENSUS_CYCLE_INTERVAL);
  let pending: string[] = [];
  /** Each index's last disposition, awaiting confirmation. */
  const lastDisposition = new Map<string, CensusDisposition>();

  const takeNextIndexId = async (): Promise<string | undefined> => {
    if (pending.length > 0) {
      return pending.shift();
    }
    const indexIds = await listCaseLawIndexIds(scopedDb, generation);
    if (indexIds.length === 0) {
      return undefined;
    }
    const offset = Math.floor(startAt * indexIds.length);
    pending = [...indexIds.slice(offset), ...indexIds.slice(0, offset)];
    return pending.shift();
  };

  const censusNext = async (): Promise<void> => {
    const indexId = await takeNextIndexId();
    if (indexId === undefined) {
      return;
    }

    const census = await censusIndex({ scopedDb, generation, indexId });
    if (Result.isError(census)) {
      // An unreachable index is not a short one. Saying so keeps the
      // repair from being pointed at an index whose engine simply did
      // not answer. The pending confirmation is left alone: a failed
      // observation neither confirms nor clears one.
      logger.warn("case_law.corpus_index.census_unavailable", {
        generation,
        indexId,
        "error.type": census.error._tag,
      });
      return;
    }

    reportIndexCensus({
      generation,
      census: census.value,
      previous: lastDisposition.get(indexId),
    });
    lastDisposition.set(indexId, census.value.disposition);
  };

  return {
    step: async (): Promise<void> => {
      cyclesUntilCensus -= 1;
      if (cyclesUntilCensus > 0) {
        return;
      }
      cyclesUntilCensus = CENSUS_CYCLE_INTERVAL;

      const outcome = await Result.tryPromise(censusNext);
      if (Result.isError(outcome)) {
        logger.warn("case_law.corpus_index.census_failed", {
          generation,
          "error.type": errorTag(outcome.error),
        });
      }
    },
  };
};

export type ClearIndexMarksOptions = {
  scopedDb: ScopedDb;
  generation: string;
  /** The physical index id, as `corpusIndexId` derives it. */
  indexId: string;
  /**
   * Most rows to un-mark in this call. The repair is a deliberately
   * bounded operator action: a whole index can be millions of rows, and
   * un-marking them all at once would hand the backfill a backlog that
   * starves every newly ingested decision behind it. Run it again to
   * clear the next slice.
   */
  limit: number;
};

/** Hard ceiling on one repair slice, whatever the operator asks for. */
export const MAX_REPAIR_SLICE = 50_000;

/**
 * `execute` returns the driver's own row container: the server client
 * gives an array, the embedded one used by the database tests wraps it.
 * Reading the count through both keeps the repair's report honest under
 * either.
 */
const countReturnedRows = (result: unknown): number => {
  if (Array.isArray(result)) {
    return result.length;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"].length;
  }
  return 0;
};

/**
 * Un-mark a slice of a short index so the backfill re-selects it.
 *
 * The slice is the census's own population — rows this generation counts
 * as indexed into this index — rather than rows carrying the legacy
 * marker. The two are not the same set: a generation rebuild records
 * success in the projection and leaves `case_law_decisions` alone, so a
 * repair keyed off that column would be inert for exactly the rows a
 * rebuild lost. Sharing the predicate with the count also means the
 * repair cannot drift away from what was measured.
 *
 * The write is still only `indexed_hash`, and deliberately so: the
 * projection trigger on that column enqueues the decision for every
 * live generation with the right target index and content hash, so the
 * row rejoins the pending queue and is re-projected through the same
 * path — and the same commit semantics — as a newly ingested decision.
 * Writing the projection here as well would be a second, hand-maintained
 * copy of what the trigger already states. The trigger fires on the
 * column being assigned, not on its value changing, so a row whose
 * legacy marker is already null is enqueued just the same.
 *
 * That enqueue is also what makes repeated runs walk the index: a queued
 * row is no longer counted as current, so the next slice starts past it.
 *
 * Nothing is deleted from the engine — re-ingesting a document it
 * already holds replaces it at the same id — so running this against an
 * index that was not short costs re-indexing and nothing else.
 * `updated_at` is left alone, like every other index-mark write: an
 * index repair is not a change to the decision, and the public reads key
 * their freshness off that column.
 */
export const clearIndexMarks = async ({
  scopedDb,
  generation,
  indexId,
  limit,
}: ClearIndexMarksOptions): Promise<number> =>
  await scopedDb(async (tx) => {
    // audit: skip — search index maintenance; rebuilds derived state
    const cleared = await tx.execute(sql`
      UPDATE ${caseLawDecisions}
      SET indexed_hash = NULL
      WHERE ${caseLawDecisions.id} IN (
        SELECT ${caseLawDecisions.id}
        FROM ${caseLawDecisions}
        LEFT JOIN ${caseLawCorpusIndexProjections}
          ON ${caseLawCorpusProjectionJoin(generation)}
        WHERE ${censusPopulation(generation, indexId)}
        ORDER BY ${caseLawDecisions.id}
        LIMIT ${Math.min(limit, MAX_REPAIR_SLICE)}
      )
      RETURNING ${caseLawDecisions.id}
    `);
    return countReturnedRows(cleared);
  });
