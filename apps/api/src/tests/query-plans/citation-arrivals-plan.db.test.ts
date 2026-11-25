import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import {
  arrivingRowsOf,
  citationArrivalsOf,
  UNKEYED_CITATIONS_REMAIN_SQL,
} from "@/api/handlers/case-law/citation-arrivals";
import { reopenForArrivalsSql } from "@/api/handlers/case-law/citation-resolution";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { citationMatchKeyBatchSql } from "../../db/citation-identifier-match-key-backfill";
import pendingMatchKey from "../../db/online-migration-entries/indexes-case-law-citations-identifier-match-key-pending-idx";
import storedMatchKey from "../../db/online-migration-entries/indexes-case-law-citations-reopenable-stored-match-key-idx";

/**
 * The arrival reopen reads citations through indexes only: the stored match
 * key on the citation side, the identifiers' match-key index on the holder
 * side and the cited-decision index from a holder to its citations. Measured
 * on real rows in the full schema, analyzed as production is, so the planner
 * prices the indexes the online phase builds against a table it can no
 * longer afford to scan.
 */

const DECISIONS = 2000;
const CITATIONS = 20_000;

let client: Awaited<ReturnType<typeof createTestPglite>>;
const dialect = new PgDialect();

// timeout: boots the schema and seeds and analyzes 20,000 citations.
beforeAll(
  async () => {
    client = await createTestPglite();
    await client.exec(`
      INSERT INTO case_law_sources (id, adapter_key, name)
        VALUES ('00000000-0000-7000-8000-000000000001', 'plan-arrivals', 'plan');
      INSERT INTO case_law_decisions (
        id, source_id, court, country, language, fulltext, case_number,
        citation_key, decision_date, slug, language_group_key
      )
      SELECT gen_random_uuid(), '00000000-0000-7000-8000-000000000001', 'Court',
             (ARRAY['CZE', 'SVK'])[1 + n % 2], 'cs', 'text',
             n || ' Cdo ' || n || '/' || (2000 + n % 20),
             n || 'cdo/' || n || '/' || (2000 + n % 20),
             date '2010-01-01' + (n % 3000),
             'plan-' || n, 'plan-' || n
        FROM generate_series(1, ${String(DECISIONS)}) AS n;
      INSERT INTO case_law_decision_identifiers (decision_id, type, value, normalized_value)
      SELECT id, 'case-number', citation_key, citation_key FROM case_law_decisions;
      -- The other identifiers decisions hold, so the identifiers table is
      -- larger than one probe per arrival, as it is in production.
      INSERT INTO case_law_decision_identifiers (decision_id, type, value, normalized_value)
      SELECT d.id, 'reporter-citation', 'r ' || d.citation_key || ' ' || k,
             'r ' || d.citation_key || ' ' || k
        FROM case_law_decisions d, generate_series(1, 9) AS k;
      CREATE TEMP TABLE plan_decisions AS
        SELECT id, (row_number() OVER (ORDER BY id) - 1)::int AS n
          FROM case_law_decisions;
      INSERT INTO case_law_citations (
        id, citing_decision_id, cited_decision_id, citation_text, citation_key,
        identifier_type, normalized_identifier_value, resolution_status
      )
      SELECT gen_random_uuid(), citing.id,
             CASE WHEN g.n % 4 = 0 THEN cited.id END,
             'citation ' || g.n,
             g.k || 'cdo/' || g.k || '/' || (g.k % 20),
             'case-number',
             g.k || 'cdo/' || g.k || '/' || (g.k % 20),
             (ARRAY['resolved', 'unmatched', 'ambiguous', 'pending'])[1 + g.n % 4]
        FROM (
          SELECT n, n % ${String(DECISIONS)} + 1 AS k
            FROM generate_series(1, ${String(CITATIONS)}) AS n
        ) g
        JOIN plan_decisions citing ON citing.n = (g.n * 7) % ${String(DECISIONS)}
        JOIN plan_decisions cited ON cited.n = (g.n * 13) % ${String(DECISIONS)};
      ANALYZE case_law_decisions;
      ANALYZE case_law_decision_identifiers;
      ANALYZE case_law_citations;
    `);
  },
  { timeout: 240_000 },
);

afterAll(async () => {
  await client.close();
});

type PlanNodes = { indexes: string[]; scanned: string[] };

/** The indexes a statement's plan reads, and the relations it scans whole. */
const planOf = async (statement: SQL | string, params: unknown[] = []) => {
  const query =
    typeof statement === "string"
      ? { sql: statement, params }
      : dialect.sqlToQuery(statement);
  const { rows } = await client.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (FORMAT JSON) ${query.sql}`,
    query.params,
  );
  const nodes: PlanNodes = { indexes: [], scanned: [] };
  const walk = (node: unknown): void => {
    if (!isRecord(node)) {
      return;
    }
    const index = node["Index Name"];
    if (typeof index === "string") {
      nodes.indexes.push(index);
    }
    const relation = node["Relation Name"];
    if (node["Node Type"] === "Seq Scan" && typeof relation === "string") {
      nodes.scanned.push(relation);
    }
    const children = node["Plans"];
    if (Array.isArray(children)) {
      for (const child of children) {
        walk(child);
      }
    }
  };
  const explained = rows.at(0)?.["QUERY PLAN"];
  const plan = Array.isArray(explained) ? explained.at(0) : undefined;
  walk(isRecord(plan) ? plan["Plan"] : undefined);
  return nodes;
};

const arriving = arrivingRowsOf(
  [17, 18, 400, 1999].flatMap((n) =>
    citationArrivalsOf({
      decisionId: brandPersistedCaseLawDecisionId(
        `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
      ),
      jurisdiction: "CZE",
      decisionDate: "2015-01-01",
      identifiers: [
        {
          type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          normalizedValue: `${String(n)}cdo/${String(n)}/${String(2000 + (n % 20))}`,
        },
      ],
    }),
  ),
);

test("the reopen reads the stored match key and never scans the citations", async () => {
  const plan = await planOf(
    reopenForArrivalsSql({ arriving, matchUnkeyed: false, cap: 200 }),
  );
  expect(plan.indexes).toContain(
    "case_law_citations_reopenable_stored_match_key_idx",
  );
  expect(plan.indexes).toContain("case_law_decision_identifiers_match_key_idx");
  expect(plan.scanned).not.toContain("case_law_citations");
  expect(plan.scanned).not.toContain("case_law_decision_identifiers");
});

test("while unkeyed rows remain, their arm reads the folded-column index", async () => {
  // Half the rows as they were stored before the column, analyzed as the
  // backfill window is; restored by the repair's own statement afterwards.
  await client.exec(`
    ALTER TABLE case_law_citations DISABLE TRIGGER case_law_citations_identifier_match_key;
    UPDATE case_law_citations SET identifier_match_key = NULL
     WHERE ('x' || substr(id::text, 1, 1))::bit(4)::int % 2 = 0;
    ALTER TABLE case_law_citations ENABLE TRIGGER case_law_citations_identifier_match_key;
    ANALYZE case_law_citations;
  `);
  try {
    const plan = await planOf(
      reopenForArrivalsSql({ arriving, matchUnkeyed: true, cap: 200 }),
    );
    expect(plan.indexes).toContain(
      "case_law_citations_reopenable_stored_match_key_idx",
    );
    expect(plan.indexes).toContain(
      "case_law_citations_reopenable_identifier_match_key_idx",
    );
    expect(plan.scanned).not.toContain("case_law_citations");
  } finally {
    await client.query(
      citationMatchKeyBatchSql('public."case_law_citations"', { after: false }),
      [CITATIONS],
    );
    await client.exec("ANALYZE case_law_citations;");
  }
});

test("the unkeyed probe and the repair walk read the pending index", async () => {
  const probe = await planOf(UNKEYED_CITATIONS_REMAIN_SQL);
  expect(probe.indexes).toEqual([
    "case_law_citations_identifier_match_key_pending_idx",
  ]);
  expect(probe.scanned).toEqual([]);
  for (const after of [false, true]) {
    // db-await-in-loop: the repair's first batch and every later one
    const batch = await planOf(
      citationMatchKeyBatchSql('public."case_law_citations"', { after }),
      after ? [2000, "00000000-0000-7000-8000-000000000000"] : [2000],
    );
    expect(batch.indexes).toContain(
      "case_law_citations_identifier_match_key_pending_idx",
    );
    expect(batch.scanned).not.toContain("case_law_citations");
  }
});

test("each online entry builds the index the schema declares", async () => {
  for (const { name, definitionBody } of [
    ...storedMatchKey.values,
    ...pendingMatchKey.values,
  ]) {
    // db-await-in-loop: two indexes, read one by one
    const { rows } = await client.query<{ definition: string | null }>(
      "SELECT pg_get_indexdef(to_regclass($1)) AS definition",
      [name],
    );
    expect(rows.at(0)?.definition).toBe(
      `CREATE INDEX ${name} ${definitionBody}`,
    );
  }
});
