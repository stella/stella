import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  cellMetadata,
  entities,
  entityVersions,
  fields,
  workspaces,
} from "@/api/db/schema";
import {
  buildVersionStamp,
  cloneFieldsForRevision,
  nextEntityVersionNumber,
} from "@/api/handlers/entities/version-utils";
import { fileContentWithMintedObject } from "@/api/handlers/files/file-object-ids";
import type { MintedFileId } from "@/api/handlers/files/file-object-ids";
import { pdfDerivativeStateForFile } from "@/api/handlers/files/gotenberg";
import { thumbnailDerivativeStateForFile } from "@/api/handlers/files/image-derivative";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

export type WriteFileVersionResult =
  | {
      status: "ok";
      entityVersionId: SafeId<"entityVersion">;
      fieldId: SafeId<"field">;
      versionNumber: number;
    }
  | {
      status:
        | "current-version-not-found"
        | "entity-not-found"
        | "entity-read-only"
        | "missing-file-field";
    };

type WriteFileVersionInput = {
  tx: Transaction;
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
  scanWarnings?: string[] | undefined;
  afterWrite?:
    | ((
        result: Extract<WriteFileVersionResult, { status: "ok" }>,
      ) => Promise<void>)
    | undefined;
};

/**
 * Canonical transaction for replacing an entity's file with a new version.
 *
 * Every transport (multipart, presigned upload, and compound template fill)
 * delegates here, so row locking, version numbering, field/cell cloning, and
 * audit events cannot drift between CLI, MCP, and HTTP entry points. Callers
 * own object-storage placement and post-commit derivative/extraction work.
 */
export const writeFileVersion = async ({
  tx,
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
  scanWarnings,
  afterWrite,
}: WriteFileVersionInput): Promise<WriteFileVersionResult> => {
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
    return { status: "entity-not-found" };
  }
  if (lockedEntity.readOnly) {
    return { status: "entity-read-only" };
  }

  const currentVersionId = lockedEntity.currentVersionId;
  const currentVersion = await tx.query.entityVersions.findFirst({
    where: { id: { eq: currentVersionId } },
    columns: { versionNumber: true },
    with: {
      fields: { columns: { content: true, propertyId: true } },
    },
  });
  if (!currentVersion) {
    return { status: "current-version-not-found" };
  }

  const fileField = currentVersion.fields.find(
    (candidate) => candidate.content.type === "file",
  );
  if (!fileField) {
    return { status: "missing-file-field" };
  }

  const workspace = await tx.query.workspaces.findFirst({
    where: { id: { eq: workspaceId } },
    columns: { reference: true },
  });
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
    createdBy: userId,
    entityId,
    id: entityVersionId,
    stamp: stamp.stamp,
    verificationCode: stamp.verificationCode,
    versionNumber,
    workspaceId,
  });

  await tx.insert(fields).values(
    cloneFieldsForRevision({
      currentFields: currentVersion.fields,
      entityVersionId,
      propertyId: fileField.propertyId,
      replacementFieldId: fieldId,
      replacementContent: fileContentWithMintedObject({
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
        eq(cellMetadata.entityVersionId, currentVersionId),
      ),
    )
    .for("update");
  const metadataToCopy = currentCellMetadataRows.filter(
    (row) => row.propertyId !== fileField.propertyId,
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
  await tx
    .update(workspaces)
    .set({ lastActivityAt: new Date() })
    .where(eq(workspaces.id, workspaceId));

  await recordAuditEvent(tx, [
    {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
      resourceId: entityVersionId,
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
      changes: {
        currentVersionId: { old: currentVersionId, new: entityVersionId },
      },
    },
  ]);

  const result = {
    status: "ok",
    entityVersionId,
    fieldId,
    versionNumber,
  } as const;
  await afterWrite?.(result);
  return result;
};
