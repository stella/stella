import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import { fields } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { createFileKey } from "@/api/handlers/files/utils";
import type { SafeId } from "@/api/lib/branded-types";
import { presignDownloadUrl } from "@/api/lib/s3";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

type DatabaseTransaction = Transaction;

type DocxFieldContent = Extract<FieldContent, { type: "file" }> & {
  mimeType: typeof DOCX_MIME_TYPE;
};

type DocxFieldEntry = {
  content: FieldContent;
  propertyId: SafeId<"property">;
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
  const rows = await tx
    .select({
      content: fields.content,
    })
    .from(fields)
    .where(
      and(
        eq(fields.entityVersionId, entityVersionId),
        eq(fields.propertyId, propertyId),
        eq(fields.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  const row = rows.at(0);
  if (!row) {
    return null;
  }

  return asDocxFieldContent(row.content);
};

export const presignDocxFieldDownload = ({
  fileContent,
  organizationId,
  workspaceId,
}: {
  fileContent: DocxFieldContent;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
}) =>
  presignDownloadUrl(
    createFileKey({
      fileId: fileContent.id,
      mimeType: fileContent.mimeType,
      organizationId,
      workspaceId,
    }),
    {
      expiresIn: 900,
      fileName: fileContent.fileName,
    },
  );

export const presignDocxDownloadFromFileId = ({
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
  presignDownloadUrl(
    createFileKey({
      fileId,
      mimeType: DOCX_MIME_TYPE,
      organizationId,
      workspaceId,
    }),
    {
      expiresIn: 900,
      fileName,
    },
  );
