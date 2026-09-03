/**
 * What `repair-decision-dates.ts` selects and how it decides each row,
 * separated from the script that runs it.
 *
 * An operator script is a module with a side effect at the top level, so
 * nothing can import it and nothing in CI ever executes its SQL. Keeping the
 * statements and the per-row decision here, where a database test can run them
 * against a real PostgreSQL, is what makes them reviewable: a predicate that
 * selects the wrong rows is a data loss the first invocation commits, and a
 * syntax error is one no test would otherwise see.
 */

import { panic } from "better-result";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import {
  lockCitationGraph,
  reopenCitationsForDecisionKey,
  reopenCitationsForKeys,
  reopenCitationsFrom,
  reopenCitationsResolvedTo,
} from "@/api/handlers/case-law/citation-resolution";
import type { SafeId } from "@/api/lib/branded-types";
import { canonicalDecisionDate } from "@/api/lib/dates";
import { decisionDateOutOfBoundsSql } from "@/api/lib/decision-date-bounds-sql";
import { isCaseLawJurisdiction } from "@/api/lib/legal-search/ingestion-constants";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

const OUT_OF_BOUNDS = decisionDateOutOfBoundsSql(sql.raw("d.decision_date"));

/**
 * How many out-of-bounds dates each source holds, and the range they span.
 *
 * Bounded by `limit` like any other read: the source registry is small, but a
 * survey that silently truncates is worse than one that says it did, and the
 * script reports a full result set as suspect.
 */
export const decisionDateSourceSurveyStatement = (limit: number): SQL => sql`
  SELECT s.adapter_key AS "adapterKey",
         count(*)::int AS "rows",
         min(d.decision_date)::text AS "minDate",
         max(d.decision_date)::text AS "maxDate"
    FROM case_law_decisions d
    JOIN case_law_sources s ON s.id = d.source_id
   WHERE ${OUT_OF_BOUNDS}
   GROUP BY 1
   ORDER BY 2 DESC, 1
   LIMIT ${limit}
`;

/**
 * The same population by source and year. The year is what identifies the
 * fault: a run of rows sharing one impossible year is a publisher's repeated
 * data-entry error, while a scatter of unrelated years is a parse fallback.
 */
export const decisionDateYearSurveyStatement = (limit: number): SQL => sql`
  SELECT s.adapter_key AS "adapterKey",
         extract(year from d.decision_date)::int AS "year",
         count(*)::int AS "rows"
    FROM case_law_decisions d
    JOIN case_law_sources s ON s.id = d.source_id
   WHERE ${OUT_OF_BOUNDS}
   GROUP BY 1, 2
   ORDER BY 3 DESC, 1, 2
   LIMIT ${limit}
`;

/**
 * One bounded batch of corrupt rows, with the only cheap re-derivation source
 * the row itself carries.
 *
 * `metadata->>'decisionDate'` is the key every adapter that stores a date in
 * metadata uses (`at-courts` stores none). It is read so the run can *prove*
 * per row whether a better value survives rather than assume it does not: the
 * adapters that normalize the date write the normalized value into metadata,
 * and `cz-regional`, whose rows dominate this population, copies the
 * publisher's string into both places unchanged. The dry-run report prints the
 * re-derived count, so a source that does keep a usable raw value shows up as a
 * number instead of being silently nulled.
 *
 * `sourceRaw` is deliberately not consulted. It lives in object storage
 * (`source_raw_s3_key`), so reading it is a network round-trip per row, and it
 * holds the same publisher payload the corrupt value was taken from — the cost
 * buys a copy of what metadata already showed.
 *
 * `lock` decides whether the read claims its rows. A repairing batch takes
 * `FOR UPDATE` on the decisions alone, before the citation-graph lock, because
 * that is the order the ingestion pipeline takes them in: it locks the row it
 * is about to overwrite, then reopens the edges its identity change
 * invalidates. Taking them the other way round here would let one transaction
 * hold the row while waiting for the graph and the other hold the graph while
 * waiting for the row, which PostgreSQL resolves by aborting one of them. A
 * report-only read claims nothing.
 */
export const DECISION_DATE_ROW_LOCKS = {
  /** Claim the decision rows, in the pipeline's lock order. */
  FOR_UPDATE: "for-update",
  /** Read without claiming anything. */
  NONE: "none",
} as const;

export type DecisionDateRowLock =
  (typeof DECISION_DATE_ROW_LOCKS)[keyof typeof DECISION_DATE_ROW_LOCKS];

/** Pages of ids the corrupt-id collection may hold before it is paged. */
const CORRUPT_SCAN_PAGES = 100;

type SelectCorruptDecisionDatesOptions = {
  limit: number;
  lock: DecisionDateRowLock;
};

/*
 * The corrupt ids are collected in one materialized CTE and paged in a
 * second on purpose. The collection is capped at a multiple of the page
 * (unordered, so the date index still answers it) rather than materializing
 * an unexpectedly large population; a page drawn from a capped set is still
 * a page of corrupt rows, and the caller loops until a page is empty. Written as one statement over the join, the planner
 * estimates the date bounds to match a large share of the table and either
 * merge-joins over a full primary-key scan or walks the primary key in order
 * filtering every row; both outrun the statement timeout while the bounds
 * actually match a handful of rows. The first CTE keeps the predicate on its
 * own, where the date index answers it; the second applies the ordering and
 * the page limit to that set, so the join and the lock cost one primary-key
 * lookup per id.
 */

export const selectCorruptDecisionDatesStatement = ({
  limit,
  lock,
}: SelectCorruptDecisionDatesOptions): SQL => sql`
  WITH corrupt AS MATERIALIZED (
    SELECT d.id
      FROM case_law_decisions d
     WHERE ${OUT_OF_BOUNDS}
     LIMIT ${limit * CORRUPT_SCAN_PAGES}
  ),
  page AS MATERIALIZED (
    SELECT c.id
      FROM corrupt c
     ORDER BY c.id
     LIMIT ${limit}
  )
  SELECT d.id AS "id",
         s.adapter_key AS "adapterKey",
         d.decision_date::text AS "storedDate",
         d.metadata->>'decisionDate' AS "metadataDate",
         d.citation_key AS "citationKey",
         d.country AS "country"
    FROM page c
    JOIN case_law_decisions d ON d.id = c.id
    JOIN case_law_sources s ON s.id = d.source_id
   ORDER BY d.id
   LIMIT ${limit}
   ${lock === DECISION_DATE_ROW_LOCKS.FOR_UPDATE ? sql`FOR UPDATE OF d` : sql``}
`;

/** One corrupt row as `selectCorruptDecisionDatesStatement` returns it. */
export type CorruptDecisionDateRow = {
  adapterKey: string;
  /** The resolver's key and policy filters, carried so the run can reopen the
   * edges its date change invalidates without a second read. */
  citationKey: string | null;
  country: string;
  id: SafeId<"caseLawDecision">;
  metadataDate: string | null;
  storedDate: string;
};

const optionalString = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    panic("Corrupt-date selection returned a non-string where text was read");
  }
  return value;
};

const requiredString = (value: unknown): string => {
  const text = optionalString(value);
  if (text === null) {
    panic("Corrupt-date selection returned null in a NOT NULL column");
  }
  return text;
};

/**
 * One selected row, narrowed.
 *
 * `execute` returns untyped rows, and a repair that mis-reads a column would
 * write a decision made from the wrong field. A shape the query cannot produce
 * is a programmer error in the statement above it, so it panics rather than
 * being skipped: a run that quietly dropped rows would report a repair it did
 * not make.
 */
export const parseCorruptDecisionDateRow = (
  row: unknown,
): CorruptDecisionDateRow => {
  if (!isRecord(row)) {
    panic("Corrupt-date selection returned a non-row");
  }
  return {
    adapterKey: requiredString(row["adapterKey"]),
    citationKey: optionalString(row["citationKey"]),
    country: requiredString(row["country"]),
    id: brandPersistedCaseLawDecisionId(requiredString(row["id"])),
    metadataDate: optionalString(row["metadataDate"]),
    storedDate: requiredString(row["storedDate"]),
  };
};

export const DECISION_DATE_REPAIR_OUTCOMES = {
  /** Metadata carried a usable date the stored column had lost. */
  REDERIVED: "rederived",
  /** No source in the row survives; the column is set to NULL. */
  CLEARED: "cleared",
} as const;

export type DecisionDateRepairOutcome =
  (typeof DECISION_DATE_REPAIR_OUTCOMES)[keyof typeof DECISION_DATE_REPAIR_OUTCOMES];

export type DecisionDateRepair = {
  id: SafeId<"caseLawDecision">;
  /** The re-derived date, or `null` where none survives. */
  decisionDate: string | null;
  outcome: DecisionDateRepairOutcome;
};

/**
 * What one corrupt row becomes.
 *
 * Re-derivation runs the row's own metadata date through the same
 * `canonicalDecisionDate` the ingest writes through, so a value this accepts is
 * a value the write path would have stored. Nothing else in the row is
 * consulted: `metadata.publishedDate` is when the court published the document,
 * not when it decided the case, and substituting it would replace a visibly
 * wrong date with a plausibly wrong one.
 *
 * Everything else is cleared. Nulling is the designed fallback, not a
 * concession: the column is nullable, every reader already renders a decision
 * with no date, and an absent date is a fact a search facet, a sort, and a
 * citation can all handle correctly, while a year of 1168 is one none of them
 * can.
 */
export const decideDecisionDateRepair = ({
  id,
  metadataDate,
}: CorruptDecisionDateRow): DecisionDateRepair => {
  const rederived =
    metadataDate === null ? null : canonicalDecisionDate(metadataDate);
  if (rederived === null) {
    return {
      id,
      decisionDate: null,
      outcome: DECISION_DATE_REPAIR_OUTCOMES.CLEARED,
    };
  }
  return {
    id,
    decisionDate: rederived,
    outcome: DECISION_DATE_REPAIR_OUTCOMES.REDERIVED,
  };
};

/**
 * Write one batch of decided repairs.
 *
 * Every decision leaves the selection predicate, because both outcomes are
 * values the predicate does not match: the batch walk converges on an empty
 * batch without a cursor, and a keyset cursor over a self-consuming predicate
 * would only add a way to skip rows.
 *
 * `indexed_hash` is cleared in the same statement. The search projection
 * carries `decision_date` and its derived year, but `content_hash` covers only
 * the text payload, so a date-only change is invisible to the
 * `indexed_hash IS DISTINCT FROM content_hash` staleness test and the index
 * would keep serving the corrupt year forever. The projection trigger fires on
 * `indexed_hash` being assigned rather than on its value changing, which is the
 * same mechanism the ingestion pipeline uses for its own metadata-only updates.
 *
 * The predicate is re-checked here, against the row as it stands now rather
 * than as the selection read it: the crawl keeps running, and a decision it
 * re-observed in between already carries whatever date the write-path guard
 * allowed. Overwriting that with this run's decision would undo a repair with
 * a stale one. The returned ids are therefore the rows actually changed, which
 * is also what the citation graph has to be told about.
 */
export const applyDecisionDateRepairsStatement = (
  repairs: readonly DecisionDateRepair[],
): SQL => {
  if (repairs.length === 0) {
    panic("applyDecisionDateRepairsStatement called with no repairs");
  }
  // Cast every VALUES row rather than only the first: PostgreSQL infers the
  // column types from the first row, and a batch whose first date is NULL
  // would otherwise resolve to `text` and fail the assignment.
  const rows = repairs.map(
    ({ decisionDate, id }) => sql`(${id}::uuid, ${decisionDate}::date)`,
  );
  return sql`
    UPDATE case_law_decisions AS d
       SET decision_date = v.decision_date,
           indexed_hash = NULL
      FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(id, decision_date)
     WHERE d.id = v.id
       AND ${decisionDateOutOfBoundsSql(sql.raw("d.decision_date"))}
    RETURNING d.id
  `;
};

/** Rows from `execute` under either driver shape (bare array or `{ rows }`). */
export const executedRows = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"];
  }
  return [];
};

type CitationGraphTx = Parameters<typeof lockCitationGraph>[0];

/**
 * Tell the citation graph that this decision's date is no longer what it was.
 *
 * The resolver filters candidates on `decision_date` and reads NULL on either
 * side as permissive, so clearing a date both revives citations that were time
 * filtered away from this decision and contests edges that were drawn while it
 * was excluded. Neither is discoverable from the citing side, and the standing
 * walk only revisits unsettled rows, so an edge left alone here stays wrong
 * forever. Same four steps, in the same order, as the ingestion pipeline's own
 * resolution-identity change.
 *
 * False when the row's stored country declares no resolution policy: the key
 * is then not re-announced, because guessing a reach would write cross-border
 * edges on an assumption, which is the pipeline's stance too. The caller
 * reports it rather than defaulting it.
 */
const reopenAffectedCitations = async (
  tx: CitationGraphTx,
  row: CorruptDecisionDateRow,
  repaired: DecisionDateRepair,
): Promise<boolean> => {
  await reopenCitationsResolvedTo(tx, row.id);
  await reopenCitationsFrom(tx, row.id);
  if (row.citationKey === null) {
    return true;
  }
  await reopenCitationsForKeys(tx, [row.citationKey]);
  if (!isCaseLawJurisdiction(row.country)) {
    return false;
  }
  await reopenCitationsForDecisionKey(tx, {
    citationKey: row.citationKey,
    decisionId: row.id,
    jurisdiction: row.country,
    decisionDate: repaired.decisionDate,
  });
  return true;
};

export type DecisionDateRepairBatch = {
  cleared: number;
  rederived: number;
  /** Rows a concurrent observation had already repaired; skipped, not undone. */
  skipped: number;
  /**
   * Written rows whose stored country declares no resolution policy. Their
   * date is repaired; their key was not re-announced to the graph.
   */
  unannounced: CorruptDecisionDateRow[];
};

type ReopenWalk = {
  batch: DecisionDateRepairBatch;
  repairs: readonly DecisionDateRepair[];
  rows: readonly CorruptDecisionDateRow[];
  written: ReadonlySet<string>;
};

/**
 * Announce each written row to the citation graph, one after another.
 *
 * Recursive rather than a loop with an awaited body: the reopen statements are
 * graph mutations under one lock, so they must not fan out, and expressing that
 * as a walk keeps the sequencing structural instead of a suppressed lint.
 */
const reopenWrittenAt = async (
  tx: CitationGraphTx,
  { batch, repairs, rows, written }: ReopenWalk,
  offset = 0,
): Promise<void> => {
  const row = rows.at(offset);
  if (row === undefined) {
    return;
  }
  const repaired = repairs.at(offset);
  if (repaired === undefined) {
    panic("Repair decisions and selected rows fell out of step");
  }
  if (written.has(row.id)) {
    if (repaired.outcome === DECISION_DATE_REPAIR_OUTCOMES.REDERIVED) {
      batch.rederived += 1;
    } else {
      batch.cleared += 1;
    }
    const announced = await reopenAffectedCitations(tx, row, repaired);
    if (!announced) {
      batch.unannounced.push(row);
    }
  }
  await reopenWrittenAt(tx, { batch, repairs, rows, written }, offset + 1);
};

/**
 * One bounded batch of the repair, inside the caller's transaction.
 *
 * Decision rows first, citation graph second: the order the ingestion pipeline
 * takes them in, which is the only thing that keeps a concurrent refresh of one
 * of these decisions from deadlocking against this batch. Holding the rows is
 * also what makes the graph work sound: nothing can move a claimed row's date
 * between the reopen and the commit.
 *
 * An empty batch is the fixed point: every repaired row leaves the selection
 * predicate, so a caller loops until one returns nothing claimed.
 */
export const repairDecisionDateBatch = async (
  tx: CitationGraphTx,
  size: number,
): Promise<DecisionDateRepairBatch> => {
  const batch: DecisionDateRepairBatch = {
    cleared: 0,
    rederived: 0,
    skipped: 0,
    unannounced: [],
  };
  const rows = executedRows(
    await tx.execute(
      selectCorruptDecisionDatesStatement({
        limit: size,
        lock: DECISION_DATE_ROW_LOCKS.FOR_UPDATE,
      }),
    ),
  ).map(parseCorruptDecisionDateRow);
  if (rows.length === 0) {
    return batch;
  }
  await lockCitationGraph(tx);

  const repairs = rows.map(decideDecisionDateRepair);
  const written = new Set(
    executedRows(await tx.execute(applyDecisionDateRepairsStatement(repairs)))
      .filter(isRecord)
      .map((row) => String(row["id"])),
  );
  await reopenWrittenAt(tx, { batch, repairs, rows, written });
  batch.skipped = rows.length - written.size;
  return batch;
};
