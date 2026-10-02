import { panic } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawSources } from "@/api/db/schema";
import {
  explainSourceStoredTotalQuery,
  sourceStoredTotalRefreshClaim,
} from "@/api/handlers/case-law/ingestion/source-totals";
import { createSafeId } from "@/api/lib/branded-types";
import { isRecord } from "@/api/lib/type-guards";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  explainRoot,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const assertNotExecuted = (node: Record<string, unknown>) => {
  expect(node["Actual Rows"]).toBeUndefined();
  expect(node["Actual Total Time"]).toBeUndefined();
  const children = node["Plans"];
  if (children === undefined) {
    return;
  }
  if (!Array.isArray(children) || !children.every(isRecord)) {
    panic("Malformed estimate child plans");
  }
  for (const child of children) {
    assertNotExecuted(child);
  }
};

describe.skipIf(!enabled || databaseUrl === undefined)(
  "stored total planning on PostgreSQL 18",
  () => {
    if (databaseUrl === undefined) {
      return;
    }
    const fixture = openGatedTestDatabase(databaseUrl, { max: 1 });
    const { db } = fixture;
    const schema = `source_total_plan_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    const first = createSafeId<"caseLawSource">();
    const second = createSafeId<"caseLawSource">();
    fixture.cleanUp(async () => {
      await db.execute(sql.raw(`DROP SCHEMA ${schema} CASCADE`));
    });
    beforeAll(async () => {
      const version = (
        await db.execute(
          sql`SELECT current_setting('server_version_num')::int AS version`,
        )
      ).at(0)?.["version"];
      expect(version).toBeGreaterThanOrEqual(180_000);
      expect(version).toBeLessThan(190_000);
      await db.execute(sql.raw(`CREATE SCHEMA ${schema}`));
      await db.execute(
        sql.raw(
          `CREATE TABLE ${schema}.case_law_sources (LIKE public.case_law_sources INCLUDING ALL)`,
        ),
      );
      await db.execute(
        sql.raw(
          `CREATE TABLE ${schema}.case_law_decisions (LIKE public.case_law_decisions INCLUDING ALL)`,
        ),
      );
      await db.execute(sql.raw(`SET search_path TO ${schema}, public`));
      await db.insert(caseLawSources).values([
        {
          id: first,
          adapterKey: `plan-${first}`,
          name: "First planner source",
          storedTotalNextRefreshAt: new Date("2026-10-03T12:00:00Z"),
        },
        {
          id: second,
          adapterKey: `plan-${second}`,
          name: "Second planner source",
        },
        ...Array.from({ length: 1000 }, (_, index) => ({
          adapterKey: `plan-other-${index}`,
          name: "Other planner source",
        })),
      ]);
      await db.execute(sql`INSERT INTO case_law_decisions (case_number, country, court, language, source_id)
      SELECT id::text, 'CZE', 'Court', 'cs', CASE WHEN id <= 700 THEN ${first}::uuid ELSE ${second}::uuid END
      FROM generate_series(1, 1000) id`);
      await db.execute(sql`ANALYZE case_law_sources`);
      await db.execute(sql`ANALYZE case_law_decisions`);
    });

    test("the production estimate is source-specific and never executes its planned scan", async () => {
      const large = explainRoot(
        await db.execute(explainSourceStoredTotalQuery(first)),
      );
      const small = explainRoot(
        await db.execute(explainSourceStoredTotalQuery(second)),
      );
      assertNotExecuted(large);
      assertNotExecuted(small);
      expect(large["Node Type"]).not.toBe("Aggregate");
      expect(large["Plan Rows"]).toBeGreaterThan(600);
      expect(large["Plan Rows"]).toBeLessThan(800);
      expect(small["Plan Rows"]).toBeGreaterThan(200);
      expect(small["Plan Rows"]).toBeLessThan(400);
    });

    test("the production refresh claim uses the source primary key with one bounded row", async () => {
      await db.transaction(async (actualTx) => {
        const tx = asTestRaw<Transaction>(actualTx);
        const query = sourceStoredTotalRefreshClaim({
          tx,
          sourceId: first,
          now: new Date("2026-10-03T12:00:00Z"),
        });
        const root = explainRoot(
          await actualTx.execute(sql`EXPLAIN (FORMAT JSON) ${query.getSQL()}`),
        );
        assertNotExecuted(root);
        const scans = scanOccurrences(root);
        const sourceScan = scans.find(
          ({ relation }) => relation === "case_law_sources",
        );
        expect(sourceScan).toBeDefined();
        expect(sourceScan?.nodeType).toBe("Index Scan");
        expect(sourceScan?.index).toContain("pkey");
        expect(sourceScan?.rows).toBeLessThanOrEqual(1);
        expect(root["Total Cost"]).toBeLessThan(100);
      });
    });

    test("synthetic corpus scale changes estimates without executing corpus work", async () => {
      // Only this isolated fixture's catalog estimate changes; the physical rows stay at 1000.
      await db.execute(
        sql`UPDATE pg_class SET reltuples = 1000000 WHERE oid = 'case_law_decisions'::regclass`,
      );
      const firstPlan = explainRoot(
        await db.execute(explainSourceStoredTotalQuery(first)),
      );
      const secondPlan = explainRoot(
        await db.execute(explainSourceStoredTotalQuery(second)),
      );
      assertNotExecuted(firstPlan);
      assertNotExecuted(secondPlan);
      expect(firstPlan["Plan Rows"]).toBeGreaterThan(600_000);
      expect(firstPlan["Plan Rows"]).toBeLessThan(800_000);
      expect(secondPlan["Plan Rows"]).toBeGreaterThan(200_000);
      expect(secondPlan["Plan Rows"]).toBeLessThan(400_000);
    });
  },
);
