import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import { PUBLIC_LAW_SHARED_QUERY } from "@/api/lib/public-law-shared-query";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";
import { ecliOrFixtureQuery } from "@/api/tests/query-plans/ecli-fixtures";
import {
  accessPathViolations,
  explainRoot,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";
import {
  PUBLIC_LAW_PLAN_DISPOSITION,
  QUERY_PLAN_REGISTRY,
} from "@/api/tests/query-plans/registry";
import { seedQueryPlanData } from "@/api/tests/query-plans/seed";

const DB_TEST_TIMEOUT_MS = 120_000;

let client: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await seedQueryPlanData(db);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

type PlanRole = (typeof QUERY_PLAN_REGISTRY)[number]["role"];

const explain = async (
  role: PlanRole,
  build: (tx: Transaction) => SQLWrapper,
  planMode?: "covering-index",
) => {
  const run = async (roleTx: Transaction) => {
    if (planMode === "covering-index") {
      await roleTx.execute(sql`SET LOCAL enable_seqscan = off`);
      await roleTx.execute(sql`SET LOCAL enable_bitmapscan = off`);
      await roleTx.execute(sql`SET LOCAL seq_page_cost = 1000`);
      await roleTx.execute(sql`SET LOCAL random_page_cost = 1000`);
    }
    const query = build(roleTx);
    const result = await roleTx.execute(
      sql`EXPLAIN (FORMAT JSON) ${query.getSQL()}`,
    );
    return scanOccurrences(explainRoot(result));
  };

  if (role === "root") {
    return await db.transaction(async (rootTx) => {
      // SAFETY: the PGlite transaction exposes the production root query surface.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test transaction stands in for the production root transaction
      const tx = rootTx as unknown as Transaction;
      return await run(tx);
    });
  }
  return await withPublicLawReaderRole(db, async (roleTx) => {
    // SAFETY: the role transaction exposes the production public-read select surface.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a production transaction
    const tx = roleTx as unknown as Transaction;
    return await run(tx);
  });
};

for (const entry of QUERY_PLAN_REGISTRY) {
  test(
    `${entry.id} checks its registered access path`,
    async () => {
      const scans = await explain(
        entry.role,
        entry.build,
        "planMode" in entry ? entry.planMode : undefined,
      );
      const violations = accessPathViolations(
        scans,
        entry.contract.scans,
        entry.class,
        "allowSeqScan" in entry.contract &&
          entry.contract.allowSeqScan === true,
      );
      switch (entry.status.type) {
        case "active":
          expect(violations).toEqual([]);
          break;
        case "known-violation": {
          const expectedViolation = entry.status.expectedViolation;
          expect(violations).toHaveLength(1);
          expect(violations[0]?.endsWith(expectedViolation)).toBe(true);
          break;
        }
      }
    },
    DB_TEST_TIMEOUT_MS,
  );
}

test(
  "the old ECLI OR shape fails while the UNION shape keeps both indexes",
  async () => {
    const oldScans = await explain("public-law-reader", ecliOrFixtureQuery);
    const oldViolations = accessPathViolations(oldScans, [], "point", false);
    expect(
      oldViolations.some((violation) =>
        violation.includes("OR with a subplan"),
      ),
    ).toBe(true);

    const union =
      QUERY_PLAN_REGISTRY.find(
        (entry) => entry.id === "case-law.ecli-identity",
      ) ?? panic("ECLI query is absent from the plan registry");
    const unionScans = await explain(union.role, union.build);
    expect(unionScans.some(({ nodeType }) => nodeType === "Seq Scan")).toBe(
      false,
    );
    const indexes = unionScans.map(({ index }) => index);
    expect(indexes).toContain("case_law_decisions_ecli_idx");
    expect(indexes).toContain("case_law_decision_identifiers_lookup_idx");
    expect(
      accessPathViolations(
        unionScans,
        union.contract.scans,
        union.class,
        false,
      ),
    ).toEqual([]);
  },
  DB_TEST_TIMEOUT_MS,
);

test("every shared public-law query has a registered or reasoned disposition", () => {
  const ids = Object.values(PUBLIC_LAW_SHARED_QUERY).toSorted();
  expect(Object.keys(PUBLIC_LAW_PLAN_DISPOSITION).toSorted()).toEqual(ids);
  for (const disposition of Object.values(PUBLIC_LAW_PLAN_DISPOSITION)) {
    switch (disposition.type) {
      case "registered":
        expect(
          QUERY_PLAN_REGISTRY.some(({ id }) => id === disposition.id),
        ).toBe(true);
        break;
      case "excluded":
        expect(disposition.reason.length).toBeGreaterThan(0);
        break;
    }
  }
});
