import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import readDecisionSummary, {
  type createReadDecisionSummaryHandler,
} from "@/api/handlers/case-law/decisions/summary/get";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { resetPublicCaseLawConfigForTesting } from "@/api/lib/case-law/public-case-law-config";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  caseLawPublishedDecisionsFixtureSql,
  caseLawUnredactedDecisionsFixtureSql,
} from "@/api/tests/helpers/case-law-publication-view-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type DecisionSummaryMeasurementOptions = {
  size: number;
  db: GatedTestDb;
  createHandler: typeof createReadDecisionSummaryHandler;
};

export const decisionSummaryScalingScenario = {
  name: "public decision summary",
  definition: readDecisionSummary,
  measure: async ({
    size,
    db,
    createHandler,
  }: DecisionSummaryMeasurementOptions) => {
    // Temp relations shadow only this connection; schema/defaults and both
    // publication views come from their production owners.
    for (const table of [
      "case_law_sources",
      "case_law_decisions",
      "case_law_decision_identifiers",
      "case_law_court_weights",
    ]) {
      await db.execute(sql`CREATE TEMP TABLE ${sql.identifier(table)} (
        LIKE public.${sql.identifier(table)} INCLUDING DEFAULTS
      )`);
    }
    await db.execute(caseLawPublishedDecisionsFixtureSql);
    await db.execute(caseLawUnredactedDecisionsFixtureSql);
    const sourceId = createSafeId<"caseLawSource">();
    const decisions = Array.from({ length: size }, (_, index) => ({
      id: createSafeId<"caseLawDecision">(),
      sourceId,
      caseNumber: `Summary ${index}`,
      court: "Nejvyšší soud",
      country: "CZE",
      language: "cs",
      decisionDate: "2026-01-01",
      fulltext: "Document body ".repeat(size * 4),
      metadata: { keywords: ["Summary keyword"] },
    }));
    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: "summary-scaling",
      name: "Summary fixture",
      descriptor: {
        license: "public-domain",
        attribution: null,
        allowsRedistribution: true,
        allowsDerivedAi: true,
      },
    });
    await db.insert(caseLawDecisions).values(decisions);
    await db.insert(caseLawDecisionIdentifiers).values(
      decisions.map(({ id }, index) => ({
        decisionId: id,
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: `Publication ${index}`,
        normalizedValue: `publication ${index}`,
      })),
    );
    const first = decisions.at(0) ?? panic("Summary fixture needs a decision");
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
    const handler = createHandler(caseLawDb);
    // Both cardinalities must include the same real registry read rather
    // than one measurement borrowing another measurement's warm cache.
    resetPublicCaseLawConfigForTesting(caseLawDb);
    try {
      return await runWithMeasuredQueryCounter(async (counter) => {
        const response = await handler.handler(
          asTestRaw<Parameters<typeof handler.handler>[0]>({
            params: { decisionId: first.id },
            request: new Request(
              `https://example.test/v1/case/decisions/${first.id}/summary`,
            ),
            route:
              "/v1/case/decisions/:decisionId/summary" satisfies ApiRoutePath,
            set: { headers: {} },
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          response.id !== first.id ||
          response.caseNumber !== first.caseNumber ||
          response.publication !== "Publication 0"
        ) {
          panic("Summary scaling requires the actual published decision");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      });
    } finally {
      resetPublicCaseLawConfigForTesting();
    }
  },
};
