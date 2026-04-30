import { parsePersistedDecisionAnalysis } from "@stll/case-law/analysis";
import { status } from "elysia";

import type { ScopedDb } from "@/api/db";
import { hasUsableAst } from "@/api/handlers/case-law/document-ast";
import type { SafeId } from "@/api/lib/branded-types";

export const readDecisionHandler = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
) => {
  const decision = await scopedDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: { id: { eq: decisionId } },
      columns: {
        id: true,
        caseNumber: true,
        ecli: true,
        court: true,
        country: true,
        language: true,
        languageGroupKey: true,
        decisionDate: true,
        decisionType: true,
        documentAst: true,
        analysis: true,
        sourceUrl: true,
        documentUrl: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
        // fulltext: only as fallback when no AST
        // sections: frontend doesn't use these
      },
      with: {
        source: {
          columns: { id: true, name: true, adapterKey: true },
        },
        citationsFrom: {
          columns: {
            id: true,
            citationText: true,
            citedDecisionId: true,
            sectionIndex: true,
          },
        },
        citationsTo: {
          columns: {
            id: true,
            citationText: true,
            citingDecisionId: true,
            sectionIndex: true,
          },
        },
      },
    }),
  );

  if (!decision) {
    return status(404, { message: "Decision not found" });
  }

  const normalizedDecision = {
    ...decision,
    analysis: parsePersistedDecisionAnalysis(decision.analysis),
  };

  // Only fetch fulltext if no usable documentAst (fallback).
  // Empty `{}` is stored by adapters without AST parsers;
  // treat it the same as null.
  if (!hasUsableAst(decision.documentAst)) {
    const fallback = await scopedDb((tx) =>
      tx.query.caseLawDecisions.findFirst({
        where: { id: { eq: decisionId } },
        columns: { fulltext: true },
      }),
    );
    return { ...normalizedDecision, fulltext: fallback?.fulltext ?? null };
  }

  return { ...normalizedDecision, fulltext: null };
};
