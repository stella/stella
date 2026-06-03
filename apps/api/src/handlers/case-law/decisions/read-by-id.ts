import { status } from "elysia";

import { hasUsableAst } from "@/api/handlers/case-law/document-ast";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";

export const readDecisionHandler = async (
  decisionId: SafeId<"caseLawDecision">,
  caseLawDb: CaseLawPublicReadDb,
) => {
  const decision = await caseLawDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: { id: { eq: decisionId } },
      columns: {
        id: true,
        caseNumber: true,
        slug: true,
        ecli: true,
        court: true,
        country: true,
        language: true,
        languageGroupKey: true,
        decisionDate: true,
        decisionType: true,
        documentAst: true,
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

  // Only fetch fulltext if no usable documentAst (fallback).
  // Empty `{}` is stored by adapters without AST parsers;
  // treat it the same as null.
  let fulltext: string | null = null;
  if (!hasUsableAst(decision.documentAst)) {
    const fallback = await caseLawDb((tx) =>
      tx.query.caseLawDecisions.findFirst({
        where: { id: { eq: decisionId } },
        columns: { fulltext: true },
      }),
    );
    fulltext = fallback?.fulltext ?? null;
  }

  return {
    id: decision.id,
    caseNumber: decision.caseNumber,
    slug: decision.slug,
    ecli: decision.ecli,
    court: decision.court,
    country: decision.country,
    language: decision.language,
    languageGroupKey: decision.languageGroupKey,
    decisionDate: decision.decisionDate,
    decisionType: decision.decisionType,
    documentAst: decision.documentAst,
    sourceUrl: decision.sourceUrl,
    documentUrl: decision.documentUrl,
    metadata: decision.metadata,
    createdAt: decision.createdAt,
    updatedAt: decision.updatedAt,
    source: decision.source,
    citationsFrom: decision.citationsFrom,
    citationsTo: decision.citationsTo,
    fulltext,
  };
};

export const readDecisionBySlugHandler = async (
  slug: string,
  caseLawDb: CaseLawPublicReadDb,
) => {
  const decision = await caseLawDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: { slug: { eq: slug } },
      columns: { id: true },
    }),
  );

  if (!decision) {
    return status(404, { message: "Decision not found" });
  }

  return await readDecisionHandler(decision.id, caseLawDb);
};
