import { panic } from "better-result";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { readGatedDecisionWithDocument } from "@/api/handlers/case-law/decisions/get-deferred-document";
import verifyQuotation, {
  createVerifyQuotationHandler,
} from "@/api/handlers/case-law/decisions/quotes/check";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { resetPublicCaseLawConfigForTesting } from "@/api/lib/case-law/public-case-law-config";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import {
  VERIFY_QUOTE_TOOL_SET,
  verifyQuoteOutputSchema,
} from "@/api/mcp/verify-quote-tools";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import type { seedEntityReadScaling } from "./entity-fixture";

/** Real gated point read with N stored decisions; no corpus search or publisher fetch. */
export const measureVerifyQuote = async (
  { db, size }: Awaited<ReturnType<typeof seedEntityReadScaling>>,
  transport: "mcp" | "api" = "mcp",
) => {
  const sourceId = createSafeId<"caseLawSource">();
  const ids = Array.from({ length: size }, () =>
    createSafeId<"caseLawDecision">(),
  );
  const id = ids.at(0) ?? panic("Scaling fixture contains a decision");
  await db.insert(caseLawSources).values(
    caseLawSourceRow({
      id: sourceId,
      adapterKey: "quote-scaling",
      name: "Quote scaling",
    }),
  );
  await db.insert(caseLawDecisions).values(
    ids.map((decisionId, index) => ({
      id: decisionId,
      sourceId,
      country: "CZE",
      court: "Nejvyšší soud",
      language: "cs",
      caseNumber: `1 Test ${index}/2026`,
      fulltext: "Soud návrh zamítl pro opožděnost podání.",
      metadata: {},
    })),
  );
  const readDb = async <T>(
    work: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  ) => await db.transaction(async (tx) => await work(tx));
  const caseLawDb = asTestRaw<CaseLawPublicReadDb>(readDb);
  resetPublicCaseLawConfigForTesting(caseLawDb);
  try {
    return await runWithMeasuredQueryCounter(async (counter) => {
      type ToolContext = Parameters<
        typeof VERIFY_QUOTE_TOOL_SET.handlers.verify_quote
      >[0]["context"];
      const testDependencies = {
        readsSharedPublicLawCorpus: () => false,
        readGatedDecisionWithDocument: async (options) =>
          await readGatedDecisionWithDocument({ ...options, caseLawDb }),
      } satisfies NonNullable<ToolContext["testDependencies"]>;
      const data = await (async () => {
        if (transport === "api") {
          const endpoint = createVerifyQuotationHandler({
            readSharedCorpus: testDependencies.readsSharedPublicLawCorpus,
            readDecision: testDependencies.readGatedDecisionWithDocument,
          });
          const response = await endpoint.handler(
            asTestRaw<Parameters<typeof endpoint.handler>[0]>({
              body: { decision_id: id, text: "Soud návrh zamítl" },
              request: new Request(
                "https://example.test/v1/case/decisions/quotes/verify",
                { method: "POST" },
              ),
              route: "/v1/case/decisions/quotes/verify" satisfies ApiRoutePath,
              set: { headers: {} },
            }),
          );
          if (response instanceof HttpStatusResponse) {
            return panic("Quote scaling must read the stored public passage");
          }
          return v.parse(verifyQuoteOutputSchema, response);
        }
        const response = await VERIFY_QUOTE_TOOL_SET.handlers.verify_quote({
          args: { decision_id: id, text: "Soud návrh zamítl" },
          context: asTestRaw<ToolContext>({ testDependencies }),
        });
        if ("egress" in response || response.status !== "success") {
          return panic("Quote scaling must read the stored public passage");
        }
        return v.parse(verifyQuoteOutputSchema, response.data);
      })();
      if (data.status !== "exact") {
        return panic("Quote scaling must verify the stored public passage");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(data)),
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

export const verifyQuoteApiScalingScenario = {
  name: "public decision quotation verification",
  definition: verifyQuotation,
  measure: async (fixture: Awaited<ReturnType<typeof seedEntityReadScaling>>) =>
    await measureVerifyQuote(fixture, "api"),
};
