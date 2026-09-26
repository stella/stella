/**
 * The statements behind `repair-legacy-usa-court-ids.ts`, apart from the
 * script so a test runs exactly what an operator runs.
 */
import { sql, type SQL } from "drizzle-orm";

import { legacyTrustedUsaCourts } from "@/api/lib/case-law/decision-court-identity";
import { isRecord } from "@/api/lib/type-guards";
import { executedRows } from "@/api/scripts/repair-decision-dates-plan";

/**
 * The column exactly as migration 20260926110000_case_law_decision_court_id
 * adds it, so the migration's own IF NOT EXISTS keeps what this added.
 */
export const ENSURE_DECISION_COURT_ID_COLUMN_SQL =
  'ALTER TABLE "case_law_decisions" ADD COLUMN IF NOT EXISTS "court_id" varchar(64)';

type Executor = { execute: (query: SQL) => PromiseLike<unknown> };

const trustedNames = (): SQL =>
  sql.join(
    legacyTrustedUsaCourts().map(({ name }) => sql`${name}`),
    sql`, `,
  );

/**
 * Give up to `limit` USA rows without a court id the id of the trusted court
 * they name exactly; returns the ids it wrote. Idempotent: a repaired row
 * leaves the selection, so a rerun resumes where the last one stopped.
 */
export const repairLegacyUsaCourtIdBatch = async (
  tx: Executor,
  limit: number,
): Promise<string[]> => {
  const assignment = sql.join(
    legacyTrustedUsaCourts().map(
      ({ courtId, name }) => sql`WHEN ${name} THEN ${courtId}`,
    ),
    sql` `,
  );
  const rows = executedRows(
    await tx.execute(sql`
      UPDATE "case_law_decisions"
         SET "court_id" = CASE "court" ${assignment} END
       WHERE "id" IN (
         SELECT "id" FROM "case_law_decisions"
          WHERE "country" = 'USA'
            AND "court_id" IS NULL
            AND "court" IN (${trustedNames()})
          ORDER BY "id"
          LIMIT ${limit}
       )
      RETURNING "id"
    `),
  );
  return rows.flatMap((row) =>
    isRecord(row) && typeof row["id"] === "string" ? [row["id"]] : [],
  );
};

export type LegacyUsaCourtCensusRow = {
  court: string;
  rows: number;
  /** Whether the repair gives these rows an id; otherwise source them. */
  trusted: boolean;
};

/**
 * USA rows the migration would refuse, by court name. Before the column exists
 * every USA row lacks an id.
 */
export const legacyUsaCourtIdCensus = async (
  tx: Executor,
  { columnExists }: { columnExists: boolean },
): Promise<LegacyUsaCourtCensusRow[]> => {
  const trusted = new Set(legacyTrustedUsaCourts().map(({ name }) => name));
  const rows = executedRows(
    await tx.execute(sql`
      SELECT "court", count(*)::int AS "rows"
        FROM "case_law_decisions"
       WHERE "country" = 'USA'
         ${columnExists ? sql`AND "court_id" IS NULL` : sql``}
       GROUP BY "court"
       ORDER BY "court"
    `),
  );
  return rows.flatMap((row) =>
    isRecord(row) &&
    typeof row["court"] === "string" &&
    typeof row["rows"] === "number"
      ? [
          {
            court: row["court"],
            rows: row["rows"],
            trusted: trusted.has(row["court"]),
          },
        ]
      : [],
  );
};

/** Whether `case_law_decisions.court_id` exists yet. */
export const decisionCourtIdColumnExists = async (
  tx: Executor,
): Promise<boolean> =>
  executedRows(
    await tx.execute(sql`
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'case_law_decisions'
         AND column_name = 'court_id'
    `),
  ).length > 0;
