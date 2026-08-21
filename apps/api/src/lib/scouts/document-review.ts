import { and, eq } from "drizzle-orm";

import { SIGNAL_KIND, SUGGESTION_KIND } from "@stll/api-contract/signals";

import type { Transaction } from "@/api/db/root";
import {
  documentReviewFindings,
  documentReviewRuns,
  entities,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { DOCUMENT_REVIEW_FINDINGS_PER_RUN_MAX } from "@/api/lib/document-review/run-contract";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import {
  REVIEW_FINDINGS_SHOWN_MAX,
  REVIEW_SIGNAL_CONFIDENCE,
  reviewDedupeKey,
  reviewSignalSeverity,
  reviewVerdict,
  toReviewSignalFindings,
} from "@/api/lib/scouts/document-review.logic";
import { emitSignals } from "@/api/lib/signals/emit";
import { SCOUT_KEY } from "@/api/lib/signals/scout";

const documentScoutsEnabled = (): boolean =>
  env.isDev || env.FEATURE_INBOX_DOCUMENT_SCOUTS;

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
 * Boundary wrapper for the finalize path: a scout failure is logged and
 * captured but never rolls back the run's completion.
 */
export const maybeEmitDocumentReviewSignal = async (
  args: EmitDocumentReviewSignalArgs,
): Promise<void> => {
  if (!documentScoutsEnabled()) {
    return;
  }
  try {
    // Savepoint: a failed statement here must not poison the outer
    // transaction that is finalizing the run.
    await args.tx.transaction((savepoint) =>
      emitDocumentReviewSignal({ ...args, tx: savepoint }),
    );
  } catch (error: unknown) {
    captureError(error, {
      scout: SCOUT_KEY.DOCUMENT_REVIEW,
      runId: args.runId,
    });
    logger.error("scout.document_review.failed", {
      "run.id": args.runId,
      "workspace.id": args.workspaceId,
      "error.type": errorTag(error),
    });
  }
};
