import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import {
  caseLawFilterMembershipQuery,
  readCaseLawFilterScope,
} from "@/api/lib/case-law/filter-country-scope";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";
import {
  accessPathViolations,
  explainRoot,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";

const sourceId = createSafeId<"caseLawSource">();
const missingSourceId = createSafeId<"caseLawSource">();
let client: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(caseLawSources).values(caseLawSourceRow({ id: sourceId }));
});

afterAll(async () => {
  await client.close();
});

test("decision type syntax validation requires no corpus read", async () => {
  const filters = { type: "foreign-type" };
  const read = await readCaseLawFilterScope({
    country: "CZE",
    filters,
    caseLawDb: asTestRaw(async () => {
      throw new Error("Unexpected corpus read");
    }),
  });
  expect(read).toEqual({ filters, removed: [] });
});

test("membership probes retain indexed plans without type indexes at N and 10N", async () => {
  let previousRows = 0;
  for (const rows of [1200, 12_000]) {
    await db.execute(sql`
      INSERT INTO case_law_decisions (id, source_id, case_number, country, court, language, metadata)
      SELECT gen_random_uuid(), ${sourceId}::uuid, i::text, 'CZE', 'Bulk court', 'cs', '{}'
      FROM generate_series(${previousRows + 1}::integer, ${rows}::integer) i
    `);
    previousRows = rows;
    await db.execute(sql`ANALYZE case_law_decisions`);
    for (const probe of [
      {
        field: "court",
        value: "Absent court",
        index: "case_law_decisions_court_idx",
      },
      {
        field: "lang",
        value: "zz",
        index: "case_law_decisions_provision_scope_cursor_idx",
      },
      {
        field: "sourceId",
        value: missingSourceId,
        index: "case_law_decisions_source_decision_date_coverage_idx",
      },
    ] as const) {
      await withPublicLawReaderRole(db, async (roleTx) => {
        const tx = asTestRaw<CaseLawPublicReadTransaction>(roleTx);
        const query = caseLawFilterMembershipQuery({
          tx,
          country: "CZE",
          ...probe,
        });
        const scans = scanOccurrences(
          explainRoot(
            await roleTx.execute(sql`EXPLAIN (FORMAT JSON) ${query}`),
          ),
        );
        const decisions = scans.filter(
          ({ relation }) => relation === "case_law_decisions",
        );
        expect(decisions).toHaveLength(1);
        expect(decisions.at(0)?.indexCond).not.toBeNull();
        const contract = [
          {
            relation: "case_law_decisions",
            occurrence: 0,
            nodeType: "Index Scan",
            index: probe.index,
          },
        ];
        expect(accessPathViolations(scans, contract, "point", false)).toEqual(
          [],
        );
        await roleTx.execute(sql`SET LOCAL enable_indexscan = off`);
        await roleTx.execute(sql`SET LOCAL enable_bitmapscan = off`);
        const mutated = scanOccurrences(
          explainRoot(
            await roleTx.execute(sql`EXPLAIN (FORMAT JSON) ${query}`),
          ),
        );
        expect(
          accessPathViolations(mutated, contract, "point", false).some(
            (violation) => violation.includes("Seq Scan on case_law_decisions"),
          ),
        ).toBe(true);
        expect(await query).toEqual([]);
      });
    }
  }
});
