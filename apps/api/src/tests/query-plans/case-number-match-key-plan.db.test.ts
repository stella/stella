import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  citationReopenableByKeySql,
  effectiveCitationIdentifierTypeSql,
  effectiveCitationIdentifierValueSql,
  settledCitationSql,
} from "@/api/handlers/case-law/citation-resolution-status";
import {
  caseNumberKeyAmongSql,
  caseNumberKeysMatchSql,
} from "@/api/lib/case-law/case-number-match-key";
import { publishedCaseLawDecisionSqlFor } from "@/api/lib/case-law/published-decisions-sql";
import { isRecord } from "@/api/lib/type-guards";

import citationsBackfillMatchKey from "../../db/online-migration-entries/indexes-case-law-citations-identifier-backfill-match-key-idx";
import citationsReopenableIdentifierMatchKey from "../../db/online-migration-entries/indexes-case-law-citations-reopenable-identifier-match-key-idx";
import citationsReopenableMatchKey from "../../db/online-migration-entries/indexes-case-law-citations-reopenable-match-key-idx";
import identifiersMatchKey from "../../db/online-migration-entries/indexes-case-law-decision-identifiers-match-key-idx";
import decisionsMatchKey from "../../db/online-migration-entries/indexes-case-law-decisions-citation-match-key-all-idx";
import decisionsPublishedMatchKey from "../../db/online-migration-entries/indexes-case-law-decisions-citation-match-key-published-idx";

/**
 * Every key comparison the resolver, the reopen paths and the exact lookup
 * build reads its match-key index: the comparison fragments of
 * `case-number-match-key.ts` against the indexes the online entries build.
 *
 * Measured on real rows rather than through the plan registry: the
 * registry's synthetic profile restores column statistics but none for an
 * index expression, and keeps each index file at its seed size, so there the
 * planner prices reading a whole small raw-key index below one probe of the
 * expression it has no statistics for. ANALYZE here gathers the expression's
 * statistics as production does.
 */

const ROWS = 20_000;
const MATCH_KEY_INDEXES = [
  identifiersMatchKey,
  decisionsMatchKey,
  decisionsPublishedMatchKey,
  citationsReopenableMatchKey,
  citationsReopenableIdentifierMatchKey,
  citationsBackfillMatchKey,
].flatMap((entry) => entry.values);

let client: PGlite;
const dialect = new PgDialect();

// timeout: seeds and analyzes 20,000 rows in each of three tables.
beforeAll(
  async () => {
    client = new PGlite();
    await client.exec(`
      CREATE TABLE case_law_decisions (
        id uuid, citation_key varchar(128), country varchar(8),
        decision_date date, metadata jsonb, redacted_at timestamptz
      );
      CREATE TABLE case_law_decision_identifiers (
        decision_id uuid, type varchar(64), normalized_value varchar(512)
      );
      CREATE TABLE case_law_citations (
        id uuid, citation_key varchar(128), identifier_type varchar(32),
        normalized_identifier_value varchar(512), resolution_status text
      );
      INSERT INTO case_law_decisions
        SELECT gen_random_uuid(), n || 'cdo/' || n || '/' || (2000 + n % 20),
               'CZE', date '2010-01-01' + (n % 3000), '{}'::jsonb, NULL
          FROM generate_series(1, ${String(ROWS)}) AS n;
      INSERT INTO case_law_decision_identifiers
        SELECT id, 'case-number', citation_key FROM case_law_decisions;
      INSERT INTO case_law_citations
        SELECT gen_random_uuid(), n || 'cdo/' || n || '/' || (n % 20),
               'case-number', n || 'cdo/' || n || '/' || (n % 20),
               (ARRAY['resolved', 'unmatched', 'ambiguous', 'pending'])[1 + n % 4]
          FROM generate_series(1, ${String(ROWS)}) AS n;
    `);
    for (const { createSql } of MATCH_KEY_INDEXES) {
      // db-await-in-loop: six indexes, built as the online phase builds them
      await client.query(createSql);
    }
    await client.exec(
      "ANALYZE case_law_decisions; ANALYZE case_law_decision_identifiers; ANALYZE case_law_citations;",
    );
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

/** The indexes a statement's plan reads, by name. */
const indexesRead = async (statement: SQL): Promise<string[]> => {
  const { sql: text, params } = dialect.sqlToQuery(statement);
  const { rows } = await client.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (FORMAT JSON) ${text}`,
    params,
  );
  const names: string[] = [];
  const walk = (node: unknown): void => {
    if (!isRecord(node)) {
      return;
    }
    const name = node["Index Name"];
    if (typeof name === "string") {
      names.push(name);
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
  return names;
};

const PRINTED = "77cdo/77/2017";

test("the exact lookup reads the published match-key index for a decision's own key", async () => {
  expect(
    await indexesRead(sql`
      SELECT d.id FROM case_law_decisions d
       WHERE ${caseNumberKeyAmongSql(sql.raw("d.citation_key"), [PRINTED, "78cdo/78/2018"])}
         AND ${sql.raw(publishedCaseLawDecisionSqlFor("d"))}
    `),
  ).toEqual(["case_law_decisions_citation_match_key_published_idx"]);
});

test("identifier lookups and holder joins read the identifier match-key index", async () => {
  expect(
    await indexesRead(sql`
      SELECT i.decision_id FROM case_law_decision_identifiers i
       WHERE i.type = 'case-number'
         AND ${caseNumberKeyAmongSql(sql.raw("i.normalized_value"), [PRINTED])}
    `),
  ).toEqual(["case_law_decision_identifiers_match_key_idx"]);
  expect(
    await indexesRead(sql`
      SELECT i.decision_id FROM case_law_decision_identifiers i
       WHERE i.type = coalesce(${null}::varchar, 'case-number')
         AND ${caseNumberKeysMatchSql(
           sql.raw("i.normalized_value"),
           effectiveCitationIdentifierValueSql(
             sql`${null}::varchar`,
             sql`${PRINTED}::varchar`,
           ),
         )}
    `),
  ).toEqual(["case_law_decision_identifiers_match_key_idx"]);
});

test("the resolver's holder join reads the decisions match-key index", async () => {
  expect(
    await indexesRead(sql`
      SELECT h.id FROM case_law_decisions h
       WHERE ${caseNumberKeysMatchSql(sql.raw("h.citation_key"), sql`${PRINTED}::varchar`)}
         AND h.country = 'CZE'
    `),
  ).toEqual(["case_law_decisions_citation_match_key_all_idx"]);
});

test("the reopen and backfill paths read the citation match-key indexes", async () => {
  expect(
    await indexesRead(sql`
      SELECT c.id FROM case_law_citations c
       WHERE ${caseNumberKeyAmongSql(sql.raw("c.citation_key"), [PRINTED])}
         AND ${citationReopenableByKeySql(sql.raw("c.resolution_status"))}
    `),
  ).toEqual(["case_law_citations_reopenable_match_key_idx"]);
  const effectiveIdentity = sql`${effectiveCitationIdentifierTypeSql(
    sql.raw("c.identifier_type"),
  )} = 'case-number' AND ${caseNumberKeysMatchSql(
    sql`${PRINTED}::varchar`,
    effectiveCitationIdentifierValueSql(
      sql.raw("c.normalized_identifier_value"),
      sql.raw("c.citation_key"),
    ),
  )}`;
  expect(
    await indexesRead(sql`
      SELECT c.id FROM case_law_citations c
       WHERE ${effectiveIdentity}
         AND ${citationReopenableByKeySql(sql.raw("c.resolution_status"))}
    `),
  ).toEqual(["case_law_citations_reopenable_identifier_match_key_idx"]);
  expect(
    await indexesRead(sql`
      SELECT c.id FROM case_law_citations c
       WHERE ${effectiveIdentity}
         AND ${settledCitationSql(sql.raw("c.resolution_status"))}
    `),
  ).toEqual(["case_law_citations_identifier_backfill_match_key_idx"]);
});
