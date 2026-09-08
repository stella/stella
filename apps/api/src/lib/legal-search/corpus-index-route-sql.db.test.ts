import { afterAll, beforeAll, expect, test } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { executedRows } from "@/api/lib/db/executed-rows";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexIdFromManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { corpusIndexIdSqlFromManifest } from "@/api/lib/legal-search/corpus-index-route-sql";
import { isRecord } from "@/api/lib/type-guards";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * A manifest's route is rendered twice: `corpusIndexIdFromManifest` in
 * TypeScript, which the projection writer derives `desired_index_id` from,
 * and `corpusIndexIdSqlFromManifest` in the queries that decide whether a
 * generation holds a row. Both are proved equal here against a real
 * PostgreSQL, for every declared manifest and every jurisdiction its route
 * mentions, in both letter cases. A route rule changed on one side alone
 * fails this test rather than silently dropping every hit of that
 * generation.
 */

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const DB_TEST_TIMEOUT_MS = 120_000;

/** Jurisdictions the manifest's route decides an index for. */
const routedJurisdictions = (
  manifest: (typeof CORPUS_INDEX_MANIFESTS)[keyof typeof CORPUS_INDEX_MANIFESTS],
): readonly string[] => {
  const declared =
    manifest.route.type === "case_law_group"
      ? Object.keys(manifest.route.byJurisdiction)
      : // The legislation route is open by design: a jurisdiction needs no
        // manifest entry, so the ones a corpus exists for stand for all.
        ["CZE", "SVK", "POL", "EU"];
  return [...declared, ...declared.map((value) => value.toLowerCase())];
};

const readIndexId = async (expression: SQL) => {
  const row = executedRows(
    await db.execute(sql`SELECT (${expression}) AS "index_id"`),
  ).at(0);
  return isRecord(row) ? row["index_id"] : undefined;
};

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

test(
  "both renderings of a manifest route derive the same physical index id",
  async () => {
    for (const manifest of Object.values(CORPUS_INDEX_MANIFESTS)) {
      for (const jurisdiction of routedJurisdictions(manifest)) {
        expect(
          await readIndexId(
            corpusIndexIdSqlFromManifest(manifest, sql`${jurisdiction}`),
          ),
        ).toBe(corpusIndexIdFromManifest(manifest, jurisdiction));
      }
    }
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);
