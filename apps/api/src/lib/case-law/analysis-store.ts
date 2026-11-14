/**
 * The application's binding of the analysis store (`analysis-store-core.ts`):
 * the decision row through the owner connection, normally.
 *
 * A case-law analysis is global corpus state, not one workspace's, and the
 * generation path writes it from a background task that outlives the request
 * that started it; so the handlers that generate analyses reach the row only
 * through the store operations here, never through a connection of their own.
 *
 * A shared corpus read through the read-only handle cannot take that write,
 * so production reports the analysis unavailable there, and a development
 * process keeps it in memory instead.
 */

import { panic, Result } from "better-result";
import { deepEquals } from "bun";

import type { AnalysisGenerating } from "@stll/legal-ast/analysis";
import { parsePersistedDecisionAnalysis } from "@stll/legal-ast/analysis";

import { rootDb } from "@/api/db/root";
import { envBase } from "@/api/env-base";
import type { SafeId } from "@/api/lib/branded-types";
import { isLocalDevOpen } from "@/api/runtime-mode";

import {
  type AnalysisFailureRecord,
  type FailureClaimGuard,
  failureMatchesGuard,
} from "./analysis-failure";
import {
  type AnalysisStore,
  createDbAnalysisStore,
} from "./analysis-store-core";
import { analysisSentinel } from "./stored-analysis";

export type { AnalysisStore } from "./analysis-store-core";

const dbAnalysisStore = createDbAnalysisStore(rootDb);

const memoryFailureKey = (
  decisionId: SafeId<"caseLawDecision">,
  keyTag: string,
): string => `${decisionId}:${keyTag}`;

type MemoryClaim = Parameters<AnalysisStore["claim"]>[0] & {
  unlessFailed?: FailureClaimGuard | undefined;
};

const ownsGeneration = (stored: unknown, sentinel: AnalysisGenerating) => {
  const held = parsePersistedDecisionAnalysis(stored);
  return (
    held !== null &&
    "status" in held &&
    "runId" in held &&
    held.runId === sentinel.runId &&
    held.inputFingerprint === sentinel.inputFingerprint
  );
};

/** Creates the process-local store used when the corpus database is read-only. */
export const createMemoryAnalysisStore = (
  now: () => Date = () => new Date(),
): AnalysisStore => {
  const memoryAnalyses = new Map<SafeId<"caseLawDecision">, unknown>();
  // A development process's failure records; it restarts long before they
  // could accumulate.
  const memoryFailures = new Map<string, AnalysisFailureRecord>();

  // Synchronous: nothing awaits between the checks and the write, so in one
  // process no claim or failure can land in between.
  const claimInMemory = ({
    decisionId,
    fingerprint,
    observed,
    unlessFailed,
  }: MemoryClaim): AnalysisGenerating | null => {
    // The same compare-and-swap as the row, over what this process holds:
    // an entry must still be the one this request read (entries are the
    // exact objects stored, so identity is equality). No entry means the
    // request read the read-only row, which this store never writes.
    const held = memoryAnalyses.get(decisionId);
    if (held !== undefined && held !== observed) {
      return null;
    }
    // The same failure guard as the row store's claim transaction.
    const failure =
      unlessFailed === undefined
        ? undefined
        : memoryFailures.get(memoryFailureKey(decisionId, unlessFailed.keyTag));
    if (
      failure !== undefined &&
      unlessFailed !== undefined &&
      failureMatchesGuard({ failure, fingerprint, guard: unlessFailed })
    ) {
      return null;
    }
    const sentinel = analysisSentinel(fingerprint, now());
    memoryAnalyses.set(decisionId, sentinel);
    return sentinel;
  };

  return {
    claim: async (claim) => await Promise.resolve(claimInMemory(claim)),
    claimUnlessFailed: async (claim) =>
      await Promise.resolve(Result.ok(claimInMemory(claim))),
    // The document behind a memory entry is a read-only row this process
    // never re-parses. Run ids fence claims; revisions compare the same
    // structural expected value as the JSONB writer.
    save: async ({ analysis, decisionId, ownership }) => {
      const stored = memoryAnalyses.get(decisionId);
      const held = parsePersistedDecisionAnalysis(stored);
      const owns = (() => {
        switch (ownership.type) {
          case "generation":
            return ownsGeneration(stored, ownership.sentinel);
          case "revision":
            return deepEquals(stored, ownership.expected);
          default:
            ownership satisfies never;
            return panic("Unknown analysis write ownership");
        }
      })();
      const wrote =
        held !== null &&
        held.inputFingerprint === analysis.inputFingerprint &&
        owns;
      if (wrote) {
        memoryAnalyses.set(decisionId, analysis);
      }
      return await Promise.resolve(wrote);
    },
    savePartial: async ({ decisionId, partialTree, sentinel }) => {
      const wrote = ownsGeneration(memoryAnalyses.get(decisionId), sentinel);
      if (wrote) {
        memoryAnalyses.set(decisionId, {
          ...sentinel,
          partialTree: [...partialTree],
        });
      }
      return await Promise.resolve(wrote);
    },
    clear: async ({ decisionId, sentinel }) => {
      if (ownsGeneration(memoryAnalyses.get(decisionId), sentinel)) {
        memoryAnalyses.delete(decisionId);
      }
      await Promise.resolve();
    },
    fail: async ({ decisionId, failure, keyTag, sentinel }) => {
      // Only the run that still holds the row files its failure; a superseded
      // run writes nothing (as the row store's single statement does).
      if (ownsGeneration(memoryAnalyses.get(decisionId), sentinel)) {
        memoryFailures.set(memoryFailureKey(decisionId, keyTag), failure);
        memoryAnalyses.delete(decisionId);
      }
      await Promise.resolve();
    },
    readFailure: async ({ decisionId, keyTag }) =>
      await Promise.resolve(
        memoryFailures.get(memoryFailureKey(decisionId, keyTag)) ?? null,
      ),
    peek: (decisionId) => memoryAnalyses.get(decisionId) ?? null,
  };
};

const memoryAnalysisStore = createMemoryAnalysisStore();

const readsSharedCorpus = (): boolean =>
  envBase.PUBLIC_LAW_DATABASE_URL !== undefined;

/**
 * Whether this deployment can store an analysis at all. A shared corpus
 * connection is deliberately read-only: it may serve an analysis the
 * owning environment persisted, but this process must never create or
 * update one there. A development process keeps its analyses in memory
 * instead, which is what makes the local reader work.
 */
const storesAnalyses = (): boolean => !readsSharedCorpus() || isLocalDevOpen();

/**
 * Whether this deployment may ask a model for a decision's derived layers:
 * an analysis generated on open, or a significance refreshed from the graph.
 * The one reader of `CASE_LAW_DERIVED_AI`, so every path that would reach a
 * model is fenced by the same decision. A deployment that cannot store an
 * analysis never generates one either.
 */
export const writesDerivedAnalyses = (): boolean =>
  storesAnalyses() && envBase.CASE_LAW_DERIVED_AI === "on";

export const analysisStore = (): AnalysisStore =>
  readsSharedCorpus() ? memoryAnalysisStore : dbAnalysisStore;
