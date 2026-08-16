/**
 * Count what the search engine actually holds against what Postgres says
 * it holds, one jurisdiction at a time.
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
 * A census is what makes it visible. It is a count on both sides, not a
 * diff: naming the missing documents would mean streaming the whole
 * jurisdiction out of the engine, while the number alone is one cheap
 * aggregate per side and is enough to decide that a jurisdiction needs
 * re-indexing. The repair is correspondingly blunt — un-mark a slice of
 * the jurisdiction and let the ordinary backfill re-project it — because
 * the projection is idempotent and re-ingesting a document the engine
 * already holds converges on the same split.
 *
 * Bounded by construction: one jurisdiction per call, one aggregate
 * query per side, and a caller that decides how often to run it.
 */

import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCorpusIndexProjections,
  caseLawDecisions,
} from "@/api/db/schema";
import { errorTag } from "@/api/lib/errors/error-tag";
import {
  caseLawCorpusProjectionJoin,
  currentCaseLawCorpusProjection,
} from "@/api/lib/legal-search/case-law-corpus-projection";
import type { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Counts documents rather than passages. A passage-granular index holds
 * one entry per chunk and exactly one of them per document carries
 * `seq:0`, so this is the document count on the engine side whichever
 * granularity the family is indexed at.
 */
const DOCUMENT_COUNT_QUERY = "seq:0";

/**
 * How far the two sides may disagree in one observation.
 *
 * Small and absolute, never proportional: a fraction of the corpus lets
 * a large jurisdiction hide more documents the larger it gets, which is
 * backwards — the whole failure this detects is a fixed-size batch going
 * missing. A tolerance at or above the ingest batch size would make the
 * smallest real loss, exactly one lost commit window, invisible.
 *
 * It is not zero either, because the bulk rebuild path marks rows before
 * the engine publishes their split, so an in-flight page reads as a
 * shortfall for as long as it takes to commit. That transient is what
 * the confirmation below is for: a shortfall has to survive into the
 * jurisdiction's next census before it is reported, and an in-flight
 * page will have published by then while a lost split never will.
 */
export const CENSUS_TOLERANCE = 5;

export type JurisdictionCensus = {
  jurisdiction: string;
  indexId: string;
  /** Documents the engine reports for this index. */
  engineDocuments: number;
  /** Rows Postgres reports as indexed into it for this generation. */
  markedIndexed: number;
  /**
   * How many rows Postgres claims the engine has and the engine does
   * not. Negative means the engine holds more, which is the harmless
   * direction: a superseded document that no row points at is
   * unreachable, not wrong.
   */
  shortfall: number;
  /** Whether this one observation is outside the tolerance. */
  short: boolean;
};

/**
 * Rows this generation has marked as indexed into this jurisdiction's
 * physical index.
 *
 * The same predicate the search path rehydrates through, so the census
 * counts exactly the rows a query would expect the engine to answer for.
 * Defining it a second time here would let the two drift, which is the
 * failure this whole module exists to catch.
 */
const countMarkedIndexed = async (
  scopedDb: ScopedDb,
  { generation, jurisdiction }: { generation: string; jurisdiction: string },
): Promise<number> => {
  const rows = await scopedDb((tx) =>
    tx
      .select({ marked: sql<number>`count(*)::int` })
      .from(caseLawDecisions)
      .leftJoin(
        caseLawCorpusIndexProjections,
        caseLawCorpusProjectionJoin(generation),
      )
      .where(
        and(
          eq(caseLawDecisions.country, jurisdiction),
          currentCaseLawCorpusProjection(generation),
        ),
      ),
  );
  return rows.at(0)?.marked ?? 0;
};

export type CensusJurisdictionOptions = {
  scopedDb: ScopedDb;
  generation: string;
  /** The `country` value, which also names the physical index. */
  jurisdiction: string;
};

/**
 * One jurisdiction's census, or the engine error that stopped it.
 *
 * A census that cannot reach the engine is not drift, so it is reported
 * as a failure rather than folded into the count: treating an
 * unreachable index as an empty one would clear every row in the
 * jurisdiction and re-ingest the whole corpus.
 */
export const censusJurisdiction = async ({
  scopedDb,
  generation,
  jurisdiction,
}: CensusJurisdictionOptions): Promise<
  Result<JurisdictionCensus, CorpusIndexError>
> => {
  const indexId = corpusIndexId(generation, jurisdiction);
  // Postgres first, deliberately. The two counts are taken at different
  // instants, and a batch landing between them shifts the difference by
  // a whole batch; taking the claim before the evidence makes that shift
  // go the harmless way, because a row marked after the Postgres count
  // is still visible to the engine count that follows. The other order
  // would need a tolerance the size of a batch, which is exactly the
  // size of the smallest loss worth finding.
  const markedIndexed = await countMarkedIndexed(scopedDb, {
    generation,
    jurisdiction,
  });
  const counted = await getCorpusIndexClient().search({
    indexId,
    query: DOCUMENT_COUNT_QUERY,
    maxHits: 0,
  });
  if (Result.isError(counted)) {
    return Result.err(counted.error);
  }

  const shortfall = markedIndexed - counted.value.numHits;

  return Result.ok({
    jurisdiction,
    indexId,
    engineDocuments: counted.value.numHits,
    markedIndexed,
    shortfall,
    short: shortfall > CENSUS_TOLERANCE,
  });
};

export type ReportJurisdictionCensusOptions = {
  generation: string;
  census: JurisdictionCensus;
  /**
   * Whether this jurisdiction was already short when it was last
   * censused. A bulk page marks its rows before the engine publishes
   * their split, so a single short observation may just be work in
   * flight; a lost split is short forever, so it survives into the next
   * observation and a publishing page does not.
   */
  confirmed: boolean;
};

/**
 * Report a census, warning only where the engine is short twice running.
 *
 * A warning rather than an error because the corpus is still serving:
 * the missing documents are unsearchable, not wrong, and the repair
 * below is an operator decision rather than something to page on.
 */
export const reportJurisdictionCensus = ({
  generation,
  census,
  confirmed,
}: ReportJurisdictionCensusOptions): void => {
  if (!(census.short && confirmed)) {
    return;
  }
  logger.warn("case_law.corpus_index.census_drift", {
    generation,
    indexId: census.indexId,
    jurisdiction: census.jurisdiction,
    engineDocuments: census.engineDocuments,
    markedIndexed: census.markedIndexed,
    shortfall: census.shortfall,
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
 * Jurisdictions the corpus holds, which is also the set of physical
 * indexes it should have. Read from the decisions themselves rather than
 * from a hand-kept list, so a new country's index cannot be uncensused
 * because nobody remembered to add it.
 */
export const listCaseLawJurisdictions = async (
  scopedDb: ScopedDb,
): Promise<string[]> => {
  const rows = await scopedDb((tx) =>
    tx
      .selectDistinct({ country: caseLawDecisions.country })
      .from(caseLawDecisions)
      .orderBy(caseLawDecisions.country)
      .limit(MAX_CENSUSED_JURISDICTIONS),
  );
  return rows.map(({ country }) => country);
};

/**
 * Backfill cycles between one census and the next.
 *
 * The census is a diagnostic, not a gate: it costs an aggregate on each
 * side and the drift it looks for accumulates over hours, so running it
 * on every batch would spend real query budget to answer the same
 * question. One jurisdiction per census means a corpus of N
 * jurisdictions is fully covered every N of these.
 */
export const CENSUS_CYCLE_INTERVAL = 20;

export type CaseLawCensusOptions = {
  scopedDb: ScopedDb;
  generation: string;
  /**
   * Where in the cycle and the jurisdiction list this process starts, in
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
 * moves on instead; the next pass round-robins to the next
 * jurisdiction either way, so one unreachable index cannot pin the
 * sweep.
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
  // tail. A random phase covers every jurisdiction in expectation
  // instead. A durable cursor would remove the "in expectation", and is
  // the next step if deployments ever outpace the sweep.
  let cyclesUntilCensus = 1 + Math.floor(startAt * CENSUS_CYCLE_INTERVAL);
  let pending: string[] = [];
  /** Jurisdictions short at their last census, awaiting confirmation. */
  const shortLastTime = new Set<string>();

  const takeNextJurisdiction = async (): Promise<string | undefined> => {
    if (pending.length > 0) {
      return pending.shift();
    }
    const jurisdictions = await listCaseLawJurisdictions(scopedDb);
    if (jurisdictions.length === 0) {
      return undefined;
    }
    const offset = Math.floor(startAt * jurisdictions.length);
    pending = [
      ...jurisdictions.slice(offset),
      ...jurisdictions.slice(0, offset),
    ];
    return pending.shift();
  };

  const censusNext = async (): Promise<void> => {
    const jurisdiction = await takeNextJurisdiction();
    if (jurisdiction === undefined) {
      return;
    }

    const census = await censusJurisdiction({
      scopedDb,
      generation,
      jurisdiction,
    });
    if (Result.isError(census)) {
      // An unreachable index is not a short one. Saying so keeps the
      // repair from being pointed at a jurisdiction whose engine simply
      // did not answer. The pending confirmation is left alone: a
      // failed observation neither confirms nor clears one.
      logger.warn("case_law.corpus_index.census_unavailable", {
        generation,
        jurisdiction,
        "error.type": census.error._tag,
      });
      return;
    }

    reportJurisdictionCensus({
      generation,
      census: census.value,
      confirmed: shortLastTime.has(jurisdiction),
    });
    if (census.value.short) {
      shortLastTime.add(jurisdiction);
    } else {
      shortLastTime.delete(jurisdiction);
    }
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

export type ClearJurisdictionIndexMarksOptions = {
  scopedDb: ScopedDb;
  generation: string;
  jurisdiction: string;
  /**
   * Most rows to un-mark in this call. The repair is a deliberately
   * bounded operator action: a whole jurisdiction can be millions of
   * rows, and un-marking them all at once would hand the backfill a
   * backlog that starves every newly ingested decision behind it. Run it
   * again to clear the next slice.
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
 * Un-mark a slice of a short jurisdiction so the backfill re-selects it.
 *
 * The slice is the census's own population — rows this generation counts
 * as indexed into this jurisdiction — rather than rows carrying the
 * legacy marker. The two are not the same set: a generation rebuild
 * records success in the projection and leaves `case_law_decisions`
 * alone, so a repair keyed off that column would be inert for exactly
 * the rows a rebuild lost. Sharing the predicate with the count also
 * means the repair cannot drift away from what was measured.
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
 * That enqueue is also what makes repeated runs walk the jurisdiction:
 * a queued row is no longer counted as current, so the next slice starts
 * past it.
 *
 * Nothing is deleted from the engine — re-ingesting a document it
 * already holds replaces it at the same id — so running this against a
 * jurisdiction that was not short costs re-indexing and nothing else.
 * `updated_at` is left alone, like every other index-mark write: an
 * index repair is not a change to the decision, and the public reads key
 * their freshness off that column.
 */
export const clearJurisdictionIndexMarks = async ({
  scopedDb,
  generation,
  jurisdiction,
  limit,
}: ClearJurisdictionIndexMarksOptions): Promise<number> =>
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
        WHERE ${caseLawDecisions.country} = ${jurisdiction}
          AND ${currentCaseLawCorpusProjection(generation)}
        ORDER BY ${caseLawDecisions.id}
        LIMIT ${Math.min(limit, MAX_REPAIR_SLICE)}
      )
      RETURNING ${caseLawDecisions.id}
    `);
    return countReturnedRows(cleared);
  });
