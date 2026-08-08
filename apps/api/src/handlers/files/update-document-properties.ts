import { and, eq, isNull } from "drizzle-orm";
import { status } from "elysia";

import {
  AUTHORED_DOCUMENT_PROPERTY_KEYS,
  documentContainerFormat,
} from "@stll/api-contract";
import type { AuthoredDocumentPropertyKey } from "@stll/api-contract";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createEntityVersionFromBuffer } from "@/api/handlers/entities/create-version-from-buffer";
import {
  DOCUMENT_PROPERTIES_MAX_BYTES,
  writeDocumentProperties,
} from "@/api/lib/files/document-properties";
import { createFileKey } from "@/api/lib/files/utils";
import { readS3ArrayBuffer } from "@/api/lib/s3";
import { withTimeout } from "@/api/lib/with-timeout";

const DOCUMENT_PROPERTIES_READ_TIMEOUT_MS = 30 * 1000;

/** Longest value accepted per property; these are labels, not document text. */
const DOCUMENT_PROPERTY_MAX_LENGTH = 1000;

type UpdateDocumentPropertiesOptions = {
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  userId: SafeId<"user">;
  values: Partial<Record<AuthoredDocumentPropertyKey, string>>;
  workspaceId: SafeId<"workspace">;
};

const AUTHORED_KEYS: ReadonlySet<string> = new Set(
  AUTHORED_DOCUMENT_PROPERTY_KEYS,
);

/**
 * Write a file's own embedded properties back into its bytes, as a new version.
 *
 * Editing in place is the other option and is rejected: these bytes are the
 * record, and a matter's document must not change underneath the people who
 * have already read and cited it. A new version leaves the previous bytes and
 * their sha256 in the chain, so the edit is reviewable and reversible like any
 * other change to the document.
 *
 * Only the authored properties are writable. The generated ones (word counts,
 * producing application, revision) describe what a program did to the file, and
 * letting a person set them would turn a weak provenance signal into a false
 * one. OOXML only: PDF carries the same fields in both the Info dictionary and
 * an XMP packet, so writing without reconciling the two leaves a file that
 * reports different authors depending on which the reader trusts.
 */
export const updateDocumentProperties = async ({
  fieldId,
  organizationId,
  recordAuditEvent,
  safeDb,
  scopedDb,
  userId,
  values,
  workspaceId,
}: UpdateDocumentPropertiesOptions) => {
  const entries = Object.entries(values).filter(([key]) =>
    AUTHORED_KEYS.has(key),
  );
  if (entries.length === 0) {
    return status(400);
  }
  if (
    entries.some(([, value]) => value.length > DOCUMENT_PROPERTY_MAX_LENGTH)
  ) {
    return status(400);
  }

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
      // Matches the read path: a tombstoned version's bytes are retained under
      // legal hold but must stay unreachable, and unwritable.
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
    documentContainerFormat(content.mimeType) !== "ooxml" ||
    content.sizeBytes > DOCUMENT_PROPERTIES_MAX_BYTES
  ) {
    return status(400);
  }

  const bytes = await withTimeout(
    async () =>
      await readS3ArrayBuffer(
        createFileKey({
          organizationId,
          workspaceId,
          fileId: content.id,
          mimeType: content.mimeType,
        }),
      ),
    {
      label: "Document properties storage read",
      timeoutMs: DOCUMENT_PROPERTIES_READ_TIMEOUT_MS,
    },
  );

  const written = await writeDocumentProperties({
    bytes,
    mimeType: content.mimeType,
    values: Object.fromEntries(entries),
  });
  if (written.status !== "written") {
    return status(422);
  }

  // Delegated rather than hand-rolled: this is the canonical path for replacing
  // a file, so version numbering, field cloning, the audit event, derivative
  // and extraction re-queueing all stay identical to an ordinary re-upload.
  const result = await createEntityVersionFromBuffer({
    buffer: written.bytes,
    entityId: row.entityId,
    fileName: content.fileName,
    mimeType: content.mimeType,
    organizationId,
    recordAuditEvent,
    safeDb,
    source: null,
    userId,
    workspaceId,
  });

  if (result.isErr()) {
    return status(422);
  }

  return {
    entityVersionId: result.value.entityVersionId,
    fieldId: result.value.fieldId,
    versionNumber: result.value.versionNumber,
  };
};
