/**
 * The selection and the decision `repair-cz-ns-court.ts` runs, separated from
 * the script that runs them.
 *
 * An operator script is a module with a side effect at the top level, so
 * nothing can import it and nothing in CI ever executes its SQL. Keeping the
 * statements here, where a database test can execute them and a unit test can
 * exercise the decision, is what closes that gap.
 */

import { panic } from "better-result";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { SafeId } from "@/api/lib/branded-types";
import { czCourtFromEcli } from "@/api/lib/case-law/cz-ecli-courts";
import {
  pgTimestampCursorBoundary,
  pgTimestampCursorValue,
} from "@/api/lib/db-pagination";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedCaseLawSourceId,
} from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

/** One stored decision, as the selection reads it. */
export type CzNsCourtRow = {
  id: SafeId<"caseLawDecision">;
  ecli: string;
  court: string;
};

/** Where a walk of the source stands: the last row a page examined. */
export type CzNsCourtCursor = {
  /**
   * The row's `created_at`, the leading key of the index the walk uses, as
   * the database's own microsecond text.
   *
   * Never a `Date`: the column is microsecond-precision and a `Date` holds
   * milliseconds, so a cursor round-tripped through one lands before the row
   * it was taken from. The rows sharing that millisecond are then read again
   * by the next page — and the last row of the source is read by every page
   * after it, which is a walk that never ends.
   */
  createdAt: string;
  id: SafeId<"caseLawDecision">;
};

/** What one page of the walk examined, and which of it needs repairing. */
export type CzNsCourtPage = {
  /** Rows on this page whose ECLI names a court other than the publisher's. */
  rows: CzNsCourtRow[];
  /** Rows the page examined, matching or not. Zero ends the walk. */
  scanned: number;
  /** Where the next page starts, or null when the source is exhausted. */
  cursor: CzNsCourtCursor | null;
};

/** The source a repair owns, looked up once by the adapter that wrote it. */
export const czNsSourceIdStatement = (adapterKey: string): SQL => sql`
  SELECT id FROM case_law_sources WHERE adapter_key = ${adapterKey}
`;

/**
 * One page of a walk of the source, and whichever of its rows carry an ECLI
 * naming a court other than the publisher's own.
 *
 * The bound is on rows examined, not on rows matched, and that is the whole
 * point. The population is a few hundred rows among the source's many
 * thousands, so a statement whose `LIMIT` counts matches scans forward until
 * it finds them — and the last such statement, with no matches left to find,
 * reads every remaining row of the source and is cancelled by the lane's
 * statement timeout. Here the page takes a fixed number of rows in index
 * order and the filter runs over those rows alone, so every statement of the
 * walk costs the same bounded amount whatever the data holds.
 *
 * The order is the source's own cursor index (`source_id, created_at, id`),
 * so a page is an index range rather than a sort of everything the source
 * holds. The primary key would have been the obvious cursor and the wrong
 * one: it is random per row, so ordering by it reads the whole partition
 * before serving the first page.
 *
 * The bound comes back on every row, including on a page that matched
 * nothing, because a page that advances no cursor is a walk that never ends.
 * A source with no rows past the cursor returns nothing at all, which is the
 * one way the walk finishes.
 */
export const selectCzNsCourtPageStatement = ({
  after,
  pageSize,
  publisherEcliCode,
  sourceId,
}: {
  after: CzNsCourtCursor | null;
  pageSize: number;
  publisherEcliCode: string;
  sourceId: SafeId<"caseLawSource">;
}): SQL => sql`
  WITH page AS (
    SELECT d.id, d.ecli, d.court, d.created_at
      FROM case_law_decisions d
     WHERE d.source_id = ${sourceId}::uuid
       ${
         after === null
           ? sql``
           : sql`AND (d.created_at, d.id) > (${pgTimestampCursorBoundary({
               type: "pgTimestampCursor",
               value: after.createdAt,
               precision: "microseconds",
             })}, ${after.id}::uuid)`
       }
     ORDER BY d.created_at, d.id
     LIMIT ${pageSize}
  ),
  bound AS (
    SELECT created_at, id, (SELECT count(*) FROM page)::int AS scanned
      FROM page
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  )
  SELECT ${pgTimestampCursorValue(sql`b.created_at`)} AS cursor_created_at,
         b.id AS cursor_id,
         b.scanned AS scanned,
         p.id AS match_id,
         p.ecli AS match_ecli,
         p.court AS match_court
    FROM bound b
    LEFT JOIN page p
      ON p.ecli IS NOT NULL
     AND p.ecli LIKE 'ECLI:CZ:%'
     AND split_part(p.ecli, ':', 3) <> ${publisherEcliCode}
`;

const requiredString = (value: unknown, column: string): string => {
  if (typeof value !== "string") {
    return panic(`cz-ns court page column ${column} is not a string`);
  }
  return value;
};

/**
 * A page read back from a driver result that is untyped by construction.
 *
 * An empty result is the end of the walk; anything else states the bound on
 * every row, so the first row is enough to read it from.
 */
export const parseCzNsCourtPage = (rows: readonly unknown[]): CzNsCourtPage => {
  const first = rows.at(0);
  if (first === undefined) {
    return { rows: [], scanned: 0, cursor: null };
  }
  if (!isRecord(first) || typeof first["scanned"] !== "number") {
    return panic(`Unreadable cz-ns court page: ${JSON.stringify(first)}`);
  }
  const cursor: CzNsCourtCursor = {
    // The statement projects this as text at microsecond precision, so it
    // arrives as the database's own value rather than as a driver's `Date`.
    // Reading it as anything else is a statement this parser no longer
    // matches, not a value to coerce.
    createdAt: requiredString(first["cursor_created_at"], "cursor_created_at"),
    id: brandPersistedCaseLawDecisionId(
      requiredString(first["cursor_id"], "cursor_id"),
    ),
  };

  const matched: CzNsCourtRow[] = [];
  for (const row of rows) {
    if (!isRecord(row) || row["match_id"] === null) {
      continue;
    }
    matched.push({
      id: brandPersistedCaseLawDecisionId(
        requiredString(row["match_id"], "match_id"),
      ),
      ecli: requiredString(row["match_ecli"], "match_ecli"),
      court: requiredString(row["match_court"], "match_court"),
    });
  }

  return { rows: matched, scanned: first["scanned"], cursor };
};

export const CZ_NS_COURT_REPAIR_OUTCOMES = {
  /** The stored court is not what the decision's ECLI names. */
  REATTRIBUTED: "reattributed",
  /** The stored court already matches the ECLI. */
  HELD: "held",
  /** The ECLI names a court code the map does not know. */
  UNKNOWN_CODE: "unknown-code",
} as const;

export type CzNsCourtRepairOutcome =
  (typeof CZ_NS_COURT_REPAIR_OUTCOMES)[keyof typeof CZ_NS_COURT_REPAIR_OUTCOMES];

/** A row the run writes: the court it holds now, and the one it should. */
export type CzNsCourtReattribution = {
  outcome: typeof CZ_NS_COURT_REPAIR_OUTCOMES.REATTRIBUTED;
  id: SafeId<"caseLawDecision">;
  from: string;
  court: string;
};

export type CzNsCourtRepair =
  | CzNsCourtReattribution
  | {
      outcome: typeof CZ_NS_COURT_REPAIR_OUTCOMES.HELD;
      id: SafeId<"caseLawDecision">;
    }
  | {
      outcome: typeof CZ_NS_COURT_REPAIR_OUTCOMES.UNKNOWN_CODE;
      id: SafeId<"caseLawDecision">;
      /** The court code the ECLI names, which this map cannot resolve. */
      code: string;
    };

/**
 * What one selected row's ECLI says its court should be.
 *
 * A code the map does not know is reported, never guessed at: this run cannot
 * name that court, and writing anything for it would put a value into the
 * corpus that no source states. The publisher's own crawl reports the same
 * code through `czDecisionCourt`, so the two paths raise one signal.
 */
export const decideCzNsCourtRepair = ({
  court,
  ecli,
  id,
}: CzNsCourtRow): CzNsCourtRepair => {
  const fromEcli = czCourtFromEcli(ecli);
  switch (fromEcli.type) {
    case "named":
      return fromEcli.court === court
        ? { outcome: CZ_NS_COURT_REPAIR_OUTCOMES.HELD, id }
        : {
            outcome: CZ_NS_COURT_REPAIR_OUTCOMES.REATTRIBUTED,
            id,
            from: court,
            court: fromEcli.court,
          };
    case "unknown-code":
      return {
        outcome: CZ_NS_COURT_REPAIR_OUTCOMES.UNKNOWN_CODE,
        id,
        code: fromEcli.code,
      };
    // The selection admits only rows whose ECLI is a Czech one, so this is a
    // row that changed under the walk rather than a shape to decide on.
    case "unstated":
      return { outcome: CZ_NS_COURT_REPAIR_OUTCOMES.HELD, id };
    default: {
      fromEcli satisfies never;
      return panic(`Unhandled Czech ECLI court: ${JSON.stringify(fromEcli)}`);
    }
  }
};

/**
 * Write one row's court, the copy of it the row's metadata carries, and the
 * two marks that tell the search projections the row moved.
 *
 * Guarded on the court the selection read: the crawl keeps running, and a
 * decision it re-ingested in between already carries what the fixed adapter
 * derived. Overwriting that with this run's value would be a stale write, so
 * the statement returns nothing for such a row and the run counts it as
 * superseded rather than repaired.
 *
 * `updated_at` is set here rather than left to the caller, because a court
 * that changes in the row and nowhere else is served under its old name for as
 * long as the deployment stands. It is the staleness test the PostgreSQL
 * full-text projection runs (`decisions.updated_at > search_documents.updated_at`),
 * and raw SQL does not go through the ORM's own timestamp. It does not reach
 * the corpus index; that is reconciled by the caller, inside the same
 * transaction as this statement.
 */
export const applyCzNsCourtRepairStatement = ({
  court,
  from,
  id,
}: {
  court: string;
  from: string;
  id: SafeId<"caseLawDecision">;
}): SQL => sql`
  UPDATE case_law_decisions AS d
     SET court = ${court},
         metadata = jsonb_set(
           COALESCE(d.metadata, '{}'::jsonb), '{court}', to_jsonb(${court}::text)
         ),
         updated_at = now()
   WHERE d.id = ${id}::uuid
     AND d.court = ${from}
  RETURNING d.id
`;

/** The source id a lookup answered with, or null when no source matches. */
export const parseCzNsSourceId = (
  rows: readonly unknown[],
): SafeId<"caseLawSource"> | null => {
  const row = rows.at(0);
  if (row === undefined) {
    return null;
  }
  if (!isRecord(row) || typeof row["id"] !== "string") {
    return panic(`Unreadable case-law source row: ${JSON.stringify(row)}`);
  }
  return brandPersistedCaseLawSourceId(row["id"]);
};
