import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { inArray, sql } from "drizzle-orm";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { readCaseLawCoverageSourcesQuery } from "@/api/handlers/case-law/decisions/coverage";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { explainRoot } from "@/api/tests/query-plans/plan-walker";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const planNodes = (
  node: Record<string, unknown>,
): Record<string, unknown>[] => {
  const children = node["Plans"];
  if (children === undefined) {
    return [node];
  }
  if (!isUnknownArray(children) || !children.every(isRecord)) {
    return panic("The coverage plan has malformed children");
  }
  return [node, ...children.flatMap(planNodes)];
};

describe.skipIf(!enabled)("maintained coverage read plan (postgres)", () => {
  test.each([400, 4000])(
    "coverage never reads decisions at %i decisions per source",
    async (decisionsPerSource) => {
      const databaseUrl =
        process.env["DATABASE_URL"] ??
        panic("The enabled coverage plan test requires DATABASE_URL");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const captured: { query: string; params: unknown[] }[] = [];
        const { db, sql: client } = openClient({
          max: 1,
          logger: {
            logQuery: (query, params) => {
              captured.push({ query, params });
            },
          },
        });
        const sources = Array.from({ length: 3 }, () => {
          const id = createSafeId<"caseLawSource">();
          return {
            id,
            adapterKey: `coverage-plan-${id}`,
            name: "Coverage plan fixture",
          };
        });
        const sourceIds = sources.map(({ id }) => id);
        await db.insert(caseLawSources).values(sources);
        try {
          await db.execute(sql`INSERT INTO case_law_decisions
          (id, source_id, case_number, court, country, language, decision_date, fulltext)
          SELECT gen_random_uuid(), id, 'fixture/' || n, 'Court ' || (n % 30),
            'CZE', 'cs', DATE '2000-01-01', 'Fixture text'
          FROM case_law_sources CROSS JOIN generate_series(1, ${decisionsPerSource}) n
          WHERE id IN (${sql.join(
            sourceIds.slice(0, 2).map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`);
          // An empty maintained population must remain empty, without a corpus fallback.
          await db.insert(caseLawDecisions).values({
            id: createSafeId<"caseLawDecision">(),
            sourceId: sourceIds.at(2) ?? panic("Missing empty source"),
            caseNumber: "excluded",
            court: "Withdrawn court",
            country: "CZE",
            language: "cs",
            fulltext: null,
            redactedAt: new Date("2026-01-01T00:00:00Z"),
          });
          let seeded = false;
          while (!seeded) {
            // db-await-in-loop: finish production seed in bounded batches so coverage readiness proves the complete population.
            const batch = await db.execute(
              sql`SELECT * FROM public.seed_case_law_population_counts(2048)`,
            );
            seeded = batch.at(0)?.["done"] === true;
          }
          await db.execute(sql`ANALYZE case_law_population_counts`);
          captured.length = 0;
          const rows = await readCaseLawCoverageSourcesQuery(
            asTestRaw<CaseLawPublicReadTransaction>(db),
            [],
          );
          const statements = captured.slice();
          expect(statements.length).toBeGreaterThan(0);
          for (const statement of statements) {
            // db-await-in-loop: explain every actual bounded coverage-reader statement to reject a corpus fallback.
            const root = explainRoot(
              await client.unsafe(
                `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${statement.query}`,
                statement.params,
              ),
            );
            const evidence = JSON.stringify({
              query: statement.query,
              plan: root,
            });
            expect(
              planNodes(root).filter(
                (node) => node["Relation Name"] === "case_law_decisions",
              ),
              evidence,
            ).toEqual([]);
          }
          for (const [index, source] of sources.entries()) {
            const row =
              rows.find(({ id }) => id === source.id) ??
              panic("Coverage source was not returned");
            expect(row).toMatchObject({
              publishedDecisions: index === 2 ? 0 : decisionsPerSource,
              decisionYearFrom: index === 2 ? null : 2000,
              decisionYearTo: index === 2 ? null : 2000,
              pendingTextCount: 0,
            });
            expect(
              row.courts.reduce((total, court) => total + court.decisions, 0),
            ).toBe(index === 2 ? 0 : decisionsPerSource);
          }
        } finally {
          await db
            .delete(caseLawDecisions)
            .where(inArray(caseLawDecisions.sourceId, sourceIds));
          await db
            .delete(caseLawSources)
            .where(inArray(caseLawSources.id, sourceIds));
        }
      });
    },
    120_000,
  ); // timeout: two real PostgreSQL corpus shapes exercise production write triggers before plan inspection.
});
