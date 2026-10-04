import { panic } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawSources } from "@/api/db/schema";
import {
  sourceStoredTotalCountQuery,
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
    panic("Malformed count child plans");
  }
  for (const child of children) {
    assertNotExecuted(child);
  }
};

describe.skipIf(!enabled)("stored total planning on PostgreSQL 18", () => {
  if (databaseUrl === undefined) {
    if (enabled) {
      panic(
        "DATABASE_URL required for PostgreSQL stored-total planner regression",
      );
    }
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
    const attemptColumn =
      await db.execute(sql`SELECT 1 FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = 'case_law_sources'
        AND column_name = ${caseLawSources.storedTotalAttemptedAt.name}`);
    if (attemptColumn.length === 0) {
      // The owning migration names an unqualified table, so this fixture's path owns the change.
      const migration = await Bun.file(
        new URL(
          "../../../../drizzle/20261003123500_case_law_source_stored_total_attempt/migration.sql",
          import.meta.url,
        ),
      ).text();
      await db.transaction(async (tx) => {
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim().length > 0) {
            // db-await-in-loop: preserve the exact migration's ordered column and privilege changes.
            await tx.execute(sql.raw(statement));
          }
        }
      });
    }
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
    await db.execute(sql`INSERT INTO case_law_decisions (id, case_number, country, court, language, source_id)
      SELECT uuidv7(), id::text, 'CZE', 'Court', 'cs', CASE WHEN id <= 700 THEN ${first}::uuid ELSE ${second}::uuid END
      FROM generate_series(1, 1000) id`);
    await db.execute(sql`ANALYZE case_law_sources`);
    await db.execute(sql`ANALYZE case_law_decisions`);
  });

  test("the production exact count sees source-specific rows including an empty source", async () => {
    const large = await db.execute(sourceStoredTotalCountQuery(first));
    const small = await db.execute(sourceStoredTotalCountQuery(second));
    const empty = await db.execute(
      sourceStoredTotalCountQuery(createSafeId<"caseLawSource">()),
    );
    expect(large.at(0)?.["total"]).toBe(700);
    expect(small.at(0)?.["total"]).toBe(300);
    expect(empty.at(0)?.["total"]).toBe(0);
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
        ({ relation, alias }) =>
          relation === "case_law_sources" && alias === "case_law_sources",
      );
      // The spacing InitPlan reads the same table under the distinct recent alias.
      expect(
        scans.some(
          ({ relation, alias }) =>
            relation === "case_law_sources" && alias === "recent",
        ),
      ).toBe(true);
      expect(sourceScan).toBeDefined();
      expect(sourceScan?.nodeType).toBe("Index Scan");
      expect(sourceScan?.index).toContain("pkey");
      expect(sourceScan?.rows).toBeLessThanOrEqual(1);
      expect(root["Total Cost"]).toBeLessThan(100);
    });
  });

  test("the admitted exact count uses a bounded index-only source scan at synthetic scale", async () => {
    await db.execute(sql`VACUUM (ANALYZE) case_law_decisions`);
    await db.execute(
      sql`UPDATE pg_class SET reltuples = 1000000 WHERE oid = 'case_law_decisions'::regclass`,
    );
    const root = explainRoot(
      await db.execute(
        sql`EXPLAIN (FORMAT JSON) ${sourceStoredTotalCountQuery(second)}`,
      ),
    );
    assertNotExecuted(root);
    expect(root["Node Type"]).toBe("Aggregate");
    expect(root["Total Cost"]).toBeLessThan(50_000);
    const corpus = scanOccurrences(root).filter(
      ({ relation }) => relation === "case_law_decisions",
    );
    expect(corpus).toHaveLength(1);
    expect(corpus.at(0)?.nodeType).toBe("Index Only Scan");
    expect(corpus.at(0)?.indexCond).toContain("source_id");
    expect(corpus.at(0)?.index).toBeDefined();
    expect(corpus.at(0)?.rows).toBeGreaterThan(200_000);
    expect(corpus.at(0)?.rows).toBeLessThan(400_000);
  });
});
