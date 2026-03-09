import { status } from "elysia";

import type { ScopedDb } from "@/api/db";

export const readDecisionHandler = async (
  decisionId: string,
  scopedDb: ScopedDb,
) => {
  const decision = await scopedDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: { id: decisionId },
      columns: {
        id: true,
        caseNumber: true,
        ecli: true,
        court: true,
        country: true,
        language: true,
        decisionDate: true,
        decisionType: true,
        fulltext: true,
        sections: true,
        sourceUrl: true,
        documentUrl: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
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

  return decision;
};
