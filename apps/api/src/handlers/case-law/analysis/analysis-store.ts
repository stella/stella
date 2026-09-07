/**
 * The application's binding of the analysis store (`analysis-store-core.ts`):
 * the decision row through the root handle, normally.
 *
 * A shared corpus read through the read-only handle cannot take that write,
 * so production reports the analysis unavailable there, and a development
 * process keeps it in memory instead.
 */

import type { AnalysisGenerating } from "@stll/legal-ast/analysis";
import { parsePersistedDecisionAnalysis } from "@stll/legal-ast/analysis";

// SAFETY: rootDb is used here because a case-law analysis is global, not
// workspace-scoped, and because the generation path writes from a
// fire-and-forget background task whose request scope has already ended.
// eslint-disable-next-line no-restricted-imports -- global corpus state; background writes outlive the request scope
import { rootDb } from "@/api/db/root";
import { envBase } from "@/api/env-base";
import type { SafeId } from "@/api/lib/branded-types";

import {
  createDbAnalysisStore,
  type AnalysisStore,
} from "./analysis-store-core";
import { analysisSentinel } from "./stored-analysis";

export type { AnalysisStore } from "./analysis-store-core";

const dbAnalysisStore = createDbAnalysisStore(rootDb);

const memoryAnalyses = new Map<SafeId<"caseLawDecision">, unknown>();

const memoryAnalysisStore: AnalysisStore = {
  claim: async ({ decisionId, fingerprint, observed }) => {
    // The same compare-and-swap as the row, over what this process holds:
    // an entry must still be the one this request read (entries are the
    // exact objects stored, so identity is equality). No entry means the
    // request read the read-only row, which this store never writes.
    const held = memoryAnalyses.get(decisionId);
    if (held !== undefined && held !== observed) {
      return await Promise.resolve(null);
    }
    const sentinel: AnalysisGenerating = analysisSentinel(
      fingerprint,
      new Date(),
    );
    memoryAnalyses.set(decisionId, sentinel);
    return await Promise.resolve(sentinel);
  },
  // The document behind a memory entry is a read-only row this process
  // never re-parses, so the fingerprint alone identifies the run here.
  save: async ({ analysis, decisionId }) => {
    const held = parsePersistedDecisionAnalysis(memoryAnalyses.get(decisionId));
    if (held?.inputFingerprint === analysis.inputFingerprint) {
      memoryAnalyses.set(decisionId, analysis);
    }
    await Promise.resolve();
  },
  clear: async ({ decisionId, sentinel }) => {
    if (memoryAnalyses.get(decisionId) === sentinel) {
      memoryAnalyses.delete(decisionId);
    }
    await Promise.resolve();
  },
  peek: (decisionId) => memoryAnalyses.get(decisionId) ?? null,
};

const readsSharedCorpus = (): boolean =>
  envBase.PUBLIC_LAW_DATABASE_URL !== undefined;

/**
 * Whether this deployment can store an analysis at all. A shared corpus
 * connection is deliberately read-only: it may serve an analysis the
 * owning environment persisted, but this process must never create or
 * update one there. A development process keeps its analyses in memory
 * instead, which is what makes the local reader work.
 */
export const storesAnalyses = (): boolean =>
  !readsSharedCorpus() || envBase.isDev;

export const analysisStore = (): AnalysisStore =>
  readsSharedCorpus() ? memoryAnalysisStore : dbAnalysisStore;
