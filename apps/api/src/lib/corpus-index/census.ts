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
 * re-indexing. The repair is correspondingly blunt — clear `indexedHash`
 * for the jurisdiction and let the ordinary backfill re-select every row
 * — because the projection is idempotent and re-ingesting a document the
 * engine already holds converges on the same split.
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
 * How far the two sides may disagree before the jurisdiction is
 * reported.
 *
 * Never zero: a census is two counts taken at different instants, so a
 * batch committing between them reads as drift. The tolerance is
 * whichever is larger of a small absolute floor — which covers the
 * in-flight batch — and a fraction of the corpus, which keeps a large
 * jurisdiction from tripping on ordinary churn while still catching a
 * lost split. A lost commit window costs a whole batch, so the floor
 * sits below the ingest batch size on purpose.
 */
export const CENSUS_ABSOLUTE_TOLERANCE = 50;
export const CENSUS_RELATIVE_TOLERANCE = 0.001;

export const censusTolerance = (markedIndexed: number): number =>
  Math.max(
    CENSUS_ABSOLUTE_TOLERANCE,
    Math.ceil(markedIndexed * CENSUS_RELATIVE_TOLERANCE),
  );

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
  drifted: boolean;
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
  const counted = await getCorpusIndexClient().search({
    indexId,
    query: DOCUMENT_COUNT_QUERY,
    maxHits: 0,
  });
  if (Result.isError(counted)) {
    return Result.err(counted.error);
  }

  const markedIndexed = await countMarkedIndexed(scopedDb, {
    generation,
    jurisdiction,
  });
  const shortfall = markedIndexed - counted.value.numHits;

  return Result.ok({
    jurisdiction,
    indexId,
    engineDocuments: counted.value.numHits,
    markedIndexed,
    shortfall,
    drifted: shortfall > censusTolerance(markedIndexed),
  });
};

/**
 * Report a census, warning only where the engine is genuinely short.
 *
 * Emitted as a warning rather than an error because the corpus is still
 * serving: the missing documents are unsearchable, not wrong, and the
 * repair below is an operator decision rather than something to page on.
 */
export const reportJurisdictionCensus = (
  generation: string,
  census: JurisdictionCensus,
): void => {
  if (!census.drifted) {
    return;
  }
  logger.warn("case_law.corpus_index.census_drift", {
    generation,
    indexId: census.indexId,
    jurisdiction: census.jurisdiction,
    engineDocuments: census.engineDocuments,
    markedIndexed: census.markedIndexed,
    shortfall: census.shortfall,
    tolerance: censusTolerance(census.markedIndexed),
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
}: CaseLawCensusOptions): { step: () => Promise<void> } => {
  let cyclesUntilCensus = CENSUS_CYCLE_INTERVAL;
  let pending: string[] = [];

  const censusNext = async (): Promise<void> => {
    if (pending.length === 0) {
      pending = await listCaseLawJurisdictions(scopedDb);
    }
    const jurisdiction = pending.shift();
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
      // did not answer.
      logger.warn("case_law.corpus_index.census_unavailable", {
        generation,
        jurisdiction,
        "error.type": census.error._tag,
      });
      return;
    }
    reportJurisdictionCensus(generation, census.value);
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
 * Un-mark a drifted jurisdiction so the ordinary backfill re-selects it.
 *
 * Clearing `indexed_hash` is the whole repair, and deliberately the only
 * write: the projection trigger on this column enqueues the decision for
 * its generation with the right target index and content hash, so the
 * row rejoins the live pending queue and is re-projected through the
 * same path — and the same commit semantics — as a newly ingested
 * decision. Writing the projection here instead would be a second,
 * hand-maintained copy of what the trigger already states.
 *
 * Nothing is deleted from the engine: re-ingesting a document it already
 * holds replaces it at the same id, so running this against a
 * jurisdiction that was not actually short costs re-indexing and nothing
 * else.
 *
 * The slice only takes rows that still carry a mark, so repeated runs
 * walk the jurisdiction rather than clearing the same first page
 * forever. `updated_at` is left alone, like every other index-mark
 * write: an index repair is not a change to the decision, and the public
 * reads key their freshness off that column.
 */
export const clearJurisdictionIndexMarks = async ({
  scopedDb,
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
        WHERE ${caseLawDecisions.country} = ${jurisdiction}
          AND ${caseLawDecisions.indexedHash} IS NOT NULL
        ORDER BY ${caseLawDecisions.id}
        LIMIT ${limit}
      )
      RETURNING ${caseLawDecisions.id}
    `);
    return countReturnedRows(cleared);
  });
