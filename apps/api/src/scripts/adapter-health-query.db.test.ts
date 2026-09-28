import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSearchDocuments,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { isRecord } from "@/api/lib/type-guards";
import {
  adapterHealthPageStatement,
  readAdapterHealthMetrics,
} from "@/api/scripts/adapter-health-query";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const DB_TEST_TIMEOUT_MS = 120_000;
const sourceId = createSafeId<"caseLawSource">();
const otherSourceId = createSafeId<"caseLawSource">();
const firstId = createSafeId<"caseLawDecision">();
const secondId = createSafeId<"caseLawDecision">();
const thirdId = createSafeId<"caseLawDecision">();
const otherId = createSafeId<"caseLawDecision">();
const sinceDate = new Date("2026-09-27T00:00:00.000Z");

let client: PGlite;
let db: ReturnType<typeof drizzle>;
type MetricsDb = Parameters<typeof readAdapterHealthMetrics>[0]["db"];
let metricsDb: MetricsDb;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  // SAFETY: the embedded database has the same transaction/execute surface.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite stands in for the root pool
  metricsDb = db as unknown as MetricsDb;
  await db.insert(caseLawSources).values([
    caseLawSourceRow({ id: sourceId, adapterKey: "adapter-health-page" }),
    caseLawSourceRow({
      id: otherSourceId,
      adapterKey: "adapter-health-other",
    }),
  ]);
  await db.insert(caseLawDecisions).values([
    {
      id: firstId,
      sourceId,
      caseNumber: "first",
      court: "Court",
      country: "CZE",
      language: "cs",
      createdAt: new Date("2026-09-26T00:00:00.000Z"),
      ecli: "ECLI:CZ:TEST:2026:1",
      fulltext: "text",
    },
    {
      id: secondId,
      sourceId,
      caseNumber: "second",
      court: "Court",
      country: "CZE",
      language: "cs",
      createdAt: new Date("2026-09-28T00:00:00.000Z"),
    },
    {
      id: thirdId,
      sourceId,
      caseNumber: "third",
      court: "Court",
      country: "CZE",
      language: "cs",
      createdAt: new Date("2026-09-28T01:00:00.000Z"),
    },
    {
      id: otherId,
      sourceId: otherSourceId,
      caseNumber: "other",
      court: "Court",
      country: "CZE",
      language: "cs",
      createdAt: new Date("2026-09-28T01:00:00.000Z"),
    },
  ]);
  await db.insert(caseLawSearchDocuments).values({ decisionId: firstId });
  await db.insert(caseLawCitations).values([
    {
      id: createSafeId<"caseLawCitation">(),
      citingDecisionId: firstId,
      citedDecisionId: secondId,
      citationText: "second",
    },
    {
      id: createSafeId<"caseLawCitation">(),
      citingDecisionId: firstId,
      citationText: "unresolved",
    },
    {
      id: createSafeId<"caseLawCitation">(),
      citingDecisionId: secondId,
      citedDecisionId: thirdId,
      citationText: "third",
    },
  ]);
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

test(
  "source pages keep metrics exact across page boundaries and other sources",
  async () => {
    const metrics = await readAdapterHealthMetrics({
      db: metricsDb,
      sourceId,
      sinceDate,
      pageSize: 2,
    });
    expect(metrics).toMatchObject({
      total: 3,
      inserted: 2,
      indexed: 1,
      citationTotal: 3,
      citationResolved: 2,
    });
    expect(metrics.fields.get("ecli")).toBe(1);
    expect(metrics.fields.get("fulltext")).toBe(1);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the page and both lateral lookups use their key indexes",
  async () => {
    await client.query("VACUUM ANALYZE case_law_decisions");
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
      const explained = await tx.execute(
        sql`EXPLAIN (COSTS OFF) ${adapterHealthPageStatement({
          sourceId,
          sinceDate,
          afterId: null,
          limit: 2,
        })}`,
      );
      const rows = isRecord(explained) ? explained["rows"] : explained;
      if (!Array.isArray(rows)) {
        return panic("EXPLAIN returned no rows array.");
      }
      return rows.map((row) => {
        const line = isRecord(row) ? row["QUERY PLAN"] : undefined;
        return typeof line === "string"
          ? line
          : panic("EXPLAIN row has no plan text.");
      });
    });
    const text = plan.join("\n");
    expect(text).toContain("case_law_decisions_source_id_page_idx");
    expect(text).toContain("case_law_search_documents_pkey");
    expect(text).toContain("case_law_citations_citing_page_idx");
  },
  DB_TEST_TIMEOUT_MS,
);
