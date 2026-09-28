import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawSources } from "@/api/db/schema";
import { listDecisionsPageQuery } from "@/api/handlers/case-law/decisions/list";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { planLines } from "@/api/tests/helpers/explain-plan";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const DECISIONS = 5000;
const DB_TEST_TIMEOUT_MS = 120_000;
const sourceId = createSafeId<"caseLawSource">();

let client: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await db.insert(caseLawSources).values([
      caseLawSourceRow({
        adapterKey: "browse",
        id: sourceId,
        name: "browse",
      }),
    ]);
    await db.execute(sql`
      INSERT INTO case_law_decisions
        (id, source_id, case_number, citation_key, court, country, language,
         language_group_key, decision_date, created_at)
      SELECT gen_random_uuid(), ${sourceId}::uuid, i || ' Cdo ' || i || '/2020',
        i || 'cdo' || i || '/2020', 'Nejvyšší soud',
        CASE WHEN i % 4 = 0 THEN 'SVK' ELSE 'CZE' END, 'cs',
        CASE WHEN i % 4 = 1 THEN NULL ELSE 'group:' || (i / 3)::text END,
        DATE '2020-01-01' + (i % 97),
        TIMESTAMPTZ '2020-01-01' + (i || ' seconds')::interval
      FROM generate_series(1, ${DECISIONS}::int) AS i
    `);
    await db.execute(sql`ANALYZE case_law_decisions`);
    await db.execute(sql`ANALYZE case_law_sources`);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

test(
  "the decision list keeps its index path with grouped and ungrouped rows",
  async () => {
    const plans = await withPublicLawReaderRole(db, async (roleTx) => {
      // SAFETY: the role transaction supplies the select surface the read uses.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
      const tx = roleTx as unknown as CaseLawPublicReadTransaction;
      const query = listDecisionsPageQuery({
        query: { country: "CZE" },
        limit: 50,
        cursor: undefined,
        tx,
      });
      const natural = planLines(
        await roleTx.execute(sql`EXPLAIN (COSTS OFF) ${query.getSQL()}`),
      ).join("\n");
      const rows = await query;
      await roleTx.execute(sql`SET LOCAL enable_seqscan = off`);
      const forced = planLines(
        await roleTx.execute(sql`EXPLAIN (COSTS OFF) ${query.getSQL()}`),
      ).join("\n");
      return { natural, forced, rows };
    });

    const indexedDecisionScan =
      /Index Scan Backward using case_law_decisions_country_date_idx on case_law_decisions\n\s+Index Cond: \(\(country\)::text = 'CZE'::text\)/u;
    expect(plans.natural).toMatch(indexedDecisionScan);
    expect(plans.forced).toMatch(indexedDecisionScan);
    expect(plans.natural).toContain("Nested Loop Anti Join");
    expect(plans.rows.some((row) => row.languageGroupKey === null)).toBe(true);
    const groupKeys = plans.rows.flatMap((row) =>
      row.languageGroupKey === null ? [] : [row.languageGroupKey],
    );
    expect(new Set(groupKeys).size).toBe(groupKeys.length);
  },
  DB_TEST_TIMEOUT_MS,
);
