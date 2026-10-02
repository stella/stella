import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { legislationSources } from "@/api/db/schema";
import { buildListStatutesQuery } from "@/api/handlers/legislation/list";
import { createSafeId } from "@/api/lib/branded-types";
import type { LegislationReadTransaction } from "@/api/lib/legislation-public-read-db";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import {
  withGatedTestClients,
  type GatedTestDb,
} from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { explainRoot } from "@/api/tests/query-plans/plan-walker";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const WORKS = 500;
const SOURCES = 8;
const VERSIONS = 8;
const PAGE_SIZE = 100;
const WORK_INDEX = "legislation_documents_eli_version_lang_idx";
const TABLES = [
  "legislation_sources",
  "legislation_documents",
  "case_law_statute_citation_count_state",
  "case_law_statute_citation_counts",
  "case_law_sources",
] as const;

const planNodes = (root: Record<string, unknown>) => {
  const nodes: Record<string, unknown>[] = [];
  const visit = (node: Record<string, unknown>) => {
    nodes.push(node);
    const children = node["Plans"];
    if (children === undefined) {
      return;
    }
    if (!isUnknownArray(children) || !children.every(isRecord)) {
      panic("The list plan has malformed children");
    }
    for (const child of children) {
      visit(child);
    }
  };
  visit(root);
  return nodes;
};

const assertAmendmentProbe = (root: Record<string, unknown>) => {
  const counts = planNodes(root).filter((node) => {
    const output = node["Output"];
    return (
      node["Node Type"] === "Aggregate" &&
      isUnknownArray(output) &&
      output.some(
        (value) => typeof value === "string" && value.includes("count(*)"),
      )
    );
  });
  expect(counts).toHaveLength(1);
  const count =
    counts.at(0) ?? panic("The production amendment count is absent");
  const loops = count["Actual Loops"];
  if (typeof loops !== "number") {
    panic("The list plan needs ANALYZE loop counts");
  }
  expect(loops).toBe(PAGE_SIZE + 1);
  const scans = planNodes(count).filter(
    (node) => node["Relation Name"] === "legislation_documents",
  );
  expect(scans).toHaveLength(1);
  const scan = scans.at(0) ?? panic("The amendment count has no work scan");
  const indexes = planNodes(scan).filter(
    (node) => node["Index Name"] === WORK_INDEX,
  );
  expect(indexes).toHaveLength(1);
  const index =
    indexes.at(0) ?? panic("The amendment count has no canonical work index");
  if (index["Node Type"] === "Bitmap Index Scan") {
    expect(scan["Node Type"]).toBe("Bitmap Heap Scan");
  } else {
    expect(index["Node Type"]).toBe("Index Scan");
    expect(scan).toBe(index);
  }
  const condition = index["Index Cond"];
  if (typeof condition !== "string") {
    panic("The amendment count has no index condition");
  }
  for (const key of ["source_id", "eli", "language"]) {
    expect(condition).toContain(key);
  }
  expect(index["Actual Loops"]).toBe(PAGE_SIZE + 1);
  expect(index["Actual Rows"]).toBe(VERSIONS);
  expect(scan["Actual Loops"]).toBe(PAGE_SIZE + 1);
  expect(scan["Actual Rows"]).toBe(VERSIONS);
  expect(scan["Rows Removed by Filter"] ?? 0).toBe(0);
};

const assertListPage = async (
  db: GatedTestDb,
  query: { language: string; query?: string },
) => {
  const statement = buildListStatutesQuery(
    asTestRaw<LegislationReadTransaction>(db),
    {
      country: "CZE",
      query,
      limit: PAGE_SIZE,
      cursor: null,
      asOf: sql`DATE '2020-01-01'`,
    },
  );
  const explained = await db.execute(
    sql`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${statement.getSQL()}`,
  );
  assertAmendmentProbe(explainRoot(explained));
  const rows = await statement;
  expect(rows).toHaveLength(PAGE_SIZE + 1);
  for (const row of rows) {
    expect(row.amendmentCount).toBe(VERSIONS - 1);
  }
};

describe.skipIf(!enabled)("public list amendment probe (postgres)", () => {
  test("recent and search pages count only their exact indexed work ranges", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("The enabled PostgreSQL plan test requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const schemaName = `list_plan_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const schema = sql.identifier(schemaName);
      await db.execute(sql`CREATE SCHEMA ${schema}`);
      try {
        for (const table of TABLES) {
          await db.execute(sql`CREATE TABLE ${schema}.${sql.identifier(table)}
            (LIKE public.${sql.identifier(table)} INCLUDING ALL)`);
        }
        await db.execute(sql`SET search_path TO ${schema}, public`);
        // LIKE copies the production index definition but assigns a fixture name.
        const indexes = await db.execute(sql`SELECT indexname FROM pg_indexes
          WHERE schemaname = ${schemaName} AND tablename = 'legislation_documents'
            AND indexdef LIKE '%(source_id, eli, version_valid_from, language)%'`);
        expect(indexes).toHaveLength(1);
        const indexName = indexes.at(0)?.["indexname"];
        if (typeof indexName !== "string") {
          panic("The canonical unique work index was not cloned");
        }
        if (indexName !== WORK_INDEX) {
          await db.execute(sql`ALTER INDEX ${schema}.${sql.identifier(indexName)}
            RENAME TO ${sql.identifier(WORK_INDEX)}`);
        }
        const sourceIds = Array.from({ length: SOURCES }, () =>
          createSafeId<"legislationSource">(),
        );
        await db.insert(legislationSources).values(
          sourceIds.map((id) => ({
            id,
            adapterKey: `list-plan-${id}`,
            name: "List plan fixture",
          })),
        );
        // Native bulk insertion produces 64k actual rows. Eight sources share
        // every ELI and both languages, so a source filter cannot hide a broad
        // ELI-only scan. No planner switches or synthetic statistics.
        await db.execute(sql`INSERT INTO legislation_documents
          (id, source_id, eli, title, country, language, version_valid_from, version_valid_to)
          SELECT gen_random_uuid(), sources.id, 'eli/plan/' || works.n,
            'Act ' || works.n, 'CZE', languages.language,
            DATE '2010-01-01' + versions.n,
            CASE WHEN versions.n < ${VERSIONS - 1}
              THEN DATE '2010-01-01' + versions.n + 1 ELSE NULL END
          FROM legislation_sources sources
          CROSS JOIN generate_series(1, ${WORKS}) works(n)
          CROSS JOIN generate_series(0, ${VERSIONS - 1}) versions(n)
          CROSS JOIN (VALUES ('cs'), ('sk')) languages(language)`);
        await db.execute(sql`VACUUM (ANALYZE) legislation_documents`);
        await db.execute(sql`ANALYZE legislation_sources`);
        await assertListPage(db, { language: "cs" });
        await assertListPage(db, { language: "cs", query: "Act" });
      } finally {
        await db.execute(sql`SET search_path TO public`);
        await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  }, 120_000);
});
