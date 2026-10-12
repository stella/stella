import { Result } from "better-result";

import type { DecisionAnalysis } from "@stll/legal-ast/analysis";

import type { SafeId } from "@/api/lib/branded-types";
import type { AnalysisStore } from "@/api/lib/case-law/analysis-store-core";

type AnalysisPersistence = Pick<AnalysisStore, "save">;

type PersistGeneratedAnalysisOptions = {
  analysis: DecisionAnalysis;
  contentHash: string | null;
  decisionId: SafeId<"caseLawDecision">;
  onFailure: (error: unknown) => Promise<void>;
  persistence: AnalysisPersistence;
};

export const persistGeneratedAnalysis = async ({
  analysis,
  contentHash,
  decisionId,
  onFailure,
  persistence,
}: PersistGeneratedAnalysisOptions) => {
  const saved = await Result.tryPromise({
    try: async () =>
      await persistence.save({ analysis, contentHash, decisionId }),
    catch: (error) => error,
  });
  if (Result.isError(saved)) {
    await onFailure(saved.error);
  }
};
