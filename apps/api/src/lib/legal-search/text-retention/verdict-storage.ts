import { panic } from "better-result";
import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawTextRetentionVerdicts } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

import type { AssessmentReason, PayloadAssessment } from "./validation";

type StoredVerdictStatusFields =
  | {
      status: "assessed";
      retainedRatio: number;
      defect: "text_loss_suspected" | null;
      reason: null;
      missingSampleHash: string | null;
    }
  | {
      status: "empty_source";
      retainedRatio: null;
      defect: null;
      reason: null;
      missingSampleHash: null;
    }
  | {
      status: "unavailable";
      retainedRatio: null;
      defect: null;
      reason: AssessmentReason;
      missingSampleHash: null;
    };

const storedVerdictStatusFields = (
  verdict: PayloadAssessment["verdict"],
): StoredVerdictStatusFields => {
  switch (verdict.status) {
    case "assessed":
      return {
        status: verdict.status,
        retainedRatio: verdict.retainedRatio,
        defect: verdict.defect,
        reason: null,
        missingSampleHash: verdict.missingSampleHash,
      };
    case "empty_source":
      return {
        status: verdict.status,
        retainedRatio: null,
        defect: null,
        reason: null,
        missingSampleHash: null,
      };
    case "unavailable":
      return {
        status: verdict.status,
        retainedRatio: null,
        defect: null,
        reason: verdict.reason,
        missingSampleHash: null,
      };
    default:
      verdict satisfies never;
      return panic("Unhandled retention verdict status");
  }
};

type WriteRetentionVerdictOptions = {
  decisionId: SafeId<"caseLawDecision">;
  sourceId: SafeId<"caseLawSource">;
  sourceHash: string | null;
  rawS3Key: string | null;
  assessment: PayloadAssessment;
};

/** The caller holds the decision's winning write or validation-only CAS in this transaction. */
export const writeRetentionVerdictTx = async (
  tx: Transaction,
  {
    decisionId,
    sourceId,
    sourceHash,
    rawS3Key,
    assessment,
  }: WriteRetentionVerdictOptions,
): Promise<void> => {
  const row = {
    decisionId,
    sourceId,
    sourceHash,
    rawS3Key,
    rawFingerprint: assessment.rawFingerprint,
    payloadFingerprint: assessment.payloadFingerprint,
    compositionFingerprint: assessment.compositionFingerprint,
    parserVersion: assessment.parserVersion,
    oracleVersion: assessment.oracleVersion,
    exclusionVersion: assessment.exclusionVersion,
    checkedAt: new Date(),
    components: assessment.components,
    ...storedVerdictStatusFields(assessment.verdict),
  } satisfies typeof caseLawTextRetentionVerdicts.$inferInsert;
  await tx.insert(caseLawTextRetentionVerdicts).values(row).onConflictDoUpdate({
    target: caseLawTextRetentionVerdicts.decisionId,
    set: row,
  });
};

/** Ingestion-only snapshot read; the public reader has a separate column-restricted projection. */
export const readRetentionVerdictTx = async (
  tx: Transaction,
  decisionId: SafeId<"caseLawDecision">,
) => {
  const rows = await tx
    .select()
    .from(caseLawTextRetentionVerdicts)
    .where(eq(caseLawTextRetentionVerdicts.decisionId, decisionId))
    .limit(1);
  return rows.at(0) ?? null;
};
