/**
 * Citation resolution: link a citation to the decision it cites.
 *
 * Both sides carry the same canonical key (`bareCitationKey` over the
 * citation's text and over the decision's case number), so resolution is an
 * indexed equality join rather than a scan. The work happens inside one
 * statement per batch: nothing about it scales with corpus size, and a run
 * can stop and resume anywhere.
 *
 * Three rules keep a link honest, and each of them is a filter in the join
 * rather than a check afterwards:
 *
 * - **Jurisdiction.** A case number is only unique within its own court
 *   system; the same string means different cases in different countries.
 *   Which corpora a citation may reach is declared per jurisdiction in
 *   `citation-jurisdiction-policy.ts`, not decided here.
 * - **Time.** A decision cannot cite one published after it. This is the
 *   rule that catches a coincidental key collision with a later case, which
 *   is otherwise indistinguishable from a real citation.
 * - **Uniqueness.** A key matching more than one decision is ambiguous, and
 *   an ambiguous link is worse than none: it puts a wrong edge in the
 *   citation graph and thus a wrong number in the authority ranking. Those
 *   rows are recorded as `ambiguous` for the adjudication tier to pick up.
 *
 * The outcome lands in `resolution_status`, not in the nullability of
 * `cited_decision_id`. A null foreign key cannot distinguish "not examined
 * yet" from "examined, nothing honest to link to", so the scan's predicate
 * never emptied and every unresolvable row was re-examined on every pass
 * forever. With the outcome recorded, the pending set burns down.
 *
 * Two structural bounds keep one batch's cost independent of how popular a
 * key is: candidates are counted through a `LATERAL (… LIMIT 2)` (two is all
 * uniqueness needs to know), and the walk is a strict keyset over
 * `(citing_decision_id, id)`. The citing-side axis is deliberate: citation
 * ids and decision ids are both uuidv7, so walking citations in citing-
 * decision order reads the decisions table in insertion order rather than at
 * random.
 */

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawCitations, caseLawDecisions } from "@/api/db/schema";
import { citationResolutionPolicyRows } from "@/api/handlers/case-law/citation-jurisdiction-policy";
import { CITATION_RESOLUTION_STATUS } from "@/api/handlers/case-law/citation-resolution-status";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawJurisdiction } from "@/api/lib/legal-search/ingestion-constants";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Structural, not the `Transaction` type: the pipeline passes its open
 * transaction and the tests pass a pglite handle, and importing the concrete
 * type would pull the connection singleton into a module that only ever
 * executes SQL. Same shape the citation-authority recompute takes.
 */
type CitationResolutionTx = {
  execute: (query: SQL) => Promise<unknown>;
};

/** What one statement settled, in the terms the runner reports. */
export type CitationResolutionCounts = {
  /** Rows the batch examined. Zero means the scan reached the end. */
  scanned: number;
  /** Rows linked to exactly one decision. */
  resolved: number;
  /** Rows with no surviving candidate. A later decision can revive them. */
  unmatched: number;
  /** Rows with more than one surviving candidate; left unlinked on purpose. */
  ambiguous: number;
  /**
   * Unmatched rows that had a key-, time- and self-valid candidate in a
   * jurisdiction the citing jurisdiction does not declare it can reach.
   *
   * The measurement the cross-border question needs: whether Czech decisions
   * really do cite Slovak ones under the shared pre-1993 docket grammar is a
   * question about data, and this is the count that answers it without any
   * edge being written on a guess.
   */
  jurisdictionBlocked: number;
  /**
   * Rows whose citing decision belongs to a jurisdiction with no declared
   * resolution policy. They are passed over rather than resolved against a
   * default: a wrong link is unrecoverable, an unexamined row is not. Nonzero
   * here means the corpus holds a jurisdiction the registry does not, which is
   * a defect to fix in the declaration, not in the data.
   */
  undeclaredJurisdiction: number;
};

/**
 * Opaque position in the walk: the last `(citing_decision_id, id)` pair
 * examined. Keyset rather than offset because settled rows leave the
 * predicate, which would make an offset skip unexamined rows. Strict on the
 * pair rather than inclusive on the decision id alone, so a decision whose
 * citations straddle a batch boundary neither loses its tail nor re-serves the
 * rows a passed-over jurisdiction leaves behind.
 *
 * Not `SafeId`s — the pair addresses a position in a scan, never an entity.
 */
export type CitationResolutionCursor = {
  citingDecisionId: string;
  citationId: string;
};

export type CitationResolutionBatch = CitationResolutionCounts & {
  /** Where to continue; null when the batch reached the end of the walk. */
  cursor: CitationResolutionCursor | null;
};

export type ResolveCitationBatchOptions = {
  limit: number;
  /** Cursor from the previous batch; null starts at the beginning. */
  after: CitationResolutionCursor | null;
};

const toCount = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * `execute` yields the rows directly on the server driver and wraps them in
 * `{ rows }` under pglite. Reading only one shape silently returns zero
 * counts on the other — the statement still runs, so the miscount is
 * invisible until someone trusts the number.
 */
const firstRow = (result: unknown): unknown => {
  if (Array.isArray(result)) {
    return result.at(0);
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"].at(0);
  }
  return undefined;
};

const EMPTY_COUNTS: CitationResolutionCounts = {
  scanned: 0,
  resolved: 0,
  unmatched: 0,
  ambiguous: 0,
  jurisdictionBlocked: 0,
  undeclaredJurisdiction: 0,
};

const jurisdictionArray = (
  jurisdictions: readonly CaseLawJurisdiction[],
): SQL =>
  sql`ARRAY[${sql.join(
    jurisdictions.map((jurisdiction) => sql`${jurisdiction}`),
    sql`, `,
  )}]::varchar[]`;

/**
 * The declared reach of every jurisdiction as `(citing, allowed[])` rows.
 *
 * The whole map travels with the statement rather than one row's entry,
 * because a batch spans jurisdictions and each row picks up its own reach by
 * joining on its citing decision's country. Built per call: it is five rows of
 * constants, and caching it would only add a second place for the policy to be
 * stale.
 */
const policyCte = (): SQL =>
  sql`policy(citing_country, resolves_to) AS (VALUES ${sql.join(
    citationResolutionPolicyRows().map(
      ({ jurisdiction, resolvesTo }) =>
        sql`(${jurisdiction}::varchar, ${jurisdictionArray(resolvesTo)})`,
    ),
    sql`, `,
  )})`;

/**
 * The one statement. `selection` names which pending rows this call settles;
 * everything after it is the doctrine, shared so the walk and the ingest-time
 * pass cannot drift into two different definitions of an honest link.
 *
 * `cited_decision_id` is written from the same CASE that writes the status, so
 * a resolved row always carries its target and an unresolved one never carries
 * a stale target from an earlier attempt.
 */
const resolutionStatement = (selection: SQL): SQL => sql`
  WITH ${policyCte()},
  batch AS (
    SELECT c.id,
           c.citation_key,
           c.citing_decision_id,
           citing.country AS citing_country,
           citing.decision_date AS citing_date
      FROM ${caseLawCitations} c
      JOIN ${caseLawDecisions} citing ON citing.id = c.citing_decision_id
     WHERE c.resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING}
       AND c.citation_key IS NOT NULL
       ${selection}
  ),
  classified AS (
    SELECT b.id,
           b.citing_decision_id,
           pol.resolves_to,
           m.decision_id,
           m.n,
           j.blocked
      FROM batch b
      LEFT JOIN policy pol ON pol.citing_country = b.citing_country
      LEFT JOIN LATERAL (
        SELECT (array_agg(k.id))[1] AS decision_id, count(*)::int AS n
          FROM (
            SELECT cited.id
              FROM ${caseLawDecisions} cited
             WHERE cited.citation_key = b.citation_key
               AND cited.country = ANY (pol.resolves_to)
               AND cited.id <> b.citing_decision_id
               AND (
                     cited.decision_date IS NULL
                  OR b.citing_date IS NULL
                  OR b.citing_date >= cited.decision_date
                   )
             LIMIT 2
          ) k
      ) m ON true
      LEFT JOIN LATERAL (
        SELECT 1 AS blocked
          FROM ${caseLawDecisions} other
         WHERE other.citation_key = b.citation_key
           AND NOT (other.country = ANY (pol.resolves_to))
           AND other.id <> b.citing_decision_id
           AND (
                 other.decision_date IS NULL
              OR b.citing_date IS NULL
              OR b.citing_date >= other.decision_date
               )
         LIMIT 1
      ) j ON true
  ),
  updated AS (
    UPDATE ${caseLawCitations} target
       SET cited_decision_id = CASE WHEN cls.n = 1 THEN cls.decision_id END,
           resolution_status = CASE
             WHEN cls.n = 1 THEN ${CITATION_RESOLUTION_STATUS.RESOLVED}::text
             WHEN cls.n > 1 THEN ${CITATION_RESOLUTION_STATUS.AMBIGUOUS}::text
             ELSE ${CITATION_RESOLUTION_STATUS.UNMATCHED}::text
           END,
           resolution_attempted_at = now()
      FROM classified cls
     WHERE target.id = cls.id
       AND cls.resolves_to IS NOT NULL
    RETURNING target.resolution_status AS status, cls.blocked
  )
  SELECT (SELECT count(*)::int FROM batch) AS scanned,
         (SELECT count(*)::int FROM classified WHERE resolves_to IS NULL)
           AS undeclared_jurisdiction,
         (SELECT citing_decision_id::text
            FROM batch ORDER BY citing_decision_id DESC, id DESC LIMIT 1)
           AS last_citing_decision_id,
         (SELECT id::text
            FROM batch ORDER BY citing_decision_id DESC, id DESC LIMIT 1)
           AS last_citation_id,
         count(*) FILTER (
           WHERE u.status = ${CITATION_RESOLUTION_STATUS.RESOLVED}
         )::int AS resolved,
         count(*) FILTER (
           WHERE u.status = ${CITATION_RESOLUTION_STATUS.UNMATCHED}
         )::int AS unmatched,
         count(*) FILTER (
           WHERE u.status = ${CITATION_RESOLUTION_STATUS.AMBIGUOUS}
         )::int AS ambiguous,
         count(*) FILTER (
           WHERE u.status = ${CITATION_RESOLUTION_STATUS.UNMATCHED}
             AND u.blocked IS NOT NULL
         )::int AS jurisdiction_blocked
    FROM updated u
`;

const countsOf = (row: Record<string, unknown>): CitationResolutionCounts => ({
  scanned: toCount(row["scanned"]),
  resolved: toCount(row["resolved"]),
  unmatched: toCount(row["unmatched"]),
  ambiguous: toCount(row["ambiguous"]),
  jurisdictionBlocked: toCount(row["jurisdiction_blocked"]),
  undeclaredJurisdiction: toCount(row["undeclared_jurisdiction"]),
});

/**
 * Settle one bounded slice of the pending set, walking by citing decision.
 *
 * The batch is ordered and limited inside the statement, so the number of
 * candidate lookups is `limit`, whatever the corpus holds.
 */
const resolveCitationBatchIn = async (
  tx: CitationResolutionTx,
  { limit, after }: ResolveCitationBatchOptions,
): Promise<CitationResolutionBatch> => {
  // audit: skip — derived citation graph, not a user action
  const result: unknown = await tx.execute(
    resolutionStatement(sql`
      ${
        after === null
          ? sql``
          : sql`AND (c.citing_decision_id, c.id) > (${after.citingDecisionId}::uuid, ${after.citationId}::uuid)`
      }
      ORDER BY c.citing_decision_id, c.id
      LIMIT ${limit}
    `),
  );

  const row: unknown = firstRow(result);
  if (!isRecord(row)) {
    return { ...EMPTY_COUNTS, cursor: null };
  }
  const citingDecisionId = row["last_citing_decision_id"];
  const citationId = row["last_citation_id"];
  return {
    ...countsOf(row),
    cursor:
      typeof citingDecisionId === "string" && typeof citationId === "string"
        ? { citingDecisionId, citationId }
        : null,
  };
};

export const resolveCitationBatch = async (
  scopedDb: ScopedDb,
  options: ResolveCitationBatchOptions,
): Promise<CitationResolutionBatch> =>
  await scopedDb(async (tx) => await resolveCitationBatchIn(tx, options));

/**
 * Settle one batch, or report that another writer is already walking.
 *
 * The lock is transaction-scoped, so it covers exactly the batch statement and
 * releases with it. Overlapping processes are the normal case during a rolling
 * deployment: without the lock two walks would settle the same rows from the
 * same cursor and each would advance past work the other did, which is not
 * incorrect but is entirely wasted against a database that is also serving
 * readers.
 */
export const tryResolveCitationBatch = async (
  scopedDb: ScopedDb,
  { limit, after }: ResolveCitationBatchOptions,
): Promise<CitationResolutionBatch | null> =>
  await scopedDb(async (tx) => {
    const lockResult: unknown = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(hashtext('case_law'), hashtext('citation_resolution_walk')) AS locked`,
    );
    const lockRow: unknown = firstRow(lockResult);
    if (!isRecord(lockRow) || lockRow["locked"] !== true) {
      return null;
    }
    return await resolveCitationBatchIn(tx, { limit, after });
  });

/**
 * Settle the citations of one decision, in the transaction that just wrote
 * them.
 *
 * The pipeline already holds the citing decision's jurisdiction and date, and
 * the rows are in cache; resolving here costs one indexed lookup per citation
 * against the S3 fetch and parse the same page already paid for. Without it
 * every newly ingested citation waits for the standing walk to come round,
 * which on a corpus this size is the difference between a citator that is
 * current and one that trails the crawl.
 *
 * Bounded by the decision's own citation count, which the extractor caps.
 */
export const resolveCitationsForDecision = async (
  tx: CitationResolutionTx,
  decisionId: SafeId<"caseLawDecision">,
): Promise<CitationResolutionCounts> => {
  // audit: skip — derived citation graph, not a user action
  const result: unknown = await tx.execute(
    resolutionStatement(sql`AND c.citing_decision_id = ${decisionId}::uuid`),
  );
  const row: unknown = firstRow(result);
  return isRecord(row) ? countsOf(row) : EMPTY_COUNTS;
};

export type ReopenCitationsForKeyOptions = {
  /** The key the arriving decision canonicalizes to. */
  citationKey: string;
  /** The arriving decision, excluded from its own re-adjudication. */
  decisionId: SafeId<"caseLawDecision">;
  /** Its jurisdiction, which decides whose citations it can newly answer. */
  jurisdiction: CaseLawJurisdiction;
  /** Its date; a citation older than the decision was never about it. */
  decisionDate: string | null;
};

/**
 * Put back for another attempt every citation a newly stored decision changes
 * the answer for.
 *
 * Both directions matter, and only one of them is obvious. A decision arriving
 * under a key that nothing matched turns `unmatched` rows into resolvable ones
 * — that is the citator catching up with the crawl. The other direction is the
 * one that quietly rots a graph: a second decision under a key that already had
 * exactly one holder makes every edge drawn to the first one ambiguous, and an
 * edge that was honest when it was written is not honest now. Leaving it is a
 * wrong number in the authority ranking that nothing ever revisits.
 *
 * Both are bounded. The first is driven by the partial index on unmatched
 * keys; the second reaches only citations already pointing at a decision that
 * shares the arriving key, through the cited-decision index.
 *
 * Reopening rather than re-deciding on the spot is deliberate: the resolver
 * owns what an honest link is, and this only decides which rows must be asked
 * again. The ambiguity tier reopens the same way.
 */
export const reopenCitationsForDecisionKey = async (
  tx: CitationResolutionTx,
  {
    citationKey,
    decisionId,
    jurisdiction,
    decisionDate,
  }: ReopenCitationsForKeyOptions,
): Promise<number> => {
  const reachedFrom = sql`(
    SELECT pol.citing_country
      FROM (VALUES ${sql.join(
        citationResolutionPolicyRows().map(
          ({ jurisdiction: citing, resolvesTo }) =>
            sql`(${citing}::varchar, ${jurisdictionArray(resolvesTo)})`,
        ),
        sql`, `,
      )}) AS pol(citing_country, resolves_to)
     WHERE ${jurisdiction}::varchar = ANY (pol.resolves_to)
  )`;

  // A citation is only affected if its own jurisdiction declares it can reach
  // the arriving decision's, and if the decision is not newer than it.
  const affects = sql`
    citing.country IN ${reachedFrom}
    AND (
          citing.decision_date IS NULL
       OR ${decisionDate}::date IS NULL
       OR citing.decision_date >= ${decisionDate}::date
        )
  `;

  // Two data-modifying CTEs over one table are only safe while no row can
  // match both, and none can: `revived` reads `unmatched` rows and
  // `contested` reads `resolved` ones. Postgres does not define which write
  // wins when a statement updates a row twice, so the disjointness is load
  // bearing, not incidental.
  // audit: skip — derived citation graph, not a user action
  const result: unknown = await tx.execute(sql`
    WITH revived AS (
      UPDATE ${caseLawCitations} c
         SET resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING}
        FROM ${caseLawDecisions} citing
       WHERE citing.id = c.citing_decision_id
         AND c.citation_key = ${citationKey}
         AND c.resolution_status = ${CITATION_RESOLUTION_STATUS.UNMATCHED}
         AND ${affects}
      RETURNING c.id
    ),
    contested AS (
      UPDATE ${caseLawCitations} c
         SET resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING},
             cited_decision_id = NULL
        FROM ${caseLawDecisions} citing, ${caseLawDecisions} cited
       WHERE citing.id = c.citing_decision_id
         AND cited.id = c.cited_decision_id
         AND cited.id <> ${decisionId}::uuid
         AND cited.citation_key = ${citationKey}
         AND c.resolution_status = ${CITATION_RESOLUTION_STATUS.RESOLVED}
         AND ${affects}
      RETURNING c.id
    )
    SELECT (SELECT count(*)::int FROM revived)
         + (SELECT count(*)::int FROM contested) AS reopened
  `);

  const row: unknown = firstRow(result);
  return isRecord(row) ? toCount(row["reopened"]) : 0;
};

/**
 * Put a named, bounded set of citations back into the pending queue.
 *
 * The generic re-entry path: `reopenCitationsForDecisionKey` is what the
 * ingestion pipeline uses because it knows a key rather than a set of rows,
 * and an adjudication pass over `ambiguous` rows knows the opposite. Both end
 * in the same place, so the queue has one door.
 *
 * Bounded by the caller's list, and the list is the caller's bound to keep;
 * this refuses an unbounded one by construction because it takes ids.
 */
export const reopenCitations = async (
  tx: CitationResolutionTx,
  citationIds: readonly SafeId<"caseLawCitation">[],
): Promise<number> => {
  if (citationIds.length === 0) {
    return 0;
  }
  // audit: skip — derived citation graph, not a user action
  const result: unknown = await tx.execute(sql`
    WITH reopened AS (
      UPDATE ${caseLawCitations}
         SET resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING}::text,
             cited_decision_id = NULL
       WHERE id = ANY (ARRAY[${sql.join(
         citationIds.map((id) => sql`${id}`),
         sql`, `,
       )}]::uuid[])
         AND resolution_status <> ${CITATION_RESOLUTION_STATUS.PENDING}
      RETURNING id
    )
    SELECT count(*)::int AS reopened FROM reopened
  `);
  const row: unknown = firstRow(result);
  return isRecord(row) ? toCount(row["reopened"]) : 0;
};

/**
 * How much work the walk has left. Read on the summary interval rather than
 * per batch: it is an index-only count over the pending partial index, which
 * shrinks as the burn-down proceeds but is a full traversal of what remains.
 */
export const countPendingCitations = async (
  scopedDb: ScopedDb,
): Promise<number> =>
  await scopedDb(async (tx) => {
    const result: unknown = await tx.execute(sql`
      SELECT count(*)::int AS pending
        FROM ${caseLawCitations}
       WHERE resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING}
         AND citation_key IS NOT NULL
    `);
    const row: unknown = firstRow(result);
    return isRecord(row) ? toCount(row["pending"]) : 0;
  });
