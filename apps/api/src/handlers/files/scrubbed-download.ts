import { and, eq, isNull } from "drizzle-orm";
import { status } from "elysia";

import {
  DOCUMENT_PROPERTIES_MAX_BYTES,
  hasDocumentProperties,
} from "@stll/api-contract";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { contentDisposition } from "@/api/lib/content-disposition";
import { scrubDocumentProperties } from "@/api/lib/files/document-properties";
import { createFileKey } from "@/api/lib/files/utils";
import { readS3ArrayBuffer } from "@/api/lib/s3";
import { RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS } from "@/api/lib/security-headers";
import { withTimeout } from "@/api/lib/with-timeout";

const SCRUBBED_DOWNLOAD_READ_TIMEOUT_MS = 30 * 1000;

type ScrubbedDownloadOptions = {
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
};

/**
 * Download a copy of the file with its embedded authoring metadata removed.
 *
 * The stored version is untouched: the matter keeps the original bytes, their
 * sha256 and their place in the version chain, and only the copy that leaves
 * is cleaned. A file this endpoint cannot clean is refused outright rather than
 * returned as-is, because a download labelled "without metadata" that quietly
 * still carries it is worse than no feature at all.
 */
export const readScrubbedDownload = async ({
  fieldId,
  organizationId,
  recordAuditEvent,
  scopedDb,
  workspaceId,
}: ScrubbedDownloadOptions) => {
  const rows = await scopedDb((tx) =>
    tx
      .select({ content: fields.content, entityId: entities.id })
      .from(fields)
      .innerJoin(entityVersions, eq(fields.entityVersionId, entityVersions.id))
      .innerJoin(
        entities,
        and(
          eq(entityVersions.entityId, entities.id),
          eq(entities.workspaceId, workspaceId),
        ),
      )
      .where(and(eq(fields.id, fieldId), isNull(entityVersions.deletedAt)))
      .limit(1),
  );

  const row = rows.at(0);
  if (!row) {
    return status(404);
  }
  if (row.content.type !== "file") {
    return status(400);
  }
  const content = row.content;

  if (
    content.encrypted ||
    !hasDocumentProperties(content.mimeType) ||
    content.sizeBytes > DOCUMENT_PROPERTIES_MAX_BYTES
  ) {
    return status(400);
  }

  const bytes = await withTimeout(
    async (signal) =>
      await readS3ArrayBuffer(
        createFileKey({
          organizationId,
          workspaceId,
          fileId: content.id,
          mimeType: content.mimeType,
        }),
        signal,
      ),
    {
      label: "Scrubbed download storage read",
      timeoutMs: SCRUBBED_DOWNLOAD_READ_TIMEOUT_MS,
    },
  );

  const scrubbed = await scrubDocumentProperties({
    bytes,
    mimeType: content.mimeType,
  });

  if (scrubbed.status !== "scrubbed") {
    return status(422);
  }

  // Record the DOWNLOAD only once the cleaned bytes exist, matching the
  // presigned and stamped paths: a failed storage read or scrub must not leave
  // a download in the trail that never happened.
  await scopedDb(
    async (tx) =>
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.DOWNLOAD,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: row.entityId,
        metadata: { fieldId, mimeType: content.mimeType, scrubbed: true },
      }),
  );

  // Copied into its own ArrayBuffer so the body is a plain `BodyInit`; the
  // scrubbers return views whose backing buffer is not statically known.
  const body = new ArrayBuffer(scrubbed.bytes.byteLength);
  new Uint8Array(body).set(scrubbed.bytes);

  return new Response(body, {
    headers: {
      ...RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS,
      "Content-Type": content.mimeType,
      "Content-Disposition": contentDisposition(content.fileName),
      "Content-Length": String(body.byteLength),
    },
  });
};
