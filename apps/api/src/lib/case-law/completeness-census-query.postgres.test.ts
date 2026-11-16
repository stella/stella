import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { databaseRelations } from "@/api/db/database-relations";
import { createDatabase } from "@/api/db/sql-client";
import { loadAdapterByKey } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry-lazy";
import { createSafeId } from "@/api/lib/branded-types";
import {
  currentCensusSourceScopes,
  readCompletenessCensusQuery,
} from "@/api/lib/case-law/completeness-census";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { withMigratedRolePrivilegeCensus } from "@/api/tests/helpers/role-privilege-census-fixture";
import { capturedStatementQuery } from "@/api/tests/query-perf/statement-measurement";
import {
  explainRoot,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("census query plans", () => {
  // timeout: the fixture applies the complete migration chain to a fresh PostgreSQL cluster.
  test("each registered source retains an indexed range on a fresh census", async () => {
    await withMigratedRolePrivilegeCensus(async (client) => {
      const queries: { text: string; params: unknown[] }[] = [];
      const db = createDatabase({
        client,
        relations: databaseRelations,
        logger: {
          logQuery: (text, params) => {
            if (text.startsWith("select ")) {
              queries.push({ text, params });
            }
          },
        },
      });
      const sources = await currentCensusSourceScopes({
        sources: [
          ADAPTER_KEYS.CZ_NS,
          ADAPTER_KEYS.CZ_NSS,
          ADAPTER_KEYS.CZ_US,
          ADAPTER_KEYS.SK_COURTS,
          ADAPTER_KEYS.PL_COURTS,
          ADAPTER_KEYS.HU_BHGY,
        ].map((adapterKey) => ({
          id: createSafeId<"caseLawSource">(),
          adapterKey,
        })),
        now: new Date(Date.UTC(2026, 9, 31)),
        loadAdapter: loadAdapterByKey,
      });
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE stella`);
        expect(await readCompletenessCensusQuery(tx, sources)).toEqual(
          new Map(),
        );
        expect(queries).toHaveLength(3);
        for (const query of [...queries]) {
          // db-await-in-loop: inspect each of the three aggregate statements independently.
          const root = explainRoot(
            await tx.execute(
              sql`EXPLAIN (FORMAT JSON) ${capturedStatementQuery(query)}`,
            ),
          );
          const scans = scanOccurrences(root).filter(
            ({ relation }) => relation === "case_law_completeness_census",
          );
          expect(scans.length).toBeGreaterThan(0);
          expect(
            scans.every(({ nodeType }) => nodeType.includes("Index")),
          ).toBe(true);
        }
      });
    });
  }, 120_000);
});
