import { ilike, like, sql } from "drizzle-orm";

declare const term: string;
declare const title: string;
declare const sourceRawS3Key: string;
declare const caseLawDecisions: { decisionDate: string };
declare const query: {
  from: (table: object) => { groupBy: (value: unknown) => unknown };
};

// oxlint-disable-next-line sql-perf/sql-perf -- fixture: leading wildcard
export const literal = sql`title LIKE '%word%'`;

// oxlint-disable-next-line sql-perf/sql-perf -- fixture: placeholder pattern
export const placeholder = sql`title NOT ILIKE ${`%${term}`}`;

// oxlint-disable-next-line sql-perf/sql-perf -- fixture: SQL concatenation
export const concatenated = sql`title LIKE '%' || ${term}`;

const pattern = `%${term}%`;
// oxlint-disable-next-line sql-perf/sql-perf -- fixture: same-file binding
export const bound = ilike(title, pattern);

// oxlint-disable-next-line sql-perf/sql-perf -- fixture: anchored key predicate
export const key = like(sourceRawS3Key, "pack:%");

// oxlint-disable-next-line sql-perf/sql-perf -- fixture: corpus group expression
export const grouped = sql`SELECT count(*) FROM case_law_decisions GROUP BY to_char(decision_date, 'YYYY')`;

const decisionYear = sql`to_char(${caseLawDecisions.decisionDate}, 'YYYY')`;
// oxlint-disable-next-line sql-perf/sql-perf -- fixture: Drizzle grouping expression
export const drizzleGroup = query.from(caseLawDecisions).groupBy(decisionYear);

// sql-perf-allow: small table clauses, capped 500 per org
export const small = sql`name LIKE '%x%'`;
// sql-perf-allow: index legislation_documents_eli_trgm_idx
export const indexed = sql`eli ILIKE '_x%'`;
// sql-perf-allow: bounded by keyset page on source_id LIMIT 500
export const bounded = sql`source_raw_s3_key LIKE 'pack:%'`;

// expect-clean: sql-perf/sql-perf
export const prefix = sql`title LIKE 'word%'`;
// expect-clean: sql-perf/sql-perf
export const selectOnly = sql`SELECT to_char(decision_date, 'YYYY') FROM case_law_decisions`;
// expect-clean: sql-perf/sql-perf
export const plainString = "title LIKE '%word%'";
