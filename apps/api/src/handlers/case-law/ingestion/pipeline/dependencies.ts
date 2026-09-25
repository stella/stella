import { corpusStorageMode } from "@/api/env-base";
import { replaceDecisionJudges } from "@/api/handlers/case-law/judges/decision-judges";
import type { CorpusStorageMode } from "@/api/lib/corpus-storage-mode";
import { deployedCorpusTransfer } from "@/api/lib/legal-search/corpus-pack-batch";
import type { CorpusTransfer } from "@/api/lib/legal-search/corpus-pack-batch";

export type CaseLawCorpusDependencies = {
  mode: CorpusStorageMode;
  /**
   * How a batch's payloads reach object storage; replaced in tests. The
   * layout and its client travel together, so a test cannot replace a client
   * the configured layout never calls.
   */
  transfer: CorpusTransfer;
};

export const CASE_LAW_CORPUS_DEPENDENCIES: CaseLawCorpusDependencies = {
  mode: corpusStorageMode,
  transfer: deployedCorpusTransfer(),
};

/**
 * Where a decision's judges are written. Injected the way the corpus write
 * is, so the ordering against the row write can be exercised without the
 * tables behind it.
 */
export type CaseLawJudgeDependencies = {
  replace: typeof replaceDecisionJudges;
};

export const CASE_LAW_JUDGE_DEPENDENCIES: CaseLawJudgeDependencies = {
  replace: replaceDecisionJudges,
};
