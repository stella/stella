import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import checkCitation, {
  type createCheckCitation,
} from "@/api/handlers/case-law/citations/check";
import { decisionDocketColumns } from "@/api/handlers/case-law/ingestion/pipeline/decision-docket-columns";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { resetPublicCaseLawConfigForTesting } from "@/api/lib/case-law/public-case-law-config";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { DecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { grantedCitationCheckSnapshot } from "@/api/tests/helpers/citation-check-access";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import type { seedEntityReadScaling } from "./entity-fixture";

const CITED_DOCKET = "21 Cdo 1234/2020";

/** Answers every question with its first option, without leaving the process. */
const firstOptionDecisionModel = asTestRaw<DecisionModel>({
  provider: "typesafe",
  model: "jev-scaling",
  keySource: "byok",
  ask: async ({
    questions,
  }: {
    questions: Record<string, { criteria: Record<string, unknown> }>;
  }) =>
    await Promise.resolve(
      Result.ok({
        model: "jev-scaling",
        answers: Object.fromEntries(
          Object.entries(questions).map(([id, question]) => {
            const choice =
              Object.keys(question.criteria).at(0) ??
              panic("A scaling question offers an option");
            return [
              id,
              {
                type: "choice",
                choice,
                probabilities: { [choice]: 0.99 },
                confidence: 0.99,
              },
            ];
          }),
        ),
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
      }),
    ),
});

/** The usage write is one row per check whatever the corpus holds. */
const unmeteredDb = asTestRaw<SafeDb>(
  async () => await Promise.resolve(Result.ok({ status: "recorded" })),
);

/**
 * A citation check against N stored decisions: one names the cited docket,
 * the rest are unrelated. The decision model answers in process.
 */
const measureCitationCheck = async (
  {
    db,
    organizationId,
    size,
    userId,
  }: Awaited<ReturnType<typeof seedEntityReadScaling>>,
  createHandler: typeof createCheckCitation,
) => {
  const sourceId = createSafeId<"caseLawSource">();
  const ids = Array.from({ length: size }, () =>
    createSafeId<"caseLawDecision">(),
  );
  await db.insert(caseLawSources).values(
    caseLawSourceRow({
      id: sourceId,
      adapterKey: "citation-check-scaling",
      name: "Citation check scaling",
    }),
  );
  await db.insert(caseLawDecisions).values(
    ids.map((decisionId, index) => ({
      id: decisionId,
      sourceId,
      country: "CZE",
      court: "Nejvyšší soud",
      language: "cs",
      // The docket columns as ingestion writes them, one decision citable.
      ...decisionDocketColumns({
        caseNumber: index === 0 ? CITED_DOCKET : `1 Test ${index}/2026`,
        caseNumberType: "case-number",
        country: "CZE",
      }),
      languageGroupKey: `citation-check-scaling-${String(index)}`,
      fulltext: "Soud dovolání zamítl, neboť lhůta běží znovu.",
      metadata: {},
    })),
  );
  const caseLawDb = asTestRaw<CaseLawPublicReadDb>(
    async <T>(work: (tx: CaseLawPublicReadTransaction) => Promise<T>) =>
      await db.transaction(async (tx) => await work(tx)),
  );
  resetPublicCaseLawConfigForTesting(caseLawDb);
  try {
    return await runWithMeasuredQueryCounter(async (counter) => {
      const endpoint = createHandler({
        caseLawDb,
        hasDecisionModel: () => true,
        decisionModel: firstOptionDecisionModel,
      });
      const response = await endpoint.handler(
        asTestRaw<Parameters<typeof endpoint.handler>[0]>({
          body: {
            citation: `sp. zn. ${CITED_DOCKET}`,
            claim: "Lhůta běží znovu.",
          },
          orgAIConfig: null,
          orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
          session: { activeOrganizationId: organizationId },
          user: { id: userId },
          memberRole: sessionMemberRole("member"),
          featureAccessSnapshot: grantedCitationCheckSnapshot({
            organizationId,
            userId,
          }),
          safeDb: unmeteredDb,
          request: new Request("https://example.test/v1/case/citations/check", {
            method: "POST",
          }),
          route: "/v1/case/citations/check" satisfies ApiRoutePath,
          set: { headers: {} },
        }),
      );
      if (
        response instanceof HttpStatusResponse ||
        response.status !== "checked"
      ) {
        return panic("Citation check scaling must check the cited decision");
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
    await db
      .delete(caseLawDecisions)
      .where(eq(caseLawDecisions.sourceId, sourceId));
    await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
  }
};

export const citationCheckApiScalingScenario = {
  name: "editor citation check",
  definition: checkCitation,
  measure: async (
    fixture: Awaited<ReturnType<typeof seedEntityReadScaling>>,
    createHandler: typeof createCheckCitation,
  ) => await measureCitationCheck(fixture, createHandler),
};
