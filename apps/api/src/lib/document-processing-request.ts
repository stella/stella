import { and, eq, inArray, ne, or } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import {
  documentProcessingRuns,
  entities,
  extractedContent,
  fields,
  workspaces,
} from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";

const OCR_PROCESSOR_VERSION = 1;
const RETRYABLE_MANUAL_OCR_CANCELLATION_CODES = [
  "policy_disabled",
  "manual_selection_superseded",
  "source_superseded",
  "workspace_unavailable",
] as const;
const MANUAL_SELECTION_SUPERSEDED_CODE =
  RETRYABLE_MANUAL_OCR_CANCELLATION_CODES[1];

export type ManualOcrSource = {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  sourceFileId: string;
  sourceSha256Hex: string;
};

export type PersistedDocumentProcessingRun = {
  id: (typeof documentProcessingRuns.$inferSelect)["id"];
  status: (typeof documentProcessingRuns.$inferSelect)["status"];
};

export type PersistManualOcrRunOptions = {
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  source: ManualOcrSource;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

export const persistManualOcrRun = async ({
  organizationId,
  recordAuditEvent,
  source,
  userId,
  workspaceId,
}: PersistManualOcrRunOptions): Promise<PersistedDocumentProcessingRun | null> =>
  await rootDb.transaction(async (tx) => {
    // Re-check and lock the mutable entity under the root write. The scoped
    // validation above authorizes the request; this prevents a concurrent
    // version replacement from queuing OCR for a no-longer-current file.
    const currentRows = await tx
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          eq(entities.id, source.entityId),
          eq(entities.workspaceId, workspaceId),
          eq(entities.currentVersionId, source.entityVersionId),
          eq(entities.readOnly, false),
        ),
      )
      .limit(1)
      .for("update");
    if (!currentRows.at(0)) {
      return null;
    }
    const workspaceRows = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, workspaceId),
          eq(workspaces.organizationId, organizationId),
          eq(workspaces.status, "active"),
        ),
      )
      .limit(1)
      .for("update");
    if (!workspaceRows.at(0)) {
      return null;
    }
    const sourceFieldRows = await tx
      .select({ content: fields.content })
      .from(fields)
      .where(
        and(
          eq(fields.id, source.fieldId),
          eq(fields.workspaceId, workspaceId),
          eq(fields.entityVersionId, source.entityVersionId),
        ),
      )
      .limit(1);
    const sourceField = sourceFieldRows.at(0);
    if (
      sourceField?.content.type !== "file" ||
      sourceField.content.id !== source.sourceFileId ||
      sourceField.content.sha256Hex !== source.sourceSha256Hex
    ) {
      return null;
    }

    const inserted = await tx
      .insert(documentProcessingRuns)
      .values({
        id: createSafeId<"documentProcessingRun">(),
        organizationId,
        workspaceId,
        entityId: source.entityId,
        entityVersionId: source.entityVersionId,
        fieldId: source.fieldId,
        sourceFileId: source.sourceFileId,
        sourceSha256Hex: source.sourceSha256Hex,
        kind: "ocr",
        processorVersion: OCR_PROCESSOR_VERSION,
        requestSource: "manual",
        requestedBy: userId,
      })
      .onConflictDoNothing({
        target: [
          documentProcessingRuns.organizationId,
          documentProcessingRuns.kind,
          documentProcessingRuns.entityVersionId,
          documentProcessingRuns.fieldId,
          documentProcessingRuns.sourceFileId,
          documentProcessingRuns.sourceSha256Hex,
          documentProcessingRuns.processorVersion,
        ],
      })
      .returning({
        id: documentProcessingRuns.id,
        status: documentProcessingRuns.status,
      });
    let run: PersistedDocumentProcessingRun | null = inserted.at(0) ?? null;
    if (!run) {
      const existingRows = await tx
        .select({
          errorCode: documentProcessingRuns.errorCode,
          id: documentProcessingRuns.id,
          status: documentProcessingRuns.status,
        })
        .from(documentProcessingRuns)
        .where(
          and(
            eq(documentProcessingRuns.organizationId, organizationId),
            eq(documentProcessingRuns.workspaceId, workspaceId),
            eq(documentProcessingRuns.entityId, source.entityId),
            eq(documentProcessingRuns.entityVersionId, source.entityVersionId),
            eq(documentProcessingRuns.fieldId, source.fieldId),
            eq(documentProcessingRuns.sourceFileId, source.sourceFileId),
            eq(documentProcessingRuns.sourceSha256Hex, source.sourceSha256Hex),
            eq(documentProcessingRuns.kind, "ocr"),
            eq(documentProcessingRuns.processorVersion, OCR_PROCESSOR_VERSION),
          ),
        )
        .limit(1)
        .for("update");
      const existing = existingRows.at(0);
      const matchingProjection =
        existing?.status === "succeeded"
          ? await tx
              .select({ entityId: extractedContent.entityId })
              .from(extractedContent)
              .where(
                and(
                  eq(extractedContent.organizationId, organizationId),
                  eq(extractedContent.workspaceId, workspaceId),
                  eq(extractedContent.entityId, source.entityId),
                  eq(
                    extractedContent.sourceEntityVersionId,
                    source.entityVersionId,
                  ),
                  eq(extractedContent.sourceFieldId, source.fieldId),
                  eq(extractedContent.sourceFileId, source.sourceFileId),
                  eq(extractedContent.sourceSha256Hex, source.sourceSha256Hex),
                ),
              )
              .limit(1)
          : [];
      const needsProjectionRestore =
        existing?.status === "succeeded" && !matchingProjection.at(0);
      const canRetry =
        existing?.status === "failed" ||
        needsProjectionRestore ||
        (existing?.status === "cancelled" &&
          RETRYABLE_MANUAL_OCR_CANCELLATION_CODES.some(
            (errorCode) => errorCode === existing.errorCode,
          ));
      if (!existing || !canRetry) {
        run = existing ?? null;
      } else {
        const retried = await tx
          .update(documentProcessingRuns)
          .set({
            requestSource: "manual",
            requestedBy: userId,
            updatedAt: new Date(),
            claimedAt: null,
            claimedBy: null,
            errorAt: null,
            errorCode: null,
            finishedAt: null,
            nextAttemptAt: null,
            progressCompleted: 0,
            progressTotal: null,
            startedAt: null,
            status: "queued",
          })
          .where(
            and(
              eq(documentProcessingRuns.id, existing.id),
              or(
                eq(documentProcessingRuns.status, "failed"),
                eq(documentProcessingRuns.status, "succeeded"),
                and(
                  eq(documentProcessingRuns.status, "cancelled"),
                  inArray(
                    documentProcessingRuns.errorCode,
                    RETRYABLE_MANUAL_OCR_CANCELLATION_CODES,
                  ),
                ),
              ),
            ),
          )
          .returning({
            id: documentProcessingRuns.id,
            status: documentProcessingRuns.status,
          });
        run = retried.at(0) ?? existing;
      }
    }

    const ownsManualSelection =
      run?.status === "queued" ||
      run?.status === "running" ||
      run?.status === "succeeded";
    if (run && ownsManualSelection) {
      const supersededAt = new Date();
      // Manual requests serialize on the entity lock acquired above. Retire
      // every earlier selection before acknowledging this one; an older worker
      // already outside the transaction is fenced by its status/claim CAS when
      // it returns to persist the projection.
      await tx
        .update(documentProcessingRuns)
        .set({
          claimedAt: null,
          claimedBy: null,
          errorAt: supersededAt,
          errorCode: MANUAL_SELECTION_SUPERSEDED_CODE,
          finishedAt: supersededAt,
          nextAttemptAt: null,
          status: "cancelled",
          updatedAt: supersededAt,
        })
        .where(
          and(
            eq(documentProcessingRuns.organizationId, organizationId),
            eq(documentProcessingRuns.workspaceId, workspaceId),
            eq(documentProcessingRuns.entityId, source.entityId),
            eq(documentProcessingRuns.entityVersionId, source.entityVersionId),
            eq(documentProcessingRuns.kind, "ocr"),
            eq(documentProcessingRuns.requestSource, "manual"),
            ne(documentProcessingRuns.id, run.id),
            inArray(documentProcessingRuns.status, ["queued", "running"]),
          ),
        );
    }

    if (run) {
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.EXECUTE,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: source.entityId,
        metadata: {
          fieldId: source.fieldId,
          operation: "ocr",
          runId: run.id,
        },
      });
    }
    return run ? { id: run.id, status: run.status } : null;
  });
