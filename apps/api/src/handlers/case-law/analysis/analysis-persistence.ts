import { Result } from "better-result";

import type {
  AnalysisGenerating,
  DecisionAnalysis,
} from "@stll/legal-ast/analysis";

import type { SafeId } from "@/api/lib/branded-types";
import type { AnalysisStore } from "@/api/lib/case-law/analysis-store-core";

type AnalysisPersistence = Pick<AnalysisStore, "save">;

type PersistGeneratedAnalysisOptions = {
  analysis: DecisionAnalysis;
  contentHash: string | null;
  decisionId: SafeId<"caseLawDecision">;
  onFailure: (error: unknown) => Promise<void>;
  persistence: AnalysisPersistence;
  sentinel: AnalysisGenerating;
};

export const persistGeneratedAnalysis = async ({
  analysis,
  contentHash,
  decisionId,
  onFailure,
  persistence,
  sentinel,
}: PersistGeneratedAnalysisOptions) => {
  const saved = await Result.tryPromise({
    try: async () =>
      await persistence.save({
        analysis,
        contentHash,
        decisionId,
        ownership: { type: "generation", sentinel },
      }),
    catch: (error) => error,
  });
  if (Result.isError(saved)) {
    await onFailure(saved.error);
  }
};
