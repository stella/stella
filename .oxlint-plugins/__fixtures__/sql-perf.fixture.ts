import {
  and,
  eq,
  ilike,
  inArray,
  like,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";

declare const term: string;
declare const title: string;
declare const sourceRawS3Key: string;
declare const caseLawDecisions: {
  decisionDate: string;
  ecli: string;
  id: string;
};
declare const identifiers: { decisionId: string };
declare const tx: {
  select: (columns?: object) => {
    from: (table: object) => { where: (predicate: unknown) => unknown };
  };
};
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

// oxlint-disable-next-line sql-perf/sql-perf -- fixture: OR with a select operand
export const ecliOr = or(
  inArray(caseLawDecisions.ecli, [term]),
  inArray(
    caseLawDecisions.id,
    tx
      .select({ id: identifiers.decisionId })
      .from(identifiers)
      .where(eq(identifiers.decisionId, term)),
  ),
);

// oxlint-disable-next-line sql-perf/sql-perf -- fixture: SQL text OR/subquery
export const sqlOr = sql`SELECT id FROM case_law_decisions WHERE ecli = ${term} OR id IN (SELECT decision_id FROM case_law_decision_identifiers)`;

// oxlint-disable-next-line sql-perf/sql-perf -- fixture: SQL text NOT IN subquery
export const sqlNotIn = sql`SELECT id FROM case_law_decisions WHERE ecli = ${term} OR id NOT IN (SELECT decision_id FROM case_law_decision_identifiers)`;

// oxlint-disable-next-line sql-perf/sql-perf -- fixture: interpolated select builder
export const sqlInterpolatedIn = sql`SELECT id FROM case_law_decisions WHERE ecli = ${term} OR ${caseLawDecisions.id} IN (${tx.select({ id: identifiers.decisionId }).from(identifiers)})`;

// oxlint-disable-next-line sql-perf/sql-perf -- fixture: SQL text ANY subquery
export const sqlAny = sql`SELECT id FROM case_law_decisions WHERE ecli = ${term} OR id = ANY (SELECT decision_id FROM case_law_decision_identifiers)`;

// oxlint-disable-next-line sql-perf/sql-perf -- fixture: SQL text tuple subquery
export const sqlTupleIn = sql`SELECT id FROM case_law_decisions WHERE ecli = ${term} OR (id, country) IN (SELECT decision_id, country FROM case_law_decision_identifiers)`;

// oxlint-disable-next-line sql-perf/sql-perf -- fixture: left SQL EXISTS operand
export const leftExistsOr = sql`SELECT id FROM case_law_decisions WHERE EXISTS (SELECT 1 FROM case_law_decision_identifiers) OR ecli = ${term}`;

// oxlint-disable-next-line sql-perf/sql-perf -- fixture: left SQL IN operand
export const leftInOr = sql`SELECT id FROM case_law_decisions WHERE id IN (SELECT decision_id FROM case_law_decision_identifiers) OR ecli = ${term}`;

// oxlint-disable-next-line sql-perf/sql-perf -- fixture: left SQL NOT IN operand
export const leftNotInOr = sql`SELECT id FROM case_law_decisions WHERE id NOT IN (SELECT decision_id FROM case_law_decision_identifiers) OR ecli = ${term}`;

// oxlint-disable-next-line sql-perf/sql-perf -- fixture: raw SQL EXISTS operand
export const rawExistsOr = or(
  eq(caseLawDecisions.id, term),
  sql`EXISTS (SELECT 1 FROM case_law_decision_identifiers)`,
);

// oxlint-disable-next-line sql-perf/sql-perf -- fixture: raw SQL SELECT operand
export const rawSelectOr = or(
  eq(caseLawDecisions.id, term),
  sql`id IN (SELECT decision_id FROM case_law_decision_identifiers)`,
);

// oxlint-disable-next-line sql-perf/sql-perf -- fixture: negative membership select operand
export const negativeMembershipOr = or(
  eq(caseLawDecisions.ecli, term),
  notInArray(
    caseLawDecisions.id,
    tx.select({ id: identifiers.decisionId }).from(identifiers),
  ),
);

// oxlint-disable-next-line sql-perf/sql-perf -- fixture: notExists operand
export const existsOr = or(
  eq(caseLawDecisions.id, term),
  notExists(tx.select().from(identifiers)),
);

// expect-clean: sql-perf/sql-perf
export const unionIdentity = inArray(
  caseLawDecisions.id,
  unionAll(
    tx.select({ id: caseLawDecisions.id }).from(caseLawDecisions),
    tx.select({ id: identifiers.decisionId }).from(identifiers),
  ),
);
// expect-clean: sql-perf/sql-perf
export const sameColumnOr = or(
  eq(caseLawDecisions.ecli, term),
  eq(caseLawDecisions.ecli, title),
);
// expect-clean: sql-perf/sql-perf
export const keysetOr = or(
  sql`${caseLawDecisions.decisionDate} > ${term}`,
  and(
    eq(caseLawDecisions.decisionDate, term),
    sql`${caseLawDecisions.id} > ${title}`,
  ),
);

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
