import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { DECISION_ANCHOR_REDIRECT } from "@stll/api-contract/case-law-anchor-redirects";

import {
  caseLawDecisionAnchorRedirects,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import readDecisionAnchorRedirects, {
  type createReadDecisionAnchorRedirectsHandler,
} from "@/api/handlers/case-law/decisions/anchor-redirects";
import type { ApiRoutePath } from "@/api/http/api-route-types";
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

type DecisionAnchorRedirectsMeasurementOptions = {
  /** How many redirects the decision has; one is asked for. */
  size: number;
  db: GatedTestDb;
  createHandler: typeof createReadDecisionAnchorRedirectsHandler;
};

export const decisionAnchorRedirectsScalingScenario = {
  name: "public decision anchor redirects",
  definition: readDecisionAnchorRedirects,
  measure: async ({
    size,
    db,
    createHandler,
  }: DecisionAnchorRedirectsMeasurementOptions) => {
    // Temp relations shadow only this connection; schema/defaults and both
    // publication views come from their production owners.
    for (const table of [
      "case_law_sources",
      "case_law_decisions",
      "case_law_decision_anchor_redirects",
    ]) {
      await db.execute(sql`CREATE TEMP TABLE ${sql.identifier(table)} (
        LIKE public.${sql.identifier(table)} INCLUDING DEFAULTS
      )`);
    }
    await db.execute(caseLawPublishedDecisionsFixtureSql);
    await db.execute(caseLawUnredactedDecisionsFixtureSql);
    const sourceId = createSafeId<"caseLawSource">();
    const decisionId = createSafeId<"caseLawDecision">();
    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: "anchor-redirect-scaling",
      name: "Anchor redirect fixture",
      descriptor: {
        license: "public-domain",
        attribution: null,
        allowsRedistribution: true,
        allowsDerivedAi: true,
      },
    });
    await db.insert(caseLawDecisions).values({
      id: decisionId,
      sourceId,
      caseNumber: "Redirects 1",
      court: "Nejvyšší soud",
      country: "CZE",
      language: "cs",
      decisionDate: "2026-01-01",
      fulltext: "Document body",
      metadata: {},
    });
    await db.insert(caseLawDecisionAnchorRedirects).values(
      Array.from({ length: size }, (_, index) => ({
        decisionId,
        fromAnchor: `p-${String(index + 1)}`,
        toAnchor: `n${String(index + 1)}`,
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
    const handler = createHandler(caseLawDb);
    return await runWithMeasuredQueryCounter(async (counter) => {
      const response = await handler.handler(
        asTestRaw<Parameters<typeof handler.handler>[0]>({
          params: { decisionId },
          query: { anchors: ["p-1"] },
          request: new Request(
            `https://example.test/v1/case/decisions/${decisionId}/anchor-redirects?anchors=p-1`,
          ),
          route:
            "/v1/case/decisions/:decisionId/anchor-redirects" satisfies ApiRoutePath,
          set: { headers: {} },
        }),
      );
      const answer =
        response instanceof HttpStatusResponse ? null : response.items.at(0);
      if (
        answer?.redirect.type !== DECISION_ANCHOR_REDIRECT.MOVED ||
        answer.redirect.anchorId !== "n1"
      ) {
        panic("Anchor redirect scaling requires the stored redirect");
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
