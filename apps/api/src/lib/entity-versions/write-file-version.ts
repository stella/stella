import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  cellMetadata,
  desktopEditSessions,
  entities,
  entityVersions,
  fileChatThreads,
  fields,
  folioCollabRooms,
  properties,
  workspaces,
} from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { liveDesktopEditSessionPredicates } from "@/api/lib/desktop-edit-session-predicates";
import type { DocumentSource } from "@/api/lib/document-source";
import { lockDocxEditTarget } from "@/api/lib/entity-versions/desktop-edit-session-utils";
import {
  buildVersionStamp,
  cloneFieldsForRevision,
  nextEntityVersionNumber,
} from "@/api/lib/entity-versions/version-utils";
import { fileContentWithMintedObject } from "@/api/lib/files/file-object-ids";
import type { MintedFileId } from "@/api/lib/files/file-object-ids";
import { pdfDerivativeStateForFile } from "@/api/lib/files/gotenberg";
import { thumbnailDerivativeStateForFile } from "@/api/lib/files/image-derivative";
import { FOLIO_COLLAB_ROOM_ACTIVITY_TIMEOUT_MS } from "@/api/lib/folio-collab-room-contract";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

export type FileVersionWritePolicy =
  | { type: "replace-current-file" }
  | {
      type: "replace-current-file-from-version";
      expectedCurrentVersionId: SafeId<"entityVersion">;
    }
  | {
      type: "automatic-docx-edit";
      expectedCurrentVersionId: SafeId<"entityVersion">;
      filePropertyId: SafeId<"property">;
      replacedFileFieldId: SafeId<"field">;
    }
  | {
      type: "collaboration-room-publish";
      expectedCurrentVersionId: SafeId<"entityVersion">;
      filePropertyId: SafeId<"property">;
    };

export type WriteFileVersionResult =
  | {
      status: "ok";
      entityVersionId: SafeId<"entityVersion">;
      fieldId: SafeId<"field">;
      filePropertyId: SafeId<"property">;
      versionNumber: number;
    }
  | {
      status:
        | "current-version-not-found"
        | "current-version-changed"
        | "edit-session-open"
        | "entity-not-found"
        | "entity-read-only"
        | "missing-file-field"
        | "target-file-not-found"
        | "workspace-not-active";
    };

type WriteFileVersionInput = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  fileId: MintedFileId;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256Hex: string;
  source: DocumentSource | null;
  scanWarnings?: string[] | undefined;
  versionMetadata?:
    | {
        collaborationContributorUserIds?: string[] | undefined;
        description?: string | undefined;
        label?: string | undefined;
      }
    | undefined;
  writePolicy: FileVersionWritePolicy;
  afterWrite?:
    | ((
        result: Extract<WriteFileVersionResult, { status: "ok" }>,
      ) => Promise<void>)
    | undefined;
};

const hasOpenDesktopEditSession = async ({
  tx,
  workspaceId,
  entityId,
  filePropertyId,
}: {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  filePropertyId: SafeId<"property">;
}): Promise<boolean> => {
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
  return liveDesktopSessions.at(0) !== undefined;
};

const hasOpenDocxEditSession = async ({
  tx,
  workspaceId,
  entityId,
  filePropertyId,
}: {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  filePropertyId: SafeId<"property">;
}): Promise<boolean> => {
  if (
    await hasOpenDesktopEditSession({
      tx,
      workspaceId,
      entityId,
      filePropertyId,
    })
  ) {
    return true;
  }

  const activeCollabRooms = await tx
    .select({ id: folioCollabRooms.id })
    .from(folioCollabRooms)
    .where(
      and(
        eq(folioCollabRooms.entityId, entityId),
        eq(folioCollabRooms.propertyId, filePropertyId),
        eq(folioCollabRooms.workspaceId, workspaceId),
        sql`${folioCollabRooms.lastActivityAt} > now() - (${FOLIO_COLLAB_ROOM_ACTIVITY_TIMEOUT_MS} * interval '1 millisecond')`,
      ),
    )
    .limit(1);
  return activeCollabRooms.at(0) !== undefined;
};

/**
 * Canonical transaction for replacing an entity's file with a new version.
 *
 * Ordinary transports and automatic DOCX edits delegate here, so row locking,
 * version numbering, field/cell cloning, edit-session exclusion, and audit
 * events cannot drift between CLI, MCP, chat, and HTTP entry points. Callers
 * own object-storage placement and post-commit derivative/extraction work.
 */
export const writeFileVersion = async ({
  tx,
  organizationId,
  workspaceId,
  entityId,
  userId,
  recordAuditEvent,
  entityVersionId,
  fieldId,
  fileId,
  fileName,
  mimeType,
  sizeBytes,
  sha256Hex,
  source,
  scanWarnings,
  versionMetadata,
  writePolicy,
  afterWrite,
}: WriteFileVersionInput): Promise<WriteFileVersionResult> => {
  switch (writePolicy.type) {
    case "replace-current-file": {
      break;
    }
    case "replace-current-file-from-version": {
      break;
    }
    case "automatic-docx-edit": {
      await lockDocxEditTarget({
        entityId,
        propertyId: writePolicy.filePropertyId,
        tx,
        workspaceId,
      });
      if (
        await hasOpenDocxEditSession({
          tx,
          workspaceId,
          entityId,
          filePropertyId: writePolicy.filePropertyId,
        })
      ) {
        return { status: "edit-session-open" };
      }
      break;
    }
    case "collaboration-room-publish": {
      await lockDocxEditTarget({
        entityId,
        propertyId: writePolicy.filePropertyId,
        tx,
        workspaceId,
      });
      if (
        await hasOpenDesktopEditSession({
          tx,
          workspaceId,
          entityId,
          filePropertyId: writePolicy.filePropertyId,
        })
      ) {
        return { status: "edit-session-open" };
      }
      break;
    }
    default: {
      writePolicy satisfies never;
      return panic(`Unhandled write policy: ${String(writePolicy)}`);
    }
  }

  const targetsFileProperty =
    writePolicy.type === "automatic-docx-edit" ||
    writePolicy.type === "collaboration-room-publish";
  const lockedWorkspace = targetsFileProperty
    ? await tx
        .select({ reference: workspaces.reference, status: workspaces.status })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
        .for("update")
        .then((rows) => rows.at(0))
    : null;
  if (targetsFileProperty && lockedWorkspace?.status !== "active") {
    return { status: "workspace-not-active" };
  }

  const entityRows = await tx
    .select({
      currentVersionId: entities.currentVersionId,
      docSequence: entities.docSequence,
      kind: entities.kind,
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
    return { status: "entity-not-found" };
  }
  if (lockedEntity.readOnly) {
    return { status: "entity-read-only" };
  }
  if (lockedEntity.kind !== "document") {
    return { status: "missing-file-field" };
  }

  const currentVersionId = lockedEntity.currentVersionId;
  if (
    writePolicy.type !== "replace-current-file" &&
    currentVersionId !== writePolicy.expectedCurrentVersionId
  ) {
    return { status: "current-version-changed" };
  }
  const currentVersion = await tx.query.entityVersions.findFirst({
    where: {
      id: { eq: currentVersionId },
      entityId: { eq: entityId },
      workspaceId: { eq: workspaceId },
      deletedAt: { isNull: true },
    },
    columns: { versionNumber: true },
    with: {
      fields: { columns: { id: true, content: true, propertyId: true } },
    },
  });
  if (!currentVersion) {
    return { status: "current-version-not-found" };
  }

  const fileField = targetsFileProperty
    ? currentVersion.fields.find(
        (candidate) =>
          candidate.propertyId === writePolicy.filePropertyId &&
          (writePolicy.type !== "automatic-docx-edit" ||
            candidate.id === writePolicy.replacedFileFieldId) &&
          candidate.content.type === "file" &&
          candidate.content.mimeType === DOCX_MIME_TYPE,
      )
    : currentVersion.fields.find(
        (candidate) => candidate.content.type === "file",
      );
  if (targetsFileProperty && !fileField) {
    return { status: "target-file-not-found" };
  }
  const systemFileProperty = fileField
    ? undefined
    : await tx
        .select({ id: properties.id })
        .from(properties)
        .where(
          and(
            eq(properties.workspaceId, workspaceId),
            eq(properties.system, true),
            sql`${properties.content}->>'type' = 'file'`,
          ),
        )
        .limit(1)
        .then((rows) => rows.at(0));
  const filePropertyId = fileField?.propertyId ?? systemFileProperty?.id;
  if (!filePropertyId) {
    return { status: "missing-file-field" };
  }
  // `save_document` deliberately creates an empty first version. Attaching
  // its first file is therefore an append under the workspace's system file
  // property, while ordinary version writes keep replacing the existing file
  // field. A row already occupying that property with a non-file shape is a
  // malformed document, not an empty one; reject it instead of colliding with
  // the per-version property uniqueness constraint below.
  if (
    !fileField &&
    currentVersion.fields.some(
      (candidate) => candidate.propertyId === filePropertyId,
    )
  ) {
    return { status: "missing-file-field" };
  }

  const workspace =
    lockedWorkspace ??
    (await tx.query.workspaces.findFirst({
      where: { id: { eq: workspaceId } },
      columns: { reference: true, status: true },
    }));
  const versionNumber = await nextEntityVersionNumber(tx, {
    entityId,
    workspaceId,
  });
  const stamp = buildVersionStamp({
    docSequence: lockedEntity.docSequence,
    versionNumber,
    workspaceReference: workspace?.reference ?? null,
  });

  await tx.insert(entityVersions).values({
    collaborationContributorUserIds:
      versionMetadata?.collaborationContributorUserIds,
    createdBy: userId,
    description: versionMetadata?.description,
    entityId,
    id: entityVersionId,
    label: versionMetadata?.label,
    stamp: stamp.stamp,
    verificationCode: stamp.verificationCode,
    versionNumber,
    workspaceId,
    source,
  });

  const replacementContent = fileContentWithMintedObject({
    encrypted: false,
    fileName,
    id: fileId,
    mimeType,
    pdfFileId: null,
    sha256Hex,
    sizeBytes,
    type: "file",
    version: 1,
    pdfDerivative: pdfDerivativeStateForFile({
      encrypted: false,
      mimeType,
    }),
    thumbnailFileId: null,
    thumbnailDerivative: thumbnailDerivativeStateForFile({
      encrypted: false,
      mimeType,
    }),
    ...(scanWarnings !== undefined && { scanWarnings }),
  });
  const revisionFields = cloneFieldsForRevision({
    currentFields: currentVersion.fields,
    entityVersionId,
    propertyId: filePropertyId,
    replacementFieldId: fieldId,
    replacementContent,
    workspaceId,
  });
  if (!fileField) {
    revisionFields.push({
      id: fieldId,
      content: replacementContent,
      entityVersionId,
      propertyId: filePropertyId,
      workspaceId,
    });
  }
  await tx.insert(fields).values(revisionFields);

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
        eq(cellMetadata.entityVersionId, currentVersionId),
      ),
    )
    .for("update");
  const metadataToCopy = currentCellMetadataRows.filter(
    (row) => row.propertyId !== filePropertyId,
  );
  if (metadataToCopy.length > 0) {
    await tx.insert(cellMetadata).values(
      metadataToCopy.map((row) => ({
        workspaceId,
        entityVersionId,
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
      currentVersionId: entityVersionId,
      lastEditedBy: userId,
      updatedAt: new Date(),
    })
    .where(
      and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
    );
  if (writePolicy.type === "automatic-docx-edit") {
    // File-chat identity follows the logical document across automatic edits.
    // Move every user's exact field mapping atomically with the version write.
    await tx
      .update(fileChatThreads)
      .set({ fieldId })
      .where(
        and(
          eq(fileChatThreads.organizationId, organizationId),
          eq(fileChatThreads.workspaceId, workspaceId),
          eq(fileChatThreads.entityId, entityId),
          eq(fileChatThreads.fieldId, writePolicy.replacedFileFieldId),
        ),
      );
  }
  await tx
    .update(workspaces)
    .set({ lastActivityAt: new Date() })
    .where(eq(workspaces.id, workspaceId));

  await recordAuditEvent(tx, [
    {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
      resourceId: entityVersionId,
      workspaceId,
      changes: {
        created: {
          old: null,
          new: {
            entityId,
            versionNumber,
            fileName,
            mimeType,
            sizeBytes,
            sha256Hex,
          },
        },
      },
      metadata: { fileName, mimeType, sizeBytes, sha256Hex },
    },
    {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
      resourceId: entityId,
      workspaceId,
      changes: {
        currentVersionId: { old: currentVersionId, new: entityVersionId },
      },
    },
  ]);

  const result = {
    status: "ok",
    entityVersionId,
    fieldId,
    filePropertyId,
    versionNumber,
  } as const;
  await afterWrite?.(result);
  return result;
};
