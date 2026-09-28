import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawSources } from "@/api/db/schema";
import { decisionIdsByIdentityQuery } from "@/api/handlers/case-law/decisions/search";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { planLines } from "@/api/tests/helpers/explain-plan";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/** Enough decisions that a scan of them all is not the cheapest plan. */
const DECISIONS = 5000;
/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

const sourceId = createSafeId<"caseLawSource">();

let client: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await db
      .insert(caseLawSources)
      .values([
        caseLawSourceRow({ adapterKey: "open", id: sourceId, name: "open" }),
      ]);
    await db.execute(sql`
      INSERT INTO case_law_decisions
        (id, source_id, case_number, citation_key, ecli, court, country, language)
      SELECT
        gen_random_uuid(), ${sourceId}::uuid, i || ' Cdo ' || i || '/2020',
        i || 'cdo' || i || '/2020', 'ECLI:CZ:NS:2020:' || i || '.CDO.' || i || '.2020.1',
        'Nejvyšší soud', 'CZE', 'cs'
      FROM generate_series(1, ${DECISIONS}::int) AS i
    `);
    await db.execute(sql`
      INSERT INTO case_law_decision_identifiers
        (decision_id, type, value, normalized_value)
      SELECT id, 'ecli', ecli, lower(regexp_replace(ecli, '[^A-Za-z0-9]', '', 'g'))
      FROM case_law_decisions
    `);
    await db.execute(sql`ANALYZE case_law_decisions`);
    await db.execute(sql`ANALYZE case_law_decision_identifiers`);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

test(
  "an ECLI reads both identity sources through their indexes",
  async () => {
    const plan = await withPublicLawReaderRole(db, async (roleTx) => {
      // SAFETY: the role transaction supplies the select surface the read uses.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
      const tx = roleTx as unknown as CaseLawPublicReadTransaction;
      const query = decisionIdsByIdentityQuery({
        country: "CZE",
        identity: {
          type: "identifier",
          kind: "ecli",
          jurisdiction: "CZE",
          value: "ECLI:CZ:NS:2020:42.CDO.42.2020.1",
        },
        tx,
      });
      return planLines(
        await roleTx.execute(sql`EXPLAIN (COSTS OFF) ${query.getSQL()}`),
      ).join("\n");
    });

    expect(plan).not.toContain("Seq Scan");
    expect(plan).toContain("case_law_decisions_ecli_idx");
    expect(plan).toContain("case_law_decision_identifiers_lookup_idx");
  },
  DB_TEST_TIMEOUT_MS,
);
