import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import { db } from "@/api/db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import { createFileKey } from "@/api/handlers/files/utils";
import type { SafeId } from "@/api/lib/branded-types";
import { s3 } from "@/api/lib/s3";
import { PDF_MIME_TYPE } from "@/api/mime-types";

type FilePurpose = "download" | "display";

type ReadFileHandlerProps = {
  fieldId: string;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  purpose: FilePurpose;
};

export const readFileHandler = async ({
  fieldId,
  organizationId,
  workspaceId,
  purpose,
}: ReadFileHandlerProps) => {
  const [row] = await db
    .select({ content: fields.content })
    .from(fields)
    .innerJoin(entityVersions, eq(fields.entityVersionId, entityVersions.id))
    .innerJoin(
      entities,
      and(
        eq(entityVersions.entityId, entities.id),
        eq(entities.workspaceId, workspaceId),
      ),
    )
    .where(eq(fields.id, fieldId))
    .limit(1);

  if (!row) {
    return status(404);
  }

  if (row.content.type !== "file") {
    return status(400);
  }

  const content = row.content;

  if (purpose === "download") {
    return {
      mimeType: content.mimeType,
      fileName: content.fileName,
      encrypted: content.encrypted,
      presignedUrl: s3.presign(
        createFileKey({
          organizationId,
          workspaceId,
          fileId: content.id,
          mimeType: content.mimeType,
        }),
        { expiresIn: 900 },
      ),
    };
  }

  if (!content.pdfFileId && content.mimeType !== PDF_MIME_TYPE) {
    return status(400);
  }

  const fileId = content.pdfFileId ?? content.id;

  return {
    mimeType: PDF_MIME_TYPE,
    fileName: content.fileName,
    encrypted: content.encrypted,
    presignedUrl: s3.presign(
      createFileKey({
        organizationId,
        workspaceId,
        fileId,
        mimeType: PDF_MIME_TYPE,
      }),
      { expiresIn: 900 },
    ),
  };
};
