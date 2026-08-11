import { and, eq, isNull } from "drizzle-orm";
import { status } from "elysia";

import {
  DOCUMENT_PROPERTIES_MAX_BYTES,
  hasDocumentProperties,
} from "@stll/api-contract";
import type { DocumentPropertiesResult } from "@stll/api-contract";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  constrainDocumentPropertiesEditability,
  extractDocumentProperties,
} from "@/api/lib/files/document-properties";
import { createFileKey } from "@/api/lib/files/utils";
import { readS3ArrayBuffer } from "@/api/lib/s3";
import { withTimeout } from "@/api/lib/with-timeout";

const DOCUMENT_PROPERTIES_READ_TIMEOUT_MS = 30 * 1000;

type ReadDocumentPropertiesOptions = {
  canUpdateEntity: boolean;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
};

/**
 * Read one stored file's own embedded properties.
 *
 * Parsed per request from the stored bytes rather than persisted at upload:
 * these values are personal data (author and last-editor names, the company
 * whose licence produced the file), so keeping a second searchable copy of
 * them would widen what a workspace holds for no gain — the panel that shows
 * them is opened rarely and the client caches the answer for its session.
 */
export const readDocumentProperties = async ({
  canUpdateEntity,
  fieldId,
  organizationId,
  recordAuditEvent,
  scopedDb,
  workspaceId,
}: ReadDocumentPropertiesOptions) => {
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
      // A tombstoned version's bytes are retained under legal hold but must
      // stay unreachable, metadata included.
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

  // Answer the cases that need no bytes before paying for a storage read: a
  // format that carries no properties, a file locked behind a password, and
  // one too big to pull whole for a few kilobytes of XML.
  if (!hasDocumentProperties(content.mimeType)) {
    return { status: "unsupported-format" } satisfies DocumentPropertiesResult;
  }
  if (content.encrypted) {
    return { status: "password-protected" } satisfies DocumentPropertiesResult;
  }
  if (content.sizeBytes > DOCUMENT_PROPERTIES_MAX_BYTES) {
    return { status: "too-large" } satisfies DocumentPropertiesResult;
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
      label: "Document properties storage read",
      timeoutMs: DOCUMENT_PROPERTIES_READ_TIMEOUT_MS,
    },
  );

  const result = constrainDocumentPropertiesEditability(
    await extractDocumentProperties({
      bytes,
      mimeType: content.mimeType,
    }),
    canUpdateEntity,
  );

  // Reading the properties reads the object, so it belongs in the trail
  // alongside downloads and previews.
  await scopedDb(
    async (tx) =>
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.ACCESS,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: row.entityId,
        metadata: { fieldId, mimeType: content.mimeType },
      }),
  );

  return result;
};
