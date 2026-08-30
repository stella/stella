import { and, eq } from "drizzle-orm";

import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SUGGESTION_KIND,
} from "@stll/api-contract/signals";

import type { Transaction } from "@/api/db/root";
import {
  documentReviewFindings,
  documentReviewRuns,
  entities,
} from "@/api/db/schema";
import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import { DOCUMENT_REVIEW_FINDINGS_PER_RUN_MAX } from "@/api/lib/document-review/run-contract";
import {
  REVIEW_FINDINGS_SHOWN_MAX,
  REVIEW_SIGNAL_CONFIDENCE,
  reviewDedupeKey,
  reviewSignalSeverity,
  reviewVerdict,
  toReviewSignalFindings,
} from "@/api/lib/scouts/document-review.logic";
import { documentScoutsEnabled } from "@/api/lib/scouts/document-scout-config";
import { emitSignals } from "@/api/lib/signals/emit";

export type EmitDocumentReviewSignalArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"documentReviewRun">;
};

/**
 * Turn a completed review run into one `contract.reviewed` signal when its
 * playbook findings are not all compliant. Runs inside the finalize
 * transaction: the run and its inbox card commit together.
 */
export const emitDocumentReviewSignal = async ({
  tx,
  workspaceId,
  runId,
}: EmitDocumentReviewSignalArgs): Promise<void> => {
  const run = (
    await tx
      .select({
        organizationId: documentReviewRuns.organizationId,
        entityId: documentReviewRuns.entityId,
      })
      .from(documentReviewRuns)
      .where(
        and(
          eq(documentReviewRuns.id, runId),
          eq(documentReviewRuns.workspaceId, workspaceId),
        ),
      )
      .limit(1)
  ).at(0);
  if (!run) {
    return;
  }
  const rows = await tx
    .select({ payload: documentReviewFindings.payload })
    .from(documentReviewFindings)
    .where(
      and(
        eq(documentReviewFindings.runId, runId),
        eq(documentReviewFindings.workspaceId, workspaceId),
      ),
    )
    .limit(DOCUMENT_REVIEW_FINDINGS_PER_RUN_MAX);
  const findings = toReviewSignalFindings(rows.map((row) => row.payload));
  const verdict = reviewVerdict(findings);
  if (verdict === "safe") {
    return;
  }

  const entity = await tx
    .select({ name: entities.name })
    .from(entities)
    .where(
      and(eq(entities.id, run.entityId), eq(entities.workspaceId, workspaceId)),
    )
    .limit(1);
  const entityName = entity.at(0)?.name ?? "Document";
  const shown = findings.slice(0, REVIEW_FINDINGS_SHOWN_MAX);
  const headline = shown.map((f) => f.title).join("; ");

  await emitSignals({
    tx,
    organizationId: run.organizationId,
    signals: [
      {
        kind: SIGNAL_KIND.CONTRACT_REVIEWED,
        scoutKey: SCOUT_KEY.DOCUMENT_REVIEW,
        workspaceId,
        severity: reviewSignalSeverity(verdict),
        confidence: REVIEW_SIGNAL_CONFIDENCE,
        title:
          verdict === "reject"
            ? `Review blocked: ${entityName}`
            : `Review needs attention: ${entityName}`,
        summary: `${findings.length} finding(s): ${headline}`,
        subject: { type: "entity", workspaceId, entityId: run.entityId },
        evidence: {
          kind: SIGNAL_KIND.CONTRACT_REVIEWED,
          entityId: run.entityId,
          entityName,
          verdict,
          findings: shown,
          reviewRunId: runId,
        },
        suggestions: [
          {
            kind: SUGGESTION_KIND.CREATE_TASK,
            workspaceId,
            name: `Review findings: ${entityName}`,
            dueAt: null,
          },
          {
            kind: SUGGESTION_KIND.OPEN_CHAT,
            prompt: `Walk me through the review findings for "${entityName}" and suggest how to negotiate each one.`,
          },
        ],
        dedupeKey: reviewDedupeKey(runId),
      },
    ],
  });
};

/**
 * Emit inside the finalize transaction. A persistence failure must abort the
 * finalize CAS so the durable review run remains retryable; completing the
 * review without its signal would make the missing notification permanent.
 */
export const maybeEmitDocumentReviewSignal = async (
  args: EmitDocumentReviewSignalArgs,
): Promise<void> => {
  if (!documentScoutsEnabled(env)) {
    return;
  }
  await emitDocumentReviewSignal(args);
};
