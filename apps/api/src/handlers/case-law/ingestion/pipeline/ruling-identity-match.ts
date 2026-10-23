import { eq, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

type RepublishedRulingCourtColumns = {
  court: SQL | PgColumn;
  courtId: SQL | PgColumn;
};

type RepublishedRulingObservedCourt = {
  court: string | SQL | PgColumn | null | undefined;
  courtId: string | SQL | PgColumn | null | undefined;
};

const courtNameKeySql = (court: SQL | PgColumn): SQL => sql`
  lower(regexp_replace(normalize(${court}, NFKD), '[[:space:]]+', '', 'g'))
`;

/** Same court: equal court ids when both sides have one, else equal names. */
export const republishedRulingCourtPredicate = (
  observed: RepublishedRulingObservedCourt,
  columns: RepublishedRulingCourtColumns,
): SQL => {
  const nameMatches = eq(
    courtNameKeySql(columns.court),
    courtNameKeySql(
      typeof observed.court === "string"
        ? sql`${observed.court}`
        : (observed.court ?? sql``),
    ),
  );
  if (observed.courtId === undefined || observed.courtId === null) {
    return nameMatches;
  }
  return sql`(
    (${columns.courtId} IS NOT NULL AND ${observed.courtId} IS NOT NULL
      AND ${columns.courtId} = ${observed.courtId})
    OR ((${columns.courtId} IS NULL OR ${observed.courtId} IS NULL)
      AND ${nameMatches})
  )`;
};
