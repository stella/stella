import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { resolveEmailMimeType } from "@stll/api-contract/email-mime-types";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import {
  brandPersistedEntityId,
  brandPersistedEntityVersionId,
  brandPersistedFieldId,
  brandPersistedOrganizationId,
  brandPersistedUserFileId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

/** The immutable file version a native-extraction run admitted for filing. */
export type UploadedMailSource = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  sourceFileId: SafeId<"userFile">;
  sourceSha256Hex: string;
  storageMimeType: string;
  extractionMimeType: string;
};

/**
 * The payload the previous release's extraction worker enqueues: the stored
 * file and its resolved type, without the version identity. Remove this shape
 * and its resolver once no previous-release producer can be running and its
 * queued jobs have drained.
 */
export type LegacyUploadedMailJobData = {
  organizationId: string;
  workspaceId: string;
  entityId: string;
  sourceFileId: string;
  storageMimeType: string;
  mimeType: string;
};

/**
 * Recover a previous-release job's source identity from the stored version
 * whose file field names its object. The filing path then applies the same
 * current-version rule as for any queued source.
 */
export const resolveLegacyUploadedMailSource = async (
  tx: Transaction,
  data: LegacyUploadedMailJobData,
): Promise<UploadedMailSource | null> => {
  const organizationId = brandPersistedOrganizationId(data.organizationId);
  const workspaceId = brandPersistedWorkspaceId(data.workspaceId);
  const entityId = brandPersistedEntityId(data.entityId);
  const row = await tx
    .select({
      entityVersionId: entityVersions.id,
      fieldId: fields.id,
      sha256Hex: sql<string | null>`${fields.content}->>'sha256Hex'`,
    })
    .from(entities)
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, entities.workspaceId),
        eq(workspaces.organizationId, organizationId),
      ),
    )
    .innerJoin(
      entityVersions,
      and(
        eq(entityVersions.entityId, entities.id),
        eq(entityVersions.workspaceId, entities.workspaceId),
        isNull(entityVersions.deletedAt),
      ),
    )
    .innerJoin(
      fields,
      and(
        eq(fields.entityVersionId, entityVersions.id),
        eq(fields.workspaceId, entities.workspaceId),
        sql`${fields.content}->>'type' = 'file'`,
        sql`${fields.content}->>'id' = ${data.sourceFileId}`,
        sql`${fields.content}->>'mimeType' = ${data.storageMimeType}`,
      ),
    )
    .where(
      and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
    )
    .orderBy(desc(entityVersions.versionNumber))
    .limit(1)
    .then((rows) => rows.at(0));
  if (row?.sha256Hex === undefined || row.sha256Hex === null) {
    return null;
  }
  return {
    organizationId,
    workspaceId,
    entityId,
    entityVersionId: brandPersistedEntityVersionId(row.entityVersionId),
    fieldId: brandPersistedFieldId(row.fieldId),
    sourceFileId: brandPersistedUserFileId(data.sourceFileId),
    sourceSha256Hex: row.sha256Hex,
    storageMimeType: data.storageMimeType,
    extractionMimeType: data.mimeType,
  };
};

/**
 * Resolve the exact source only while it remains the entity's live current
 * file. The version author is the uploader; the entity creator may be a
 * different person.
 */
export const readCurrentUploadedMailSource = async (
  tx: Transaction,
  source: UploadedMailSource,
) => {
  const entityLock = await withAggregateLock({
    aggregate: "entity",
    id: { id: source.entityId, workspaceId: source.workspaceId },
    mode: "update",
    tx,
  });
  if (entityLock.status !== "locked") {
    return null;
  }
  const row = await tx
    .select({
      createdAt: entityVersions.createdAt,
      uploaderId: entityVersions.createdBy,
      uploaderEmail: user.email,
      fileName: sql<string>`${fields.content}->>'fileName'`,
      storageMimeType: sql<string>`${fields.content}->>'mimeType'`,
    })
    .from(entities)
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, source.workspaceId),
        eq(workspaces.organizationId, source.organizationId),
      ),
    )
    .innerJoin(
      entityVersions,
      and(
        eq(entityVersions.id, source.entityVersionId),
        eq(entityVersions.entityId, entities.id),
        eq(entityVersions.workspaceId, source.workspaceId),
        isNull(entityVersions.deletedAt),
      ),
    )
    .innerJoin(
      fields,
      and(
        eq(fields.id, source.fieldId),
        eq(fields.workspaceId, source.workspaceId),
        eq(fields.entityVersionId, source.entityVersionId),
        sql`${fields.content}->>'type' = 'file'`,
        sql`${fields.content}->>'id' = ${source.sourceFileId}`,
        sql`${fields.content}->>'sha256Hex' = ${source.sourceSha256Hex}`,
        sql`${fields.content}->>'mimeType' = ${source.storageMimeType}`,
      ),
    )
    .leftJoin(
      member,
      and(
        eq(member.userId, entityVersions.createdBy),
        eq(member.organizationId, source.organizationId),
      ),
    )
    .leftJoin(user, and(eq(user.id, member.userId), isNull(user.deletedAt)))
    .where(
      and(
        eq(entities.id, source.entityId),
        eq(entities.workspaceId, source.workspaceId),
        eq(entities.currentVersionId, source.entityVersionId),
      ),
    )
    .limit(1)
    .then((rows) => rows.at(0));
  if (
    row === undefined ||
    resolveEmailMimeType({
      fileName: row.fileName,
      mimeType: row.storageMimeType,
    }) !== source.extractionMimeType
  ) {
    return null;
  }
  return row;
};
