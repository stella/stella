import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import type { ScopedDb } from "@/api/db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import { env } from "@/api/env";
import { createFileKey } from "@/api/handlers/files/utils";
import type { SafeId } from "@/api/lib/branded-types";
import { contentDisposition } from "@/api/lib/content-disposition";
import { injectStamp, isStampableDocx } from "@/api/lib/docx-stamp";
import { presignDownloadUrl, s3 } from "@/api/lib/s3";
import { PDF_MIME_TYPE } from "@/api/mime-types";

type FilePurpose = "download" | "display";

type ReadFileHandlerProps = {
  scopedDb: ScopedDb;
  fieldId: string;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  purpose: FilePurpose;
};

const BASE_URL = env.PUBLIC_URL ?? env.BETTER_AUTH_URL;

const fileFieldQuery = async (
  scopedDb: ScopedDb,
  fieldId: string,
  workspaceId: SafeId<"workspace">,
) =>
  await scopedDb((tx) =>
    tx
      .select({
        content: fields.content,
        versionStamp: entityVersions.stamp,
        verificationCode: entityVersions.verificationCode,
      })
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
      .limit(1),
  );

export const readFileHandler = async ({
  scopedDb,
  fieldId,
  organizationId,
  workspaceId,
  purpose,
}: ReadFileHandlerProps) => {
  const rows = await fileFieldQuery(scopedDb, fieldId, workspaceId);
  const row = rows.at(0);

  if (!row) {
    return status(404);
  }

  if (row.content.type !== "file") {
    return status(400);
  }

  const content = row.content;
  const fileKey = createFileKey({
    organizationId,
    workspaceId,
    fileId: content.id,
    mimeType: content.mimeType,
  });

  if (purpose === "download") {
    return {
      fileId: content.id,
      mimeType: content.mimeType,
      originalMimeType: content.mimeType,
      fileName: content.fileName,
      encrypted: content.encrypted,
      presignedUrl: presignDownloadUrl(fileKey, {
        expiresIn: 900,
        fileName: content.fileName,
      }),
      stampable:
        !!row.versionStamp &&
        !!row.verificationCode &&
        isStampableDocx(content.mimeType, content.sizeBytes) &&
        !content.encrypted,
    };
  }

  if (!content.pdfFileId && content.mimeType !== PDF_MIME_TYPE) {
    return status(400);
  }

  const displayFileId = content.pdfFileId ?? content.id;

  return {
    fileId: displayFileId,
    mimeType: PDF_MIME_TYPE,
    originalMimeType: content.mimeType,
    fileName: content.fileName,
    encrypted: content.encrypted,
    presignedUrl: s3.presign(
      createFileKey({
        organizationId,
        workspaceId,
        fileId: displayFileId,
        mimeType: PDF_MIME_TYPE,
      }),
      { expiresIn: 900 },
    ),
    stampable: false,
  };
};

// ── Stamped download (separate endpoint) ────────────────

type StampedDownloadHandlerProps = {
  scopedDb: ScopedDb;
  fieldId: string;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

/**
 * Download a DOCX with Stella stamps injected. Returns the
 * modified file as a streamed `Response`. Only called when
 * the user explicitly requests stamping via a dedicated
 * action (right-click → "Download with stamp").
 */
export const stampedDownloadHandler = async ({
  scopedDb,
  fieldId,
  organizationId,
  workspaceId,
}: StampedDownloadHandlerProps) => {
  const rows = await fileFieldQuery(scopedDb, fieldId, workspaceId);
  const row = rows.at(0);

  if (!row) {
    return status(404);
  }

  if (row.content.type !== "file") {
    return status(400);
  }

  const content = row.content;

  if (
    !row.versionStamp ||
    !row.verificationCode ||
    !isStampableDocx(content.mimeType, content.sizeBytes) ||
    content.encrypted
  ) {
    return status(400);
  }

  const fileKey = createFileKey({
    organizationId,
    workspaceId,
    fileId: content.id,
    mimeType: content.mimeType,
  });

  const presignedUrl = s3.presign(fileKey, { expiresIn: 900 });
  const response = await fetch(presignedUrl, {
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    return status(502);
  }

  const buffer = await response.arrayBuffer();
  const stamped = await injectStamp(
    buffer,
    row.versionStamp,
    row.verificationCode,
    BASE_URL,
  );

  return new Response(stamped, {
    headers: {
      "Content-Type": content.mimeType,
      "Content-Disposition": contentDisposition(content.fileName),
      "Content-Length": String(stamped.byteLength),
    },
  });
};
