import { panic } from "better-result";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  documentProcessingRuns,
  entities,
  extractedContent,
  fields,
  workspaces,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  withAggregateRowQuery,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { lockForWrite } from "@/api/lib/db/lock-for-write";
import { transition } from "@/api/lib/db/transitions";
import { isExactOcrProjection } from "@/api/lib/document-processing-automatic-request-state";
import {
  DOCUMENT_OCR_PROCESSOR_VERSION,
  DOCUMENT_PROCESSING_MAX_ATTEMPTS,
} from "@/api/lib/document-processing-contract";
import { DOCUMENT_PROCESSING_RETRY_TRANSITIONS } from "@/api/lib/document-processing-retry";

const RETRYABLE_MANUAL_OCR_CANCELLATION_CODES = [
  "policy_disabled",
  "manual_selection_superseded",
  "source_superseded",
  "workspace_unavailable",
] as const;
const SEARCH_INDEX_FAILURE_CODE = "search_index_failed";

const restorableRunFilter = () =>
  or(
    eq(documentProcessingRuns.status, "succeeded"),
    and(
      eq(documentProcessingRuns.status, "failed"),
      lt(documentProcessingRuns.attemptCount, DOCUMENT_PROCESSING_MAX_ATTEMPTS),
      eq(documentProcessingRuns.errorCode, SEARCH_INDEX_FAILURE_CODE),
    ),
    and(
      eq(documentProcessingRuns.status, "cancelled"),
      inArray(
        documentProcessingRuns.errorCode,
        RETRYABLE_MANUAL_OCR_CANCELLATION_CODES,
      ),
    ),
  );

type RestoreManualOcrRunOptions = {
  db: { transaction: ScopedDb };
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  sourceFileId: string;
  sourceSha256Hex: string;
  workspaceId: SafeId<"workspace">;
};

export const restoreManualOcrRunAfterProjectionLoss = async ({
  entityId,
  entityVersionId,
  fieldId,
  organizationId,
  sourceFileId,
  sourceSha256Hex,
  workspaceId,
  db,
}: RestoreManualOcrRunOptions): Promise<void> => {
  await withAggregateTransaction(db, async (tx) => {
    const parents = await lockForWrite(tx, {
      organizationIds: [organizationId],
    });
    if (!parents.organizationIds.has(organizationId)) {
      return;
    }

    const workspaceRows = (
      await withAggregateRowQuery({
        tx,
        aggregate: "workspace",
        id: { id: workspaceId, organizationId },
        mode: "no key update",
        select: (lockTx) =>
          lockTx
            .select({
              id: workspaces.id,
              organizationId: workspaces.organizationId,
            })
            .from(workspaces),
        where: eq(workspaces.status, "active"),
      })
    ).rows;
    if (!workspaceRows.at(0)) {
      return;
    }
    const currentRows = (
      await withAggregateRowQuery({
        tx,
        aggregate: "entity",
        id: { id: entityId, workspaceId },
        mode: "update",
        select: (lockTx) =>
          lockTx
            .select({ id: entities.id, workspaceId: entities.workspaceId })
            .from(entities),
        where: sql`${entities.currentVersionId} = ${entityVersionId} AND ${entities.readOnly} = false`,
      })
    ).rows;
    if (!currentRows.at(0)) {
      return;
    }
    const sourceFieldRows = await tx
      .select({ content: fields.content })
      .from(fields)
      .where(
        and(
          eq(fields.id, fieldId),
          eq(fields.workspaceId, workspaceId),
          eq(fields.entityVersionId, entityVersionId),
        ),
      )
      .limit(1);
    const sourceField = sourceFieldRows.at(0);
    if (
      sourceField?.content.type !== "file" ||
      sourceField.content.id !== sourceFileId ||
      sourceField.content.sha256Hex !== sourceSha256Hex
    ) {
      return;
    }

    const existingRows = await tx
      .select({
        id: documentProcessingRuns.id,
      })
      .from(documentProcessingRuns)
      .where(
        and(
          eq(documentProcessingRuns.organizationId, organizationId),
          eq(documentProcessingRuns.workspaceId, workspaceId),
          eq(documentProcessingRuns.entityId, entityId),
          eq(documentProcessingRuns.entityVersionId, entityVersionId),
          eq(documentProcessingRuns.fieldId, fieldId),
          eq(documentProcessingRuns.sourceFileId, sourceFileId),
          eq(documentProcessingRuns.sourceSha256Hex, sourceSha256Hex),
          eq(documentProcessingRuns.kind, "ocr"),
          eq(documentProcessingRuns.requestSource, "manual"),
          eq(
            documentProcessingRuns.processorVersion,
            DOCUMENT_OCR_PROCESSOR_VERSION,
          ),
        ),
      )
      .limit(1);
    const identity = existingRows.at(0);
    const locked = identity
      ? await withAggregateRowQuery({
          tx,
          aggregate: "processingClaim",
          id: { id: identity.id, workspaceId },
          mode: "update",
          select: (queryTx) =>
            queryTx
              .select({
                id: documentProcessingRuns.id,
                workspaceId: documentProcessingRuns.workspaceId,
                status: documentProcessingRuns.status,
                attemptCount: documentProcessingRuns.attemptCount,
              })
              .from(documentProcessingRuns),
          where:
            restorableRunFilter() ??
            panic("Missing manual OCR restore predicate"),
        })
      : null;
    const existing = locked?.rows.at(0);
    if (!existing) {
      return;
    }

    const projectionRows = await tx
      .select({
        ocrRunId: extractedContent.ocrRunId,
        sourceEntityVersionId: extractedContent.sourceEntityVersionId,
        sourceFieldId: extractedContent.sourceFieldId,
        sourceFileId: extractedContent.sourceFileId,
        sourceSha256Hex: extractedContent.sourceSha256Hex,
      })
      .from(extractedContent)
      .where(
        and(
          eq(extractedContent.entityId, entityId),
          eq(extractedContent.organizationId, organizationId),
          eq(extractedContent.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (
      isExactOcrProjection({
        projection: projectionRows.at(0) ?? null,
        run: existing,
        source: {
          entityVersionId,
          fieldId,
          sourceFileId,
          sourceSha256Hex,
        },
      })
    ) {
      return;
    }

    const changed = await transition({
      tx,
      spec: DOCUMENT_PROCESSING_RETRY_TRANSITIONS,
      id: existing.id,
      options: {
        from: ["failed", "succeeded", "cancelled"],
        to: "queued",
        set: {
          attemptCount:
            existing.status === "failed" ? existing.attemptCount : 0,
          claimedAt: null,
          claimedBy: null,
          errorAt: null,
          errorCode: null,
          errorMessage: null,
          finishedAt: null,
          nextAttemptAt: null,
          nextDeliveryAt: null,
          progressCompleted: 0,
          progressTotal: null,
          startedAt: null,
          updatedAt: new Date(),
        },
      },
      // Projection repair changes worker bookkeeping; the manual request owns its audit event.
      recordTransitionAuditEvent: async () => await Promise.resolve(),
    });
    switch (changed.type) {
      case "transitioned":
        return;
      case "stale":
        break;
      default:
        changed satisfies never;
        panic("Unknown document processing transition outcome");
    }
    panic("Locked manual OCR run changed during projection repair");
  });
};
