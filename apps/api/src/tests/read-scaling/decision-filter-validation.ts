import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import validateDecisionFilters, {
  createDecisionFilterValidationRoute,
} from "@/api/handlers/case-law/decisions/filter-validation";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  caseLawPublishedDecisionsFixtureSql,
  caseLawUnredactedDecisionsFixtureSql,
} from "@/api/tests/helpers/case-law-publication-view-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type DecisionFilterValidationMeasurementOptions = {
  size: number;
  db: GatedTestDb;
};

export const decisionFilterValidationScalingScenario = {
  name: "public decision filter validation",
  definition: validateDecisionFilters,
  measure: async ({ size, db }: DecisionFilterValidationMeasurementOptions) => {
    for (const table of ["case_law_sources", "case_law_decisions"]) {
      await db.execute(sql`CREATE TEMP TABLE ${sql.identifier(table)} (
        LIKE public.${sql.identifier(table)} INCLUDING DEFAULTS
      )`);
    }
    await db.execute(caseLawPublishedDecisionsFixtureSql);
    await db.execute(caseLawUnredactedDecisionsFixtureSql);
    const sourceId = createSafeId<"caseLawSource">();
    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: "filter-validation-scaling",
      name: "Filter validation fixture",
      descriptor: {
        license: "public-domain",
        attribution: null,
        allowsRedistribution: true,
        allowsDerivedAi: true,
      },
    });
    await db.insert(caseLawDecisions).values(
      Array.from({ length: size }, (_, index) => ({
        id: createSafeId<"caseLawDecision">(),
        sourceId,
        caseNumber: `Filter validation ${index}`,
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        decisionDate: "2026-01-01",
        fulltext: "Published decision",
        metadata: {},
      })),
    );
    const caseLawDb = asTestRaw<CaseLawPublicReadDb>(
      async <T>(
        read: (tx: CaseLawPublicReadTransaction) => Promise<T>,
        options?: Parameters<CaseLawPublicReadDb>[1],
      ): Promise<T> =>
        await db.transaction(async (tx) => await read(tx), {
          isolationLevel:
            options?.isolation === "repeatable-read"
              ? "repeatable read"
              : "read committed",
        }),
    );
    const route = createDecisionFilterValidationRoute(caseLawDb);
    return await runWithMeasuredQueryCounter(async (counter) => {
      const response = await route.handler(
        asTestRaw<Parameters<typeof route.handler>[0]>({
          query: {
            country: "CZE",
            court: "Nejvyšší soud",
            lang: "cs",
            sourceId,
          },
          request: new Request(
            "https://example.test/v1/case/decisions/filter-validation",
          ),
          route: "/v1/case/decisions/filter-validation",
          set: { headers: {} },
        }),
      );
      if (response instanceof HttpStatusResponse) {
        panic("Filter validation scaling requires a successful response");
      }
      if (
        response.filters.court !== "Nejvyšší soud" ||
        response.filters.lang !== "cs" ||
        response.filters.sourceId !== sourceId
      ) {
        panic("Filter validation scaling requires published memberships");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: 1,
      };
    });
  },
};
