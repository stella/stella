import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { createTestPglite } from "@/api/tests/pglite-test-db";

import citationsBackfillMatchKey from "./online-migration-entries/indexes-case-law-citations-identifier-backfill-match-key-idx";
import citationsReopenableIdentifierMatchKey from "./online-migration-entries/indexes-case-law-citations-reopenable-identifier-match-key-idx";
import citationsReopenableMatchKey from "./online-migration-entries/indexes-case-law-citations-reopenable-match-key-idx";
import identifiersMatchKey from "./online-migration-entries/indexes-case-law-decision-identifiers-match-key-idx";
import decisionsMatchKey from "./online-migration-entries/indexes-case-law-decisions-citation-match-key-idx";
import decisionsPublishedMatchKey from "./online-migration-entries/indexes-case-law-decisions-citation-match-key-published-idx";

/**
 * The case-number match-key indexes are built in the online phase from their
 * entries' `createSql`, and declared in the schema for every other reader of
 * it. Each entry is proved here to build exactly the index the schema
 * declares, spelled as PostgreSQL renders it (`definitionBody`), so a query
 * built from `caseNumberMatchKeySql` meets the expression it indexes.
 */

const MIGRATION = "20261119215600_case_number_match_key_indexes";

let client: Awaited<ReturnType<typeof createTestPglite>>;

// timeout: booting the full PGlite schema can exceed the default hook budget.
beforeAll(
  async () => {
    client = await createTestPglite();
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

const indexDefinition = async (name: string) =>
  (
    await client.query<{ definition: string | null }>(
      "SELECT pg_get_indexdef(to_regclass($1)) AS definition",
      [name],
    )
  ).rows.at(0)?.definition;

const matchKeyIndexes = [
  identifiersMatchKey,
  decisionsMatchKey,
  decisionsPublishedMatchKey,
  citationsReopenableMatchKey,
  citationsReopenableIdentifierMatchKey,
  citationsBackfillMatchKey,
].flatMap((entry) => entry.values);

test("each online entry builds the match-key index the schema declares", async () => {
  expect(matchKeyIndexes.map(({ name }) => name).toSorted()).toEqual([
    "case_law_citations_identifier_backfill_match_key_idx",
    "case_law_citations_reopenable_identifier_match_key_idx",
    "case_law_citations_reopenable_match_key_idx",
    "case_law_decision_identifiers_match_key_idx",
    "case_law_decisions_citation_match_key_idx",
    "case_law_decisions_citation_match_key_published_idx",
  ]);
  const migration = readFileSync(
    nodePath.resolve(
      import.meta.dir,
      `../../drizzle/${MIGRATION}/migration.sql`,
    ),
    "utf-8",
  );
  for (const {
    name,
    introducedBy,
    createSql,
    definitionBody,
  } of matchKeyIndexes) {
    expect(introducedBy).toBe(MIGRATION);
    expect(migration).toContain(name);
    const expected = `CREATE INDEX ${name} ${definitionBody}`;
    // db-await-in-loop: six indexes, each read, dropped and rebuilt in order
    expect(await indexDefinition(name)).toBe(expected);
    // db-await-in-loop: rebuilt as the online phase builds it
    await client.query(`DROP INDEX "${name}"`);
    // db-await-in-loop: rebuilt as the online phase builds it
    await client.query(createSql);
    // db-await-in-loop: read back after the rebuild
    expect(await indexDefinition(name)).toBe(expected);
  }
});
