import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import { db } from "@/api/db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import { env } from "@/api/env";
import { createFileKey } from "@/api/handlers/files/utils";
import type { SafeId } from "@/api/lib/branded-types";
import { injectStamp, isStampableDocx } from "@/api/lib/docx-stamp";
import { s3 } from "@/api/lib/s3";
import { PDF_MIME_TYPE } from "@/api/mime-types";

type FilePurpose = "download" | "display";

type ReadFileHandlerProps = {
  fieldId: string;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  purpose: FilePurpose;
};

const BASE_URL = env.PUBLIC_URL ?? env.BETTER_AUTH_URL;

const ASCII_FILENAME_RE = /^[\x20-\x7E]+$/;

const fileFieldQuery = (fieldId: string, workspaceId: SafeId<"workspace">) =>
  db
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
    .limit(1);

export const readFileHandler = async ({
  fieldId,
  organizationId,
  workspaceId,
  purpose,
}: ReadFileHandlerProps) => {
  const [row] = await fileFieldQuery(fieldId, workspaceId);

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
      mimeType: content.mimeType,
      fileName: content.fileName,
      encrypted: content.encrypted,
      presignedUrl: s3.presign(fileKey, { expiresIn: 900 }),
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
    mimeType: PDF_MIME_TYPE,
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
  fieldId,
  organizationId,
  workspaceId,
}: StampedDownloadHandlerProps) => {
  const [row] = await fileFieldQuery(fieldId, workspaceId);

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

/**
 * Build a Content-Disposition header value per RFC 6266.
 *
 * ASCII-safe filenames (no `"` or `\`) use the simple
 * `filename="..."` form. All others get a sanitised ASCII
 * fallback plus `filename*=UTF-8''...` for correct decoding.
 */
const contentDisposition = (name: string): string => {
  const isSafeAscii =
    ASCII_FILENAME_RE.test(name) && !name.includes('"') && !name.includes("\\");

  if (isSafeAscii) {
    return `attachment; filename="${name}"`;
  }

  // Sanitise fallback: strip non-ASCII and unsafe chars
  const fallback = name.replaceAll(/[^\x20-\x7E]/g, "_").replaceAll('"', "_");
  const encoded = encodeURIComponent(name).replaceAll("'", "%27");

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};
