import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { legislationWorkRepresentativesQuery } from "@/api/handlers/legislation/search";
import { createSafeId } from "@/api/lib/branded-types";
import {
  citedKeysQuery,
  ownNameVersionsQuery,
} from "@/api/lib/legal-search/legislation-work-names";
import type { LegislationReadTransaction } from "@/api/lib/legislation-public-read-db";
import { planLines } from "@/api/tests/helpers/explain-plan";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * The reads a legislation search adds per request stay on their indexes at a
 * corpus's shape: many versions per act, several names per version, and a
 * common name written beside thousands of citations.
 */

const WORKS = 4000;
const VERSIONS_PER_WORK = 8;
const CITING_ROWS = 6000;
const DB_TEST_TIMEOUT_MS = 180_000;
const sourceId = createSafeId<"legislationSource">();

let client: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await db
      .insert(legislationSources)
      .values({ id: sourceId, adapterKey: "plan", name: "plan" });
    await db.execute(sql`
      INSERT INTO legislation_documents
        (id, source_id, eli, title, country, language, version_valid_from,
         version_valid_to)
      SELECT gen_random_uuid(), ${sourceId}::uuid,
        'eli/cz/sb/' || (i / ${VERSIONS_PER_WORK}::int),
        (i / ${VERSIONS_PER_WORK}::int) || '/2000 Sb., o věci ' || (i / ${VERSIONS_PER_WORK}::int),
        CASE WHEN i % 5 = 0 THEN 'SVK' ELSE 'CZE' END, 'cs',
        DATE '2000-01-01' + (i % ${VERSIONS_PER_WORK}::int) * 365,
        CASE WHEN i % ${VERSIONS_PER_WORK}::int = ${VERSIONS_PER_WORK - 1}
          THEN NULL
          ELSE DATE '2000-01-01' + (i % ${VERSIONS_PER_WORK}::int + 1) * 365
        END
      FROM generate_series(0, ${WORKS * VERSIONS_PER_WORK - 1}::int) AS i
    `);
    // Per version: its official title, its own name and its citation.
    await db.execute(sql`
      INSERT INTO legislation_work_names
        (id, document_id, country, official_title, derived_name, derivation,
         cited_key, match_key)
      SELECT gen_random_uuid(), d.id, d.country, d.title, NULL, NULL, NULL,
        lower(d.title)
      FROM legislation_documents d
      UNION ALL
      SELECT gen_random_uuid(), d.id, d.country, NULL,
        'o věci ' || split_part(d.eli, '/', 4), 'derived_title_segment', NULL,
        'o věci ' || split_part(d.eli, '/', 4)
      FROM legislation_documents d
      UNION ALL
      SELECT gen_random_uuid(), d.id, d.country, NULL,
        split_part(d.eli, '/', 4) || '/2000 Sb.', 'derived_title_citation',
        NULL, split_part(d.eli, '/', 4) || ' 2000 sb'
      FROM legislation_documents d
    `);
    // One common name every amending title writes beside one act's citation.
    await db.execute(sql`
      INSERT INTO legislation_work_names
        (id, document_id, country, official_title, derived_name, derivation,
         cited_key, match_key)
      SELECT gen_random_uuid(), d.id, 'CZE', NULL, 'občanský zákoník',
        'derived_from_citation', '7 2000 sb', 'občanský zákoník'
      FROM (
        SELECT id FROM legislation_documents ORDER BY id LIMIT ${CITING_ROWS}
      ) AS d
    `);
    await db.execute(sql`ANALYZE legislation_documents`);
    await db.execute(sql`ANALYZE legislation_work_names`);
    await db.execute(sql`ANALYZE legislation_sources`);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

const explain = async (
  build: (tx: LegislationReadTransaction) => SQLWrapper,
): Promise<string> =>
  await withPublicLawReaderRole(db, async (roleTx) => {
    // SAFETY: the role transaction supplies the select surface the reads use.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
    const tx = roleTx as unknown as LegislationReadTransaction;
    return planLines(
      await roleTx.execute(sql`EXPLAIN (COSTS OFF) ${build(tx).getSQL()}`),
    ).join("\n");
  });

const NAME_INDEX_SCAN =
  /(?:Bitmap Index Scan on|Index (?:Only )?Scan using) legislation_work_names_match_key_idx\b/u;

test(
  "the name lookups seek the match-key index",
  async () => {
    const own = await explain((tx) =>
      ownNameVersionsQuery(tx, { matchKey: "o věci 42", country: "CZE" }),
    );
    const cited = await explain((tx) =>
      citedKeysQuery(tx, { matchKey: "občanský zákoník", country: "CZE" }),
    );
    const anyCountry = await explain((tx) =>
      ownNameVersionsQuery(tx, { matchKey: "o věci 42" }),
    );

    for (const plan of [own, cited, anyCountry]) {
      expect(plan).toMatch(NAME_INDEX_SCAN);
      expect(plan).not.toContain("Seq Scan on legislation_work_names");
    }
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the representative read seeks each act's versions by index",
  async () => {
    const works = Array.from({ length: 20 }, (_, index) => ({
      sourceId,
      eli: `eli/cz/sb/${String(index * 7)}`,
      language: "cs",
    }));
    const plan = await explain(() =>
      legislationWorkRepresentativesQuery({
        works,
        filters: [sql`${legislationDocuments.country} = 'CZE'`],
      }),
    );

    expect(plan).toMatch(
      /(?:Bitmap Index Scan on|Index (?:Only )?Scan using) legislation_documents_\w+/u,
    );
    expect(plan).not.toContain("Seq Scan on legislation_documents");
  },
  DB_TEST_TIMEOUT_MS,
);
