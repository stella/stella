import { and, eq, isNull, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { entities, entityVersions, fields } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { createFileKey } from "@/api/handlers/files/utils";
import type { SafeId } from "@/api/lib/branded-types";
import { presignDownloadUrl } from "@/api/lib/s3-presign";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

type DatabaseTransaction = Transaction;

type DocxFieldContent = Extract<FieldContent, { type: "file" }> & {
  mimeType: typeof DOCX_MIME_TYPE;
};

type DocxFieldEntry = {
  content: FieldContent;
  propertyId: SafeId<"property">;
};

export const lockDocxEditTarget = async ({
  entityId,
  propertyId,
  tx,
  workspaceId,
}: {
  entityId: SafeId<"entity">;
  propertyId: SafeId<"property">;
  tx: DatabaseTransaction;
  workspaceId: SafeId<"workspace">;
}) => {
  const lockKey = `docx-edit:${workspaceId}:${entityId}:${propertyId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
};

export const asDocxFieldContent = (
  content: FieldContent,
): DocxFieldContent | null => {
  if (content.type !== "file" || content.mimeType !== DOCX_MIME_TYPE) {
    return null;
  }

  return {
    ...content,
    mimeType: DOCX_MIME_TYPE,
  };
};

export const findDocxFieldForProperty = ({
  fieldEntries,
  propertyId,
}: {
  fieldEntries: DocxFieldEntry[];
  propertyId: SafeId<"property">;
}) => {
  const targetField = fieldEntries.find(
    (field) => field.propertyId === propertyId,
  );

  if (!targetField) {
    return null;
  }

  const content = asDocxFieldContent(targetField.content);
  if (!content) {
    return null;
  }

  return content;
};

export const readCurrentDocxTarget = async ({
  entityId,
  propertyId,
  tx,
  workspaceId,
}: {
  entityId: SafeId<"entity">;
  propertyId: SafeId<"property">;
  tx: DatabaseTransaction;
  workspaceId: SafeId<"workspace">;
}) => {
  // Lock the owning entity row before reading the current version to open a NEW
  // session against. delete-version takes the same `entities` FOR UPDATE, so
  // this serializes a new-session open with a concurrent version tombstone: the
  // open either runs before the delete (and anchors to the pre-delete current
  // version, which the delete's session-cancel sweep then withdraws) or after
  // it (and anchors to the promoted, live current version). Without the lock a
  // fresh session could anchor to the very version being tombstoned.
  //
  // Canonical docx-edit lock order (issue #1139): docx-edit advisory lock ->
  // desktop_edit_session rows -> entities row. This read is the entity step and
  // always follows the advisory + session steps in both open handlers, matching
  // finalize-desktop-edit-session and delete-version.
  await tx
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
    )
    .for("update");

  const entity = await tx.query.entities.findFirst({
    where: {
      id: { eq: entityId },
      workspaceId: { eq: workspaceId },
    },
    columns: {
      id: true,
    },
    with: {
      currentVersion: {
        columns: {
          id: true,
          versionNumber: true,
        },
        with: {
          fields: {
            columns: {
              content: true,
              propertyId: true,
            },
          },
        },
      },
    },
  });

  if (!entity?.currentVersion) {
    return null;
  }

  const content = findDocxFieldForProperty({
    fieldEntries: entity.currentVersion.fields,
    propertyId,
  });

  if (!content) {
    return null;
  }

  return {
    baseVersionId: entity.currentVersion.id,
    baseVersionNumber: entity.currentVersion.versionNumber,
    fileContent: content,
  };
};

export const readVersionDocxTarget = async ({
  entityVersionId,
  propertyId,
  tx,
  workspaceId,
}: {
  entityVersionId: SafeId<"entityVersion">;
  propertyId: SafeId<"property">;
  tx: DatabaseTransaction;
  workspaceId: SafeId<"workspace">;
}) => {
  // Class guard: join to entity_versions and require a live (non-tombstoned)
  // base version. This is the single chokepoint that serves a base version's
  // bytes to a resuming desktop edit session, so a tombstoned version can never
  // be downloaded here regardless of session state — even if a future tombstone
  // writer forgets to close the sessions that reference it.
  const rows = await tx
    .select({
      content: fields.content,
    })
    .from(fields)
    .innerJoin(entityVersions, eq(entityVersions.id, fields.entityVersionId))
    .where(
      and(
        eq(fields.entityVersionId, entityVersionId),
        eq(fields.propertyId, propertyId),
        eq(fields.workspaceId, workspaceId),
        isNull(entityVersions.deletedAt),
      ),
    )
    .limit(1);

  const row = rows.at(0);
  if (!row) {
    return null;
  }

  return asDocxFieldContent(row.content);
};

export const presignDocxFieldDownload = async ({
  fileContent,
  organizationId,
  workspaceId,
}: {
  fileContent: DocxFieldContent;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
}) =>
  await presignDownloadUrl(
    createFileKey({
      fileId: fileContent.id,
      mimeType: fileContent.mimeType,
      organizationId,
      workspaceId,
    }),
    {
      expiresIn: 900,
      fileName: fileContent.fileName,
      scope: { organizationId, workspaceId },
    },
  );

export const presignDocxDownloadFromFileId = async ({
  fileId,
  fileName,
  organizationId,
  workspaceId,
}: {
  fileId: string;
  fileName: string;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
}) =>
  await presignDownloadUrl(
    createFileKey({
      fileId,
      mimeType: DOCX_MIME_TYPE,
      organizationId,
      workspaceId,
    }),
    {
      expiresIn: 900,
      fileName,
      scope: { organizationId, workspaceId },
    },
  );
