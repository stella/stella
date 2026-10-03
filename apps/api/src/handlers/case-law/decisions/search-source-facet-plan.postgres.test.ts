import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { DEFAULT_SEARCH_EXCERPT } from "@stll/api-contract/search";

import { caseLawSources } from "@/api/db/schema";
import { caseLawSearchPlan } from "@/api/handlers/case-law/decisions/search";
import { createSafeId } from "@/api/lib/branded-types";
import { DEFAULT_SEARCH_SORT } from "@/api/lib/legal-search/corpus-search-order";
import { LIMITS } from "@/api/lib/limits";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { explainRoot } from "@/api/tests/query-plans/plan-walker";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const SOURCES = 8;
const GROUPS = LIMITS.caseLawSourceFacetCountCap * 3;
const GROUP_INDEX = "case_law_decisions_lang_group_idx";
const TABLES = [
  "case_law_sources",
  "case_law_decisions",
  "case_law_search_documents",
] as const;

const childPlans = (node: Record<string, unknown>) => {
  const children = node["Plans"];
  if (children === undefined) {
    return [];
  }
  if (!isUnknownArray(children) || !children.every(isRecord)) {
    return panic("The source facet plan has malformed children");
  }
  return children;
};

const planNodes = (root: Record<string, unknown>) => {
  const nodes: Record<string, unknown>[] = [];
  const visit = (node: Record<string, unknown>) => {
    nodes.push(node);
    for (const child of childPlans(node)) {
      visit(child);
    }
  };
  visit(root);
  return nodes;
};

const assertBoundedSourceCounts = (root: Record<string, unknown>) => {
  const nodes = planNodes(root);
  // An outer bucket LIMIT cannot bound a global aggregate's input.
  const aggregates = nodes.filter((node) => node["Node Type"] === "Aggregate");
  expect(aggregates).toHaveLength(1);
  const aggregate = aggregates.at(0) ?? panic("The source count is absent");
  expect(aggregate["Actual Loops"]).toBe(SOURCES);
  const children = childPlans(aggregate);
  expect(children).toHaveLength(1);
  const limit = children.at(0) ?? panic("The source count has no input");
  expect(limit["Node Type"]).toBe("Limit");
  expect(limit["Actual Loops"]).toBe(SOURCES);
  expect(limit["Actual Rows"]).toBe(LIMITS.caseLawSourceFacetCountCap + 1);

  // A blocking full-match hash or sort beneath the Limit still visits every
  // match before returning the first bounded representative.
  for (const node of planNodes(limit)) {
    const blocking = ["Hash", "Sort", "Materialize", "Aggregate"].includes(
      String(node["Node Type"]),
    );
    if (!blocking) {
      continue;
    }
    const scansDecisions = planNodes(node).some(
      (descendant) => descendant["Relation Name"] === "case_law_decisions",
    );
    expect(scansDecisions).toBe(false);
  }
  expect(nodes.some((node) => node["Node Type"] === "CTE Scan")).toBe(false);

  const groupProbes = nodes.filter((node) => {
    const condition = node["Index Cond"];
    return (
      node["Index Name"] === GROUP_INDEX &&
      typeof condition === "string" &&
      condition.includes("language_group_key")
    );
  });
  expect(groupProbes.length).toBeGreaterThan(0);
  const probe =
    groupProbes.at(0) ?? panic("The indexed sibling probe is absent");
  expect(Number(probe["Actual Loops"])).toBeGreaterThanOrEqual(
    SOURCES * (LIMITS.caseLawSourceFacetCountCap + 1),
  );
};

describe.skipIf(!enabled)("bounded source facet plan (postgres)", () => {
  test("each source counts a capped input using indexed language siblings", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("The enabled PostgreSQL plan test requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const schemaName = `source_facet_plan_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const schema = sql.identifier(schemaName);
      await db.execute(sql`CREATE SCHEMA ${schema}`);
      try {
        for (const table of TABLES) {
          await db.execute(sql`CREATE TABLE ${schema}.${sql.identifier(table)}
            (LIKE public.${sql.identifier(table)} INCLUDING ALL)`);
        }
        await db.execute(sql`SET search_path TO ${schema}, public`);
        const indexes = await db.execute(sql`SELECT indexname FROM pg_indexes
          WHERE schemaname = ${schemaName} AND tablename = 'case_law_decisions'
            AND indexdef LIKE '%(language_group_key)%'`);
        expect(indexes).toHaveLength(1);
        const indexName = indexes.at(0)?.["indexname"];
        if (typeof indexName !== "string") {
          panic("The production language-group index was not cloned");
        }
        if (indexName !== GROUP_INDEX) {
          await db.execute(sql`ALTER INDEX ${schema}.${sql.identifier(indexName)}
            RENAME TO ${sql.identifier(GROUP_INDEX)}`);
        }
        const sourceIds = Array.from({ length: SOURCES }, () =>
          createSafeId<"caseLawSource">(),
        );
        await db.insert(caseLawSources).values(
          sourceIds.map((id) => ({
            id,
            adapterKey: `source-facet-plan-${id}`,
            name: "Source facet plan fixture",
          })),
        );
        // Shared group keys across sources force source-local collapse. Every
        // source has three times the count cap and two versions per group.
        // Search documents are decision-granular; repeated passage text must
        // not inflate the facet count.
        await db.execute(sql`INSERT INTO case_law_decisions
          (id, source_id, case_number, court, country, language,
           language_group_key, decision_date)
          SELECT gen_random_uuid(), sources.id, 'plan/' || groups.n,
            'Plan court', 'CZE', languages.language,
            'plan-group/' || groups.n, DATE '2020-01-01'
          FROM case_law_sources sources
          CROSS JOIN generate_series(1, ${GROUPS}) groups(n)
          CROSS JOIN (VALUES ('cs'), ('sk')) languages(language)`);
        await db.execute(sql`INSERT INTO case_law_search_documents
          (decision_id, searchable_text, language, regconfig, tsv)
          SELECT id, repeat('facetword ', 12), language, 'simple',
            to_tsvector('simple', repeat('facetword ', 12))
          FROM case_law_decisions`);
        await db.execute(sql`VACUUM (ANALYZE) case_law_decisions`);
        await db.execute(sql`VACUUM (ANALYZE) case_law_search_documents`);
        await db.execute(sql`ANALYZE case_law_sources`);

        const statement = caseLawSearchPlan({
          body: {
            country: "CZE",
            query: "facetword",
            sourceId: sourceIds.at(0),
          },
          configs: [
            {
              regconfig: "simple",
              languages: ["cs", "sk"],
              includeDefault: false,
              useUnaccent: false,
            },
          ],
          courtWeights: new Map(),
          excerpt: DEFAULT_SEARCH_EXCERPT,
          limit: 1,
          parsedCursor: null,
          queryUsed: "facetword",
          sort: DEFAULT_SEARCH_SORT,
        }).facets.source;
        const explained = await db.execute(
          sql`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${statement}`,
        );
        assertBoundedSourceCounts(explainRoot(explained));
        const rows = await db.execute(statement);
        expect(rows).toHaveLength(SOURCES);
        expect(new Set(rows.map((row) => row["value"]))).toEqual(
          new Set(sourceIds),
        );
        for (const row of rows) {
          expect(Number(row["count"])).toBe(
            LIMITS.caseLawSourceFacetCountCap + 1,
          );
        }
      } finally {
        await db.execute(sql`SET search_path TO public`);
        await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  }, 120_000);
});
