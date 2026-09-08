/**
 * The exact input an analysis of one decision is computed over: the
 * decision row, the text as the reader sees it today, and the resolved
 * system prompt plus user message the fingerprint digests.
 *
 * Shared by the three surfaces that must agree on it — the in-app run
 * (`generate.ts`), the input a external producer is handed
 * (`input/get.ts`), and the fence a save is checked against
 * (`update.ts`). If any of them resolved the input differently, the
 * fingerprint they compare would not mean the same thing.
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
  analysisInputOf,
  type AnalysisInput,
} from "@/api/lib/case-law/analysis-prompt";
import {
  readDecisionAnalysis,
  readDecisionAnalysisAst,
} from "@/api/lib/case-law/decision-analysis";

import { getSystemPrompt } from "./prompts/prompt-registry";

type DecisionAnalysisRow = NonNullable<
  Awaited<ReturnType<typeof readDecisionAnalysis>>
>;

export type AnalysisInputResolution =
  | {
      kind: "resolved";
      decision: DecisionAnalysisRow;
      input: AnalysisInput;
      /** Anchor ids of the parse the input was built over, in reading order. */
      anchorIds: string[];
    }
  | { kind: "decision-not-found" }
  | { kind: "unparseable-document" };

export const resolveAnalysisInput = async ({
  decisionId,
  scopedDb,
}: {
  decisionId: SafeId<"caseLawDecision">;
  scopedDb: ScopedDb;
}): Promise<AnalysisInputResolution> => {
  const decision =
    envBase.PUBLIC_LAW_DATABASE_URL === undefined
      ? await scopedDb(async (tx) => await readDecisionAnalysis(tx, decisionId))
      : await caseLawPublicReadDb(
          async (tx) => await readDecisionAnalysis(tx, decisionId),
        );

  if (!decision) {
    return { kind: "decision-not-found" };
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
  const ast = reparsed ?? (await readDecisionAnalysisAst(decision));
  if (ast === null) {
    return { kind: "unparseable-document" };
  }

  return {
    kind: "resolved",
    decision,
    anchorIds: ast.blocks.map((block) => block.anchorId),
    input: analysisInputOf({
      blocks: ast.blocks,
      decision,
      systemPrompt: getSystemPrompt(decision.language),
    }),
  };
};
