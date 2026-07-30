import { and, eq, or } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { documentProcessingRuns, entities, workspaces } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";

const OCR_PROCESSOR_VERSION = 1;

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
      .innerJoin(
        workspaces,
        and(
          eq(workspaces.id, entities.workspaceId),
          eq(workspaces.organizationId, organizationId),
        ),
      )
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
      const existing = await tx.query.documentProcessingRuns.findFirst({
        where: {
          organizationId: { eq: organizationId },
          workspaceId: { eq: workspaceId },
          entityId: { eq: source.entityId },
          entityVersionId: { eq: source.entityVersionId },
          fieldId: { eq: source.fieldId },
          sourceFileId: { eq: source.sourceFileId },
          sourceSha256Hex: { eq: source.sourceSha256Hex },
          kind: { eq: "ocr" },
          processorVersion: { eq: OCR_PROCESSOR_VERSION },
        },
        columns: { errorCode: true, id: true, status: true },
      });
      const canRetry =
        existing?.status === "failed" ||
        (existing?.status === "cancelled" &&
          (existing.errorCode === "policy_disabled" ||
            existing.errorCode === "source_superseded" ||
            existing.errorCode === "workspace_unavailable"));
      if (!existing || !canRetry) {
        run = existing ?? null;
      } else {
        const retried = await tx
          .update(documentProcessingRuns)
          .set({
            errorAt: null,
            errorCode: null,
            finishedAt: null,
            nextAttemptAt: null,
            requestSource: "manual",
            requestedBy: userId,
            status: "queued",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(documentProcessingRuns.id, existing.id),
              or(
                eq(documentProcessingRuns.status, "failed"),
                and(
                  eq(documentProcessingRuns.status, "cancelled"),
                  or(
                    eq(documentProcessingRuns.errorCode, "policy_disabled"),
                    eq(documentProcessingRuns.errorCode, "source_superseded"),
                    eq(
                      documentProcessingRuns.errorCode,
                      "workspace_unavailable",
                    ),
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
    return run;
  });
