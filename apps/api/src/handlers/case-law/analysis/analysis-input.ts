import { Result, TaggedError } from "better-result";
/**
 * The exact input an analysis of one decision is computed over: the
 * decision row, the text as the reader sees it today, and the resolved
 * system prompt plus user message the fingerprint digests.
 *
 * The in-app run (`generate.ts`) resolves it here. The operator scripts
 * that hand the input to an external producer and fence its save
 * (`src/scripts/decision-analysis-input.ts`, `decision-analysis-save.ts`)
 * resolve it from their own row read through `analysisInputOf` and the
 * same prompt registry; if they resolved it differently, the fingerprint
 * they compare would not mean the same thing.
 */

import type { ScopedDb } from "@/api/db/safe-db";
import { envBase } from "@/api/env-base";
import {
  devReparseEnabled,
  reparseForDev,
} from "@/api/handlers/case-law/decisions/dev-reparse";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  type AnalysisInput,
  analysisInputOf,
} from "@/api/lib/case-law/analysis-prompt";
import {
  readDecisionAnalysis,
  readDecisionAnalysisAst,
  readDecisionAnalysisAstColumn,
} from "@/api/lib/case-law/decision-analysis";
import {
  DECISION_ROW_AST_VERSION_CHANGED,
  readCachedDecisionRowAst,
} from "@/api/lib/case-law/decision-row-ast-cache";
import { decisionPayloadKey } from "@/api/lib/case-law/decision-versioned-payload";
import { defineWindowedRead } from "@/api/lib/files/windowed-read-surface";
import { readCorpusTombstones } from "@/api/lib/legal-search/corpus-reads";

import { getSystemPrompt } from "./prompts/prompt-registry";

type DecisionAnalysisRow = NonNullable<
  Awaited<ReturnType<typeof readDecisionAnalysis>>
>;

const ANALYSIS_INPUT_VERSION_ATTEMPTS = 3;

class AnalysisInputVersionChangedError extends TaggedError(
  "AnalysisInputVersionChangedError",
)<{
  message: string;
  decisionId: SafeId<"caseLawDecision">;
  attempts: number;
}> {}

export type AnalysisInputResolution =
  | {
      kind: "resolved";
      decision: DecisionAnalysisRow;
      input: AnalysisInput;
      /** Anchor ids of the parse the input was built over, in reading order. */
      anchorIds: string[];
    }
  | { kind: "decision-not-found" }
  | { kind: "unparseable-document" }
  /** No analysis prompt is written for the decision's language. */
  | { kind: "unsupported-language"; language: string };

type AnalysisInputResult = Result<
  AnalysisInputResolution,
  AnalysisInputVersionChangedError
>;

export const resolveAnalysisInput = defineWindowedRead(
  "analysis-input",
  async ({
    decisionId,
    scopedDb,
  }: {
    decisionId: SafeId<"caseLawDecision">;
    scopedDb: ScopedDb;
  }): Promise<AnalysisInputResult> => {
    const resolveAttempt = async (
      attempt: number,
    ): Promise<AnalysisInputResult> => {
      const decision =
        envBase.PUBLIC_LAW_DATABASE_URL === undefined
          ? await scopedDb(
              async (tx) => await readDecisionAnalysis(tx, decisionId),
            )
          : await caseLawPublicReadDb(
              async (tx) => await readDecisionAnalysis(tx, decisionId),
            );

      if (!decision) {
        return Result.ok({ kind: "decision-not-found" });
      }
      // Decided from the row alone, before the tree is read from storage.
      const systemPrompt = getSystemPrompt(decision.language);
      if (Result.isError(systemPrompt)) {
        return Result.ok({
          kind: "unsupported-language",
          language: systemPrompt.error.language,
        });
      }

      // The text the reader sees: in development that may be the tree's own
      // parse rather than the stored one, and the anchors must agree. Resolved
      // before the stored analysis is consulted, because whether that analysis
      // still applies is a property of this text.
      const reparsed =
        devReparseEnabled() && decision.source !== null
          ? await reparseForDev({
              adapterKey: decision.source.adapterKey,
              caseNumber: decision.caseNumber,
              court: decision.court,
              decisionDate: decision.decisionDate,
              decisionType: decision.decisionType,
              documentUrl: decision.documentUrl,
              ecli: decision.ecli,
              id: decisionId,
              metadata: decision.metadata,
            })
          : null;
      const versionState = { changed: false };
      const ast =
        reparsed ??
        (await readDecisionAnalysisAst(
          { ...decision, documentAst: null },
          readCorpusTombstones,
          async () =>
            await readCachedDecisionRowAst({
              documentId: decision.id,
              key: decisionPayloadKey(decision),
              onVersionChanged: () => {
                versionState.changed = true;
              },
              read: async () => {
                const result =
                  envBase.PUBLIC_LAW_DATABASE_URL === undefined
                    ? await scopedDb(
                        async (tx) =>
                          await readDecisionAnalysisAstColumn(tx, {
                            decisionId,
                            versionTimestamp: decision.versionTimestamp,
                            contentHash: decision.contentHash,
                            astS3Key: decision.astS3Key,
                          }),
                      )
                    : await caseLawPublicReadDb(
                        async (tx) =>
                          await readDecisionAnalysisAstColumn(tx, {
                            decisionId,
                            versionTimestamp: decision.versionTimestamp,
                            contentHash: decision.contentHash,
                            astS3Key: decision.astS3Key,
                          }),
                      );
                if (result.kind === "version-changed") {
                  return DECISION_ROW_AST_VERSION_CHANGED;
                }
                return result.value;
              },
            }),
        ));
      if (versionState.changed) {
        if (attempt < ANALYSIS_INPUT_VERSION_ATTEMPTS) {
          return await resolveAttempt(attempt + 1);
        }
        return Result.err(
          new AnalysisInputVersionChangedError({
            message: `Decision changed during analysis input resolution after ${String(attempt)} attempts`,
            decisionId,
            attempts: attempt,
          }),
        );
      }
      if (ast === null) {
        return Result.ok({ kind: "unparseable-document" });
      }

      return Result.ok({
        kind: "resolved",
        decision,
        anchorIds: ast.blocks.map((block) => block.anchorId),
        input: analysisInputOf({
          blocks: ast.blocks,
          decision,
          systemPrompt: systemPrompt.value,
        }),
      });
    };
    return await resolveAttempt(1);
  },
);
