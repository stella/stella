import { and, eq, sql } from "drizzle-orm";

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
  pendingScoutEmissions,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { mutateRecoveryReceipt } from "@/api/lib/db/recovery-bookkeeping/receipts";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { DOCUMENT_REVIEW_FINDINGS_PER_RUN_MAX } from "@/api/lib/document-review/run-contract";
import { isBackgroundFeatureEnabled } from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import {
  REVIEW_FINDINGS_SHOWN_MAX,
  REVIEW_SIGNAL_CONFIDENCE,
  reviewDedupeKey,
  reviewSignalSeverity,
  reviewVerdict,
  toReviewSignalFindings,
} from "@/api/lib/scouts/document-review.logic";
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
}: EmitDocumentReviewSignalArgs): Promise<"emitted" | "paused" | "absent"> => {
  if (!isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
    return "paused";
  }
  const run = (
    await tx
      .select({
        organizationId: documentReviewRuns.organizationId,
        entityId: documentReviewRuns.entityId,
        requestedBy: documentReviewRuns.requestedBy,
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
    return "absent";
  }
  await lockFeatureRecoveryAdmission({
    tx,
    organizationId: run.organizationId,
    featureId: "signals",
  });
  if (
    !(await isBackgroundFeatureEnabled({
      tx,
      organizationId: run.organizationId,
      userId: run.requestedBy,
      featureId: "signals",
    }))
  ) {
    return "paused";
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
    return "absent";
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
  return "emitted";
};

/**
 * Emit inside the finalize transaction. A persistence failure must abort the
 * finalize CAS so the durable review run remains retryable; completing the
 * review without its signal would make the missing notification permanent.
 */
export const maybeEmitDocumentReviewSignal = async (
  args: EmitDocumentReviewSignalArgs,
): Promise<void> => {
  if (!isDeploymentFeatureEnabled("FEATURE_INBOX_DOCUMENT_SCOUTS")) {
    return;
  }
  const source = (
    await args.tx
      .select({ organizationId: documentReviewRuns.organizationId })
      .from(documentReviewRuns)
      .where(
        and(
          eq(documentReviewRuns.id, args.runId),
          eq(documentReviewRuns.workspaceId, args.workspaceId),
        ),
      )
      .limit(1)
  ).at(0);
  if (!source) {
    return;
  }
  await lockFeatureRecoveryAdmission({
    tx: args.tx,
    organizationId: source.organizationId,
    featureId: "signals",
  });
  const recorded = await mutateRecoveryReceipt({
    type: "create-review",
    tx: args.tx,
    table: pendingScoutEmissions,
    rows: [
      {
        organizationId: source.organizationId,
        workspaceId: args.workspaceId,
        sourceKind: "document-review",
        sourceId: args.runId,
      },
    ],
  });
  const outcome = await emitDocumentReviewSignal(args);
  if (outcome === "paused") {
    return;
  }
  const ownReceipt = recorded.at(0);
  if (!ownReceipt) {
    return;
  }
  await mutateRecoveryReceipt({
    type: "dequeue-scout",
    tx: args.tx,
    table: pendingScoutEmissions,
    where: sql`${and(
      eq(pendingScoutEmissions.organizationId, source.organizationId),
      eq(pendingScoutEmissions.sourceKind, "document-review"),
      eq(pendingScoutEmissions.sourceId, args.runId),
      sql`${pendingScoutEmissions.nextAttemptAt} = ${ownReceipt.nextAttemptAt}::timestamptz`,
    )}`,
  });
};
