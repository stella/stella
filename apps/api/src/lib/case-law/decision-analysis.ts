import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";

const decisionAnalysisColumns = {
  id: true,
  language: true,
  court: true,
  country: true,
  decisionType: true,
  documentAst: true,
  analysis: true,
} as const;

export const readDecisionAnalysis = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawAnalysis,
  async (
    tx: CaseLawPublicReadTransaction,
    decisionId: SafeId<"caseLawDecision">,
  ) =>
    await tx.query.caseLawDecisions.findFirst({
      where: { id: { eq: decisionId } },
      columns: decisionAnalysisColumns,
    }),
);
