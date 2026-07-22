/**
 * Write a new entity version from an already-built DOCX buffer -- the
 * write-back half of `loadEntityVersionDocxBuffer`. Mirrors
 * `upload-version.ts`'s S3-write -> locked-transaction -> fire-and-forget
 * pattern, generalized for a caller that already has bytes in hand (an
 * AI-transformed buffer) rather than an uploaded `File`.
 *
 * Used today only by `edit_workspace_document` (`edit-workspace-document-
 * tools.ts`). `upload-version.ts`, `folio-collab`'s finalize handler, and
 * `finalize-desktop-edit-session.ts` implement the same new-version pattern
 * inline; they are NOT refactored onto this helper in this change.
 * TODO: fold those three call sites onto this helper once it has a second
 * caller confirming the abstraction holds.
 */

import { Result, TaggedError } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  cellMetadata,
  desktopEditSessions,
  entities,
  entityVersions,
  fileChatThreads,
  fields,
  folioCollabSessions,
  workspaces,
} from "@/api/db/schema";
import { computeVersionDiffStats } from "@/api/handlers/entities/compute-version-diff";
import { lockDocxEditTarget } from "@/api/handlers/entities/desktop-edit-session-utils";
import {
  buildVersionStamp,
  cloneFieldsForRevision,
  nextEntityVersionNumber,
} from "@/api/handlers/entities/version-utils";
import {
  allocateFileObject,
  fileContentWithMintedObject,
} from "@/api/handlers/files/file-object-ids";
import { pdfDerivativeStateForFile } from "@/api/handlers/files/gotenberg";
import { thumbnailDerivativeStateForFile } from "@/api/handlers/files/image-derivative";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics/capture";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { liveDesktopEditSessionPredicates } from "@/api/lib/desktop-edit-session-predicates";
import { detached } from "@/api/lib/detached";
import {
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
} from "@/api/lib/file-derivative-queue";
import { isFolioCollabSessionExpired } from "@/api/lib/folio-collab-sessions";
import { LIMITS } from "@/api/lib/limits";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { getS3 } from "@/api/lib/s3";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { broadcast } from "@/api/lib/sse";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

type CreateEntityVersionFromBufferOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  expectedCurrentVersionId: SafeId<"entityVersion">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  /** The already-transformed DOCX bytes to write as the new version. */
  buffer: ArrayBuffer;
  /** Preserved verbatim from the version being replaced. */
  fileName: string;
  /** The file property to replace; every other field is cloned as-is. */
  filePropertyId: SafeId<"property">;
  /** The current file field whose chat mapping must follow the replacement. */
  replacedFileFieldId: SafeId<"field">;
};

export type CreateEntityVersionFromBufferSuccess = {
  entityVersionId: SafeId<"entityVersion">;
  versionNumber: number;
  fieldId: SafeId<"field">;
};

type CreateEntityVersionFromBufferFailureReason =
  | "entityNotFound"
  | "entityReadOnly"
  | "editSessionOpen"
  | "currentVersionChanged"
  | "currentVersionNotFound"
  | "workspaceNotActive";

const FAILURE_REASON_MESSAGES: Record<
  CreateEntityVersionFromBufferFailureReason,
  string
> = {
  entityNotFound: "Document not found",
  entityReadOnly: "Document is read-only",
  editSessionOpen:
    "The document has an active edit session; use manual review or close the session before automatic edits",
  currentVersionChanged:
    "The document changed while edits were being applied; retry against the current version",
  currentVersionNotFound: "Current document version not found",
  workspaceNotActive: "The document's matter is archived or unavailable",
};

export class CreateEntityVersionFromBufferError extends TaggedError(
  "CreateEntityVersionFromBufferError",
)<{
  message: string;
  reason: CreateEntityVersionFromBufferFailureReason;
}>() {}

class EntityVersionBufferCleanupError extends TaggedError(
  "EntityVersionBufferCleanupError",
)<{
  message: string;
  cause: unknown;
}>() {}

type WriteTxResult =
  | { status: "ok"; versionNumber: number }
  | { status: CreateEntityVersionFromBufferFailureReason };

/**
 * Write `buffer` as a new version of `entityId`, replacing the file field
 * at `filePropertyId` and carrying every other field forward
 * (`cloneFieldsForRevision`). Validates the entity isn't read-only under a
 * `FOR UPDATE` lock (same TOCTOU guard `upload-version.ts` applies), and
 * cleans up the just-written S3 object on any failure path so a rejected
 * write never orphans bytes.
 *
 * Extraction, PDF/thumbnail derivatives, and diff-stat computation run
 * detached (fire-and-forget, captured via `detached()`) after the
 * transaction commits, matching `upload-version.ts`.
 */
export const createEntityVersionFromBuffer = async ({
  safeDb,
  organizationId,
  workspaceId,
  entityId,
  expectedCurrentVersionId,
  userId,
  recordAuditEvent,
  buffer,
  fileName,
  filePropertyId,
  replacedFileFieldId,
}: CreateEntityVersionFromBufferOptions): Promise<
  Result<
    CreateEntityVersionFromBufferSuccess,
    CreateEntityVersionFromBufferError | SafeDbError
  >
> => {
  const bytes = new Uint8Array(buffer);
  const sha256Hex = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const fileId = allocateFileObject();
  const s3Key = createFileKey({
    organizationId,
    workspaceId,
    fileId,
    mimeType: DOCX_MIME_TYPE,
  });
  const nextVersionId = createSafeId<"entityVersion">();
  const fileFieldId = createSafeId<"field">();

  await getS3().write(s3Key, bytes);

  const writeResult = await safeDb(async (tx): Promise<WriteTxResult> => {
    await lockDocxEditTarget({
      entityId,
      propertyId: filePropertyId,
      tx,
      workspaceId,
    });

    const now = new Date();
    const liveDesktopSessions = await tx
      .select({ id: desktopEditSessions.id })
      .from(desktopEditSessions)
      .where(
        and(
          eq(desktopEditSessions.entityId, entityId),
          eq(desktopEditSessions.propertyId, filePropertyId),
          eq(desktopEditSessions.workspaceId, workspaceId),
          ...liveDesktopEditSessionPredicates(now),
        ),
      )
      .limit(1);
    if (liveDesktopSessions.at(0)) {
      return { status: "editSessionOpen" };
    }

    const openCollabSessions = await tx
      .select({
        createdAt: folioCollabSessions.createdAt,
        id: folioCollabSessions.id,
      })
      .from(folioCollabSessions)
      .where(
        and(
          eq(folioCollabSessions.entityId, entityId),
          eq(folioCollabSessions.propertyId, filePropertyId),
          eq(folioCollabSessions.status, "open"),
          eq(folioCollabSessions.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    const openCollabSession = openCollabSessions.at(0);
    if (
      openCollabSession &&
      !isFolioCollabSessionExpired(openCollabSession.createdAt, now)
    ) {
      return { status: "editSessionOpen" };
    }

    const entityRows = await tx
      .select({
        currentVersionId: entities.currentVersionId,
        docSequence: entities.docSequence,
        readOnly: entities.readOnly,
      })
      .from(entities)
      .where(
        and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
      )
      .limit(1)
      .for("update");
    const lockedEntity = entityRows.at(0);

    if (!lockedEntity?.currentVersionId) {
      return { status: "entityNotFound" };
    }
    if (lockedEntity.readOnly) {
      return { status: "entityReadOnly" };
    }
    if (lockedEntity.currentVersionId !== expectedCurrentVersionId) {
      return { status: "currentVersionChanged" };
    }

    const freshCurrentVersionId = expectedCurrentVersionId;
    const freshCurrentVersion = await tx.query.entityVersions.findFirst({
      where: {
        id: { eq: freshCurrentVersionId },
        entityId: { eq: entityId },
        workspaceId: { eq: workspaceId },
        deletedAt: { isNull: true },
      },
      columns: { id: true },
      with: {
        fields: {
          columns: { content: true, propertyId: true },
          limit: LIMITS.propertiesCount,
        },
      },
    });
    if (!freshCurrentVersion) {
      return { status: "currentVersionNotFound" };
    }

    const workspace = await tx.query.workspaces.findFirst({
      where: { id: { eq: workspaceId } },
      columns: { reference: true, status: true },
    });
    if (workspace?.status !== "active") {
      return { status: "workspaceNotActive" };
    }

    // MAX over all versions (incl. tombstoned) under the entity lock, not
    // currentVersion + 1 -- see nextEntityVersionNumber's own doc comment.
    const nextVersionNumber = await nextEntityVersionNumber(tx, {
      entityId,
      workspaceId,
    });
    const nextVersionStamp = buildVersionStamp({
      docSequence: lockedEntity.docSequence,
      versionNumber: nextVersionNumber,
      workspaceReference: workspace.reference,
    });

    await tx.insert(entityVersions).values({
      createdBy: userId,
      entityId,
      id: nextVersionId,
      stamp: nextVersionStamp.stamp,
      verificationCode: nextVersionStamp.verificationCode,
      versionNumber: nextVersionNumber,
      workspaceId,
    });

    await tx.insert(fields).values(
      cloneFieldsForRevision({
        currentFields: freshCurrentVersion.fields,
        entityVersionId: nextVersionId,
        propertyId: filePropertyId,
        replacementFieldId: fileFieldId,
        replacementContent: fileContentWithMintedObject({
          encrypted: false,
          fileName,
          id: fileId,
          mimeType: DOCX_MIME_TYPE,
          pdfFileId: null,
          sha256Hex,
          sizeBytes: bytes.byteLength,
          type: "file",
          version: 1,
          pdfDerivative: pdfDerivativeStateForFile({
            encrypted: false,
            mimeType: DOCX_MIME_TYPE,
          }),
          thumbnailFileId: null,
          thumbnailDerivative: thumbnailDerivativeStateForFile({
            encrypted: false,
            mimeType: DOCX_MIME_TYPE,
          }),
        }),
        workspaceId,
      }),
    );

    const currentCellMetadataRows = await tx
      .select({
        createdAt: cellMetadata.createdAt,
        createdBy: cellMetadata.createdBy,
        metadata: cellMetadata.metadata,
        propertyId: cellMetadata.propertyId,
        updatedAt: cellMetadata.updatedAt,
        updatedBy: cellMetadata.updatedBy,
      })
      .from(cellMetadata)
      .where(
        and(
          eq(cellMetadata.workspaceId, workspaceId),
          eq(cellMetadata.entityVersionId, freshCurrentVersionId),
        ),
      )
      .for("update");

    const cellMetadataRowsToCopy = currentCellMetadataRows.filter(
      (row) => row.propertyId !== filePropertyId,
    );
    if (cellMetadataRowsToCopy.length > 0) {
      await tx.insert(cellMetadata).values(
        cellMetadataRowsToCopy.map((row) => ({
          workspaceId,
          entityVersionId: nextVersionId,
          propertyId: row.propertyId,
          metadata: row.metadata,
          createdBy: row.createdBy,
          updatedBy: row.updatedBy,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      );
    }

    await tx
      .update(entities)
      .set({
        currentVersionId: nextVersionId,
        lastEditedBy: userId,
        updatedAt: new Date(),
      })
      .where(
        and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
      );

    // File-chat identity follows the logical document across version writes.
    // A version replacement mints a new field id; keeping the mapping on the
    // replaced id would make the refreshed viewer resolve a brand-new empty
    // thread. Move every user's mapping for this exact file field atomically
    // with the version write so the existing conversation follows the new id.
    await tx
      .update(fileChatThreads)
      .set({ fieldId: fileFieldId })
      .where(
        and(
          eq(fileChatThreads.organizationId, organizationId),
          eq(fileChatThreads.workspaceId, workspaceId),
          eq(fileChatThreads.entityId, entityId),
          eq(fileChatThreads.fieldId, replacedFileFieldId),
        ),
      );

    await tx
      .update(workspaces)
      .set({ lastActivityAt: new Date() })
      .where(eq(workspaces.id, workspaceId));

    await recordAuditEvent(tx, [
      {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
        resourceId: nextVersionId,
        workspaceId,
        changes: {
          created: {
            old: null,
            new: {
              entityId,
              versionNumber: nextVersionNumber,
              fileName,
              mimeType: DOCX_MIME_TYPE,
              sizeBytes: bytes.byteLength,
              sha256Hex,
            },
          },
        },
        metadata: {
          fileName,
          mimeType: DOCX_MIME_TYPE,
          sizeBytes: bytes.byteLength,
          sha256Hex,
        },
      },
      {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: entityId,
        workspaceId,
        changes: {
          currentVersionId: {
            old: freshCurrentVersionId,
            new: nextVersionId,
          },
        },
      },
    ]);

    return { status: "ok", versionNumber: nextVersionNumber };
  });

  const cleanupUploadedObject = async (): Promise<void> => {
    const cleanupResult = await Result.tryPromise({
      try: async () => await getS3().delete(s3Key),
      catch: (cause) =>
        new EntityVersionBufferCleanupError({
          message: "Failed to clean up rejected document-version bytes",
          cause,
        }),
    });
    if (Result.isError(cleanupResult)) {
      captureError(cleanupResult.error, { entityId, workspaceId });
    }
  };

  if (Result.isError(writeResult)) {
    await cleanupUploadedObject();
    return Result.err(writeResult.error);
  }
  if (writeResult.value.status !== "ok") {
    const reason = writeResult.value.status;
    await cleanupUploadedObject();
    return Result.err(
      new CreateEntityVersionFromBufferError({
        message: FAILURE_REASON_MESSAGES[reason],
        reason,
      }),
    );
  }

  const versionNumber = writeResult.value.versionNumber;

  detached(
    processExtraction(entityId, { filePropertyId }),
    "edit-workspace-document.process-extraction",
  );
  detached(
    enqueuePdfDerivativeOrMarkFailed({
      encrypted: false,
      entityId,
      fieldId: fileFieldId,
      mimeType: DOCX_MIME_TYPE,
      organizationId,
      userId,
      workspaceId,
    }),
    "edit-workspace-document.pdf-derivative",
  );
  detached(
    enqueueImageThumbnailOrMarkFailed({
      encrypted: false,
      entityId,
      fieldId: fileFieldId,
      mimeType: DOCX_MIME_TYPE,
      organizationId,
      userId,
      workspaceId,
    }),
    "edit-workspace-document.thumbnail-derivative",
  );
  detached(
    computeVersionDiffStats({
      versionId: nextVersionId,
      entityId,
      scopedDb: createRootScopedDb({
        organizationId,
        userId,
        workspaceIds: [workspaceId],
      }),
      workspaceId,
      organizationId,
    }),
    "edit-workspace-document.diff-stats",
  );

  broadcast(workspaceId, {
    type: "invalidate-query",
    data: ["entities", workspaceId],
  });

  return Result.ok({
    entityVersionId: nextVersionId,
    versionNumber,
    fieldId: fileFieldId,
  });
};
