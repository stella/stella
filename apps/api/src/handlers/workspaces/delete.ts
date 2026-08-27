import { Result } from "better-result";
import { and, eq, inArray, ne } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  chatThreads,
  documentProcessingRuns,
  entities,
  entityVersions,
  fields,
  pendingUploads,
  properties,
  propertyDependencies,
  userFiles,
  workspaces,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { preserveBufferObjectCleanupIntents } from "@/api/lib/buffer-intent-reconciliation";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { THUMBNAIL_MIME_TYPE } from "@/api/lib/files/image-derivative";
import {
  createOcrSearchablePdfKey,
  createUserFileKey,
  deleteS3Keys,
  deleteS3Objects,
} from "@/api/lib/files/utils";
import {
  forEachOcrDerivativePage,
  ocrDerivativeCursorFilter,
  ocrDerivativePageOrder,
} from "@/api/lib/ocr-derivative-pages";
import {
  cancelRecoverableUploads,
  pendingUploadS3KeysForDeletion,
} from "@/api/lib/pending-upload-keys";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const changeWorkspaceStatus = async (
  scopedDb: ScopedDb,
  workspaceId: SafeId<"workspace">,
  newStatus: "deleting" | "active",
): Promise<boolean> =>
  await scopedDb(async (tx) => {
    // Lock the workspace before inspecting dispatches. OCR takes this same
    // lock immediately before it claims a run, so a delete either seals first
    // or observes the in-flight run and leaves the workspace active.
    const workspaceRows = await tx
      .select({ id: workspaces.id, status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
      .for("update");
    const workspace = workspaceRows.at(0);
    if (!workspace) {
      return false;
    }
    // Only one request may own the deletion seal. A concurrent request must
    // not proceed to its own snapshot or later reactivate this workspace when
    // its cleanup fails.
    if (newStatus === "deleting" && workspace.status === "deleting") {
      return false;
    }
    if (newStatus === "deleting") {
      const runningOcrRuns = await tx
        .select({ id: documentProcessingRuns.id })
        .from(documentProcessingRuns)
        .where(
          and(
            eq(documentProcessingRuns.workspaceId, workspaceId),
            eq(documentProcessingRuns.status, "running"),
          ),
        )
        .limit(1);
      if (runningOcrRuns.at(0)) {
        return false;
      }
    }

    // audit: skip — internal seal/unseal toggle wrapping the workspace
    // delete; the audited DELETE below records the user-visible event.
    await tx
      .update(workspaces)
      .set({ status: newStatus })
      .where(eq(workspaces.id, workspaceId));
    return true;
  });

type FileRef = { fileId: string; mimeType: string };

/** Extract source and converted-PDF refs from file content. */
const extractFileRefs = (content: FieldContent): FileRef[] => {
  if (content.type !== "file") {
    return [];
  }

  const refs: FileRef[] = [{ fileId: content.id, mimeType: content.mimeType }];

  if (content.pdfFileId) {
    refs.push({
      fileId: content.pdfFileId,
      mimeType: PDF_MIME_TYPE,
    });
  }

  if (content.thumbnailFileId) {
    refs.push({
      fileId: content.thumbnailFileId,
      mimeType: THUMBNAIL_MIME_TYPE,
    });
  }

  return refs;
};

const deleteWorkspaceOcrDerivatives = async ({
  organizationId,
  safeDb,
  workspaceId,
}: {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
}): Promise<void> =>
  await forEachOcrDerivativePage({
    readPage: async (cursor, limit) => {
      const result = await safeDb(
        async (tx) =>
          await tx
            .select({ id: documentProcessingRuns.id })
            .from(documentProcessingRuns)
            .where(
              and(
                eq(documentProcessingRuns.workspaceId, workspaceId),
                ocrDerivativeCursorFilter(cursor),
              ),
            )
            .orderBy(...ocrDerivativePageOrder())
            .limit(limit),
      );
      return Result.unwrap(result, "Matter OCR derivative query failed");
    },
    onPage: async (runs) => {
      const result = await deleteS3Keys(
        runs.map(({ id }) =>
          createOcrSearchablePdfKey({
            organizationId,
            workspaceId,
            runId: id,
          }),
        ),
      );
      Result.unwrap(result, "Matter OCR derivative cleanup failed");
    },
  });

const config = {
  description:
    "Permanently delete a matter and all its documents, tasks, fields, and " +
    "chat history. This is irreversible.",
  permissions: { workspace: ["delete"] },
  mcp: { type: "tool", name: "delete_matter" },
} satisfies HandlerConfig;

export type DeleteWorkspaceHandlerProps = {
  scopedDb: ScopedDb;
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
};

// Shared matter-delete logic reused by the HTTP handler and the
// `delete_matter` MCP tool, so both emit identical audit events and
// storage cleanup.
// eslint-disable-next-line require-yield -- manual Result.isError checks preserve rollback semantics
export const deleteWorkspaceHandler = async function* ({
  scopedDb,
  safeDb,
  workspaceId,
  organizationId,
  recordAuditEvent,
}: DeleteWorkspaceHandlerProps) {
  // Seal workspace: no new uploads.
  // Uses scopedDb so the rollback helper can restore on failure.
  const sealed = await changeWorkspaceStatus(scopedDb, workspaceId, "deleting");
  if (!sealed) {
    return Result.err(
      new HandlerError({
        status: 409,
        message:
          "Wait for document processing or another deletion attempt to finish",
      }),
    );
  }

  // Query file metadata from fields.content JSONB.
  // Workspace is sealed by status: "deleting", so no
  // concurrent uploads can insert new files.
  const fileQueryResult = await safeDb(async (tx) => {
    // Cancel every non-finalized upload before enumerating its keys, closing
    // the publish-vs-cascade race rather than merely snapshotting recovery
    // intents before deleting their rows.
    await cancelRecoverableUploads(tx, [workspaceId]);

    const workspaceEntityVersionIds = tx
      .select({ id: entityVersions.id })
      .from(entityVersions)
      .innerJoin(entities, eq(entityVersions.entityId, entities.id))
      .where(eq(entities.workspaceId, workspaceId));

    const fileRefsPromise = tx
      .select({ content: fields.content })
      .from(fields)
      .where(inArray(fields.entityVersionId, workspaceEntityVersionIds))
      .then((fieldRows) =>
        fieldRows.flatMap((row) => extractFileRefs(row.content)),
      );

    const chatFileRefsPromise = tx
      .select({
        id: userFiles.id,
        s3Key: userFiles.s3Key,
        thumbnailFileId: userFiles.thumbnailFileId,
        userId: userFiles.userId,
      })
      .from(userFiles)
      .innerJoin(chatThreads, eq(userFiles.threadId, chatThreads.id))
      .where(eq(chatThreads.workspaceId, workspaceId));

    const pendingUploadRowsPromise = tx
      .select({
        declaredMime: pendingUploads.declaredMime,
        id: pendingUploads.id,
        organizationId: pendingUploads.organizationId,
        purpose: pendingUploads.purpose,
        purposeData: pendingUploads.purposeData,
        status: pendingUploads.status,
        workspaceId: pendingUploads.workspaceId,
      })
      .from(pendingUploads)
      .where(
        and(
          eq(pendingUploads.workspaceId, workspaceId),
          ne(pendingUploads.status, "finalized"),
        ),
      );

    const result = await Promise.all([
      fileRefsPromise,
      chatFileRefsPromise,
      pendingUploadRowsPromise,
    ]);
    await preserveBufferObjectCleanupIntents(
      tx,
      result[2].filter(
        ({ status }) => status === "scanning" || status === "failed",
      ),
    );
    return result;
  });

  if (Result.isError(fileQueryResult)) {
    await changeWorkspaceStatus(scopedDb, workspaceId, "active");
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Failed to query workspace files",
        cause: fileQueryResult.error,
      }),
    );
  }

  const [fileRefs, chatFileRefs, pendingUploadRows] = fileQueryResult.value;

  // Delete S3 objects outside any transaction.
  // On retry, already-deleted S3 objects are no-ops.
  const s3Deletes: Promise<void>[] = [];

  if (fileRefs.length > 0) {
    s3Deletes.push(
      deleteS3Objects({
        fileRows: fileRefs,
        organizationId,
        workspaceId,
      }).then((result) =>
        Result.unwrap(result, "Workspace entity file cleanup failed"),
      ),
    );
  }

  if (chatFileRefs.length > 0) {
    s3Deletes.push(
      deleteS3Keys(
        chatFileRefs.flatMap((file) =>
          file.thumbnailFileId
            ? [
                file.s3Key,
                createUserFileKey({
                  fileId: file.thumbnailFileId,
                  mimeType: THUMBNAIL_MIME_TYPE,
                  userId: brandPersistedUserId(file.userId),
                }),
              ]
            : [file.s3Key],
        ),
      ).then((result) =>
        Result.unwrap(result, "Workspace chat file cleanup failed"),
      ),
    );
  }

  if (pendingUploadRows.length > 0) {
    s3Deletes.push(
      deleteS3Keys(
        pendingUploadRows.flatMap(pendingUploadS3KeysForDeletion),
      ).then((result) =>
        Result.unwrap(result, "Workspace pending upload cleanup failed"),
      ),
    );
  }

  s3Deletes.push(
    deleteWorkspaceOcrDerivatives({
      organizationId,
      safeDb,
      workspaceId,
    }),
  );

  const s3Result = await Result.tryPromise({
    try: async () => await Promise.all(s3Deletes),
    catch: (cause) => cause,
  });

  if (Result.isError(s3Result)) {
    await changeWorkspaceStatus(scopedDb, workspaceId, "active");
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Failed to delete workspace files from storage",
        cause: s3Result.error,
      }),
    );
  }

  // All S3 objects are gone. Delete DB records in a
  // single transaction.
  const deleteResult = await safeDb(async (tx) => {
    const workspaceRows = await tx
      .select({
        id: workspaces.id,
        name: workspaces.name,
        reference: workspaces.reference,
        clientId: workspaces.clientId,
        billingReference: workspaces.billingReference,
        color: workspaces.color,
        status: workspaces.status,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for("update");
    const workspace = workspaceRows.at(0);

    if (!workspace) {
      return;
    }

    if (chatFileRefs.length > 0) {
      await tx.delete(userFiles).where(
        inArray(
          userFiles.id,
          chatFileRefs.map((file) => file.id),
        ),
      );
    }

    await tx
      .delete(chatThreads)
      .where(eq(chatThreads.workspaceId, workspaceId));

    // Delete property dependencies (restrict FK prevents
    // cascade, so explicit cleanup is needed).
    const workspacePropertyIds = tx
      .select({ id: properties.id })
      .from(properties)
      .where(eq(properties.workspaceId, workspaceId));

    await tx
      .delete(propertyDependencies)
      .where(
        inArray(propertyDependencies.dependsOnPropertyId, workspacePropertyIds),
      );

    // Delete entities: cascades to entityVersions ->
    // fields -> justifications.
    await tx.delete(entities).where(eq(entities.workspaceId, workspaceId));

    // Clear lastActiveWorkspaceId for members pointing
    // to this workspace (no FK constraint due to
    // circular schema dependency).
    await tx
      .update(member)
      .set({ lastActiveWorkspaceId: null })
      .where(eq(member.lastActiveWorkspaceId, workspaceId));

    // Delete workspace: cascades to properties ->
    // propertyDependencies. Entities already gone.
    await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.DELETE,
      resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
      resourceId: workspaceId,
      changes: {
        deleted: {
          old: workspace,
          new: null,
        },
      },
    });
  });

  if (Result.isError(deleteResult)) {
    await changeWorkspaceStatus(scopedDb, workspaceId, "active");
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Failed to delete workspace records",
        cause: deleteResult.error,
      }),
    );
  }

  return Result.ok({});
};

const deleteWorkspace = createSafeHandler(
  config,
  async function* ({
    scopedDb,
    safeDb,
    workspaceId,
    session,
    recordAuditEvent,
  }) {
    return yield* deleteWorkspaceHandler({
      scopedDb,
      safeDb,
      workspaceId,
      organizationId: session.activeOrganizationId,
      recordAuditEvent,
    });
  },
);

export default deleteWorkspace;
