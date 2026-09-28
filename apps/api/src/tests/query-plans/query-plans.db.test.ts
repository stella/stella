import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import { executedRows } from "@/api/lib/db/executed-rows";
import { PUBLIC_LAW_SHARED_QUERY } from "@/api/lib/public-law-shared-query";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";
import planContracts from "@/api/tests/query-plans/contracts.json" with { type: "json" };
import { ecliOrFixtureQuery } from "@/api/tests/query-plans/ecli-fixtures";
import {
  accessPathViolations,
  explainRoot,
  scanOccurrences,
  withoutAuthorizationSubplans,
} from "@/api/tests/query-plans/plan-walker";
import type {
  AccessPath,
  ScanOccurrence,
} from "@/api/tests/query-plans/plan-walker";
import {
  PUBLIC_LAW_PLAN_DISPOSITION,
  QUERY_PLAN_REGISTRY,
} from "@/api/tests/query-plans/registry";
import {
  estimateHeapFetches,
  injectScaleProfile,
  SYNTHETIC_SCALE_PROFILE,
} from "@/api/tests/query-plans/scale-profile";
import type { ScaleProfile } from "@/api/tests/query-plans/scale-profile";
import {
  QUERY_PLAN_ROW_COUNT,
  seedQueryPlanData,
} from "@/api/tests/query-plans/seed";

import { PLAN_GUARD_TABLES } from "../../db/plan-guard-tables";

const DB_TEST_TIMEOUT_MS = 120_000;
const UPDATE_PLAN_CONTRACTS =
  process.env["STELLA_UPDATE_PLAN_CONTRACTS"] === "1";
const guardedTables = new Set<string>(PLAN_GUARD_TABLES);
const observedContracts: Record<string, { scans: AccessPath[] }> = {};
const scanReport: string[] = [];

const observedPaths = (scans: readonly ScanOccurrence[]): AccessPath[] =>
  scans
    .filter(({ relation }) => guardedTables.has(relation))
    .map(({ position, relation, nodeType, index }) => ({
      position,
      relation,
      nodeType,
      index,
    }));

const assertPlan = (
  violations: readonly string[],
  scans: readonly ScanOccurrence[],
) => {
  if (violations.length > 0) {
    panic(
      `${violations.join("\n")}\nObserved scans (estimated rows):\n${JSON.stringify(scans, null, 2)}`,
    );
  }
};

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
  process.stdout.write(
    "\nQuery-plan scan estimates (synthetic stats; heap-fetch upper bound per loop):\n" +
      `query | position | relation | scan | index | rows | heap-fetch upper bound per loop | query matches contract\n${scanReport.join(
        "\n",
      )}\n`,
  );
  if (UPDATE_PLAN_CONTRACTS) {
    if (Object.keys(observedContracts).length !== QUERY_PLAN_REGISTRY.length) {
      panic("Plan contract update did not observe every registry entry");
    }
    await Bun.write(
      new URL("contracts.json", import.meta.url),
      `${JSON.stringify(observedContracts, null, 2)}\n`,
    );
  }
  await client.close();
});

type PlanRole = (typeof QUERY_PLAN_REGISTRY)[number]["role"];

const explainOn =
  (database: ReturnType<typeof drizzle>) =>
  async (
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
      return await database.transaction(async (rootTx) => {
        // SAFETY: the PGlite transaction exposes the production root query surface.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test transaction stands in for the production root transaction
        const tx = rootTx as unknown as Transaction;
        return await run(tx);
      });
    }
    return await withPublicLawReaderRole(database, async (roleTx) => {
      // SAFETY: the role transaction exposes the production public-read select surface.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a production transaction
      const tx = roleTx as unknown as Transaction;
      return await run(tx);
    });
  };

const explainPhysical = async (
  role: PlanRole,
  build: (tx: Transaction) => SQLWrapper,
  planMode?: "covering-index",
) => await explainOn(db)(role, build, planMode);

test("every guarded table has the physical seed before statistics injection", async () => {
  for (const table of PLAN_GUARD_TABLES) {
    const row = executedRows(
      await db.execute(sql`
        SELECT count(*)::integer AS count FROM ${sql.identifier(table)}
      `),
    ).at(0);
    expect(row).toMatchObject({ count: QUERY_PLAN_ROW_COUNT });
  }
});

for (const entry of QUERY_PLAN_REGISTRY) {
  test(
    `${entry.id} checks its registered access path`,
    async () => {
      const scans = await explainPhysical(
        entry.role,
        entry.build,
        "planMode" in entry ? entry.planMode : undefined,
      );
      const guardedScans = observedPaths(scans);
      if (guardedScans.length === 0) {
        panic(
          `${entry.id} has no guarded scan: ${JSON.stringify(scans, null, 2)}`,
        );
      }
      if (UPDATE_PLAN_CONTRACTS) {
        observedContracts[entry.id] = { scans: guardedScans };
      }
      const violations = accessPathViolations(
        scans,
        UPDATE_PLAN_CONTRACTS ? guardedScans : entry.contract.scans,
        entry.class,
        "allowSeqScan" in entry.contract &&
          entry.contract.allowSeqScan === true,
      );
      assertPlan(violations, scans);
    },
    DB_TEST_TIMEOUT_MS,
  );
}

test(
  "the old ECLI OR shape fails while the UNION shape keeps both indexes",
  async () => {
    const oldScans = await explainPhysical(
      "public-law-reader",
      ecliOrFixtureQuery,
    );
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
    const unionScans = await explainPhysical(union.role, union.build);
    expect(unionScans.some(({ nodeType }) => nodeType === "Seq Scan")).toBe(
      false,
    );
    const indexes = unionScans.map(({ index }) => index);
    expect(indexes).toContain("case_law_decisions_ecli_idx");
    expect(indexes).toContain("case_law_decision_identifiers_lookup_idx");
    assertPlan(
      accessPathViolations(
        unionScans,
        UPDATE_PLAN_CONTRACTS
          ? observedPaths(unionScans)
          : union.contract.scans,
        union.class,
        false,
      ),
      unionScans,
    );
  },
  DB_TEST_TIMEOUT_MS,
);

test("every shared public-law query has a registered or reasoned disposition", () => {
  expect(Object.keys(planContracts).toSorted()).toEqual(
    QUERY_PLAN_REGISTRY.map(({ id }) => id).toSorted(),
  );
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

test("recognizes the workspace RLS subplan in its real role", async () => {
  const plan = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE stella`);
    await tx.execute(sql`SELECT set_config('app.workspace_ids', '{}', true)`);
    await tx.execute(
      sql`SELECT set_config('app.workspace_access_mode', 'membership', true)`,
    );
    const result = await tx.execute(
      sql`EXPLAIN (FORMAT JSON) SELECT id FROM entities WHERE workspace_id = '00000000-0000-7000-8000-000000000001'::uuid`,
    );
    return explainRoot(result);
  });
  const scan =
    scanOccurrences(plan).at(0) ?? panic("Workspace RLS plan has no scan");
  expect(scan.relation).toBe("entities");
  expect(scan.filter).toContain("SubPlan");
  expect(scan.subplans.some(({ relations }) => relations.includes("aw"))).toBe(
    true,
  );
  expect(withoutAuthorizationSubplans(scan)).not.toContain("SubPlan");
  if (UPDATE_PLAN_CONTRACTS) {
    await Bun.write(
      new URL("workspace-rls-plan.fixture.json", import.meta.url),
      `${JSON.stringify(plan, null, 2)}\n`,
    );
  }
});

const reportRegistryScans = async (profile: ScaleProfile) => {
  const reportClient = await createTestPglite();
  try {
    const reportDb = drizzle({ client: reportClient });
    await seedQueryPlanData(reportDb);
    await injectScaleProfile(reportDb, profile);
    for (const entry of QUERY_PLAN_REGISTRY) {
      const scans = await explainOn(reportDb)(
        entry.role,
        entry.build,
        "planMode" in entry ? entry.planMode : undefined,
      );
      const matchesContract =
        accessPathViolations(
          scans,
          entry.contract.scans,
          entry.class,
          "allowSeqScan" in entry.contract &&
            entry.contract.allowSeqScan === true,
        ).length === 0;
      for (const scan of scans) {
        if (!guardedTables.has(scan.relation)) {
          continue;
        }
        scanReport.push(
          [
            entry.id,
            scan.position,
            scan.relation,
            scan.nodeType,
            scan.index ?? "none",
            scan.rows ?? "unknown",
            estimateHeapFetches(scan, profile) ?? "n/a",
            matchesContract ? "yes" : "no",
          ].join(" | "),
        );
      }
    }
  } finally {
    await reportClient.close();
  }
};

test(
  "reports registry scan estimates",
  async () => {
    await reportRegistryScans(SYNTHETIC_SCALE_PROFILE);
    expect(scanReport.length).toBeGreaterThanOrEqual(
      QUERY_PLAN_REGISTRY.length,
    );
  },
  DB_TEST_TIMEOUT_MS,
);
