/**
 * Resolving the PDF a signing exchange acts on.
 *
 * A signing session is keyed by (entity, file property), not by field id: the
 * browser knows which file field it is showing, and the version that field
 * lives on changes between opening the exchange and finalizing it. Both
 * lookups here therefore select the file field by property, and the caller
 * pins the version.
 */

import { and, eq, isNull } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { entityVersions, fields } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import type { EntityVersionFile } from "@/api/lib/entity-versions/load-entity-version-file-buffer";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { brandPersistedUserFileId } from "@/api/lib/safe-id-boundaries";
import { PDF_MIME_TYPE } from "@/api/mime-types";

type PdfFieldContent = Extract<FieldContent, { type: "file" }>;

/**
 * Why a field cannot be signed. Each value is a stable code the browser and
 * the desktop branch on, so the copy can name the actual obstacle.
 */
const PDF_SIGNING_TARGET_REJECTIONS = [
  "not_a_file",
  "not_a_pdf",
  "encrypted",
  "too_large",
] as const;

export type PdfSigningTargetRejection =
  (typeof PDF_SIGNING_TARGET_REJECTIONS)[number];

export type PdfSigningTarget =
  | { status: "rejected"; reason: PdfSigningTargetRejection }
  | { status: "signable"; fileContent: PdfFieldContent };

const asSignablePdfContent = (content: FieldContent): PdfSigningTarget => {
  if (content.type !== "file") {
    return { status: "rejected", reason: "not_a_file" };
  }
  if (content.mimeType !== PDF_MIME_TYPE) {
    return { status: "rejected", reason: "not_a_pdf" };
  }
  // Signing appends an incremental update to the plaintext bytes; an
  // encrypted PDF would have to be decrypted first, which this flow does not
  // do and must not appear to do.
  if (content.encrypted) {
    return { status: "rejected", reason: "encrypted" };
  }
  if (content.sizeBytes > FILE_SIZE_LIMIT_BYTES.document) {
    return { status: "rejected", reason: "too_large" };
  }
  return { status: "signable", fileContent: content };
};

type EntityPropertyTarget = {
  entityId: SafeId<"entity">;
  propertyId: SafeId<"property">;
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
};

/**
 * The file field the browser offered "Sign" on, read off the entity's live
 * current version. `null` when the entity, its current version, or the field
 * is absent.
 */
export const readCurrentPdfSigningTarget = async ({
  entityId,
  propertyId,
  tx,
  workspaceId,
}: EntityPropertyTarget) => {
  const entity = await tx.query.entities.findFirst({
    where: { id: { eq: entityId }, workspaceId: { eq: workspaceId } },
    columns: { name: true, readOnly: true },
    with: {
      currentVersion: {
        columns: { id: true, versionNumber: true },
        with: { fields: { columns: { content: true, propertyId: true } } },
      },
    },
  });

  const currentVersion = entity?.currentVersion;
  if (!entity || !currentVersion) {
    return null;
  }

  const field = currentVersion.fields.find(
    (candidate) => candidate.propertyId === propertyId,
  );
  if (!field) {
    return null;
  }

  return {
    baseVersionId: currentVersion.id,
    baseVersionNumber: currentVersion.versionNumber,
    entityName: entity.name,
    readOnly: entity.readOnly,
    target: asSignablePdfContent(field.content),
  };
};

type VersionPropertyTarget = {
  entityVersionId: SafeId<"entityVersion">;
  propertyId: SafeId<"property">;
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
};

/**
 * The same field on a pinned version. Tombstoned versions are excluded here,
 * the single chokepoint that serves a signing exchange's base bytes, so a
 * withdrawn version can never be read back through a live session.
 */
export const readVersionPdfSigningTarget = async ({
  entityVersionId,
  propertyId,
  tx,
  workspaceId,
}: VersionPropertyTarget): Promise<PdfSigningTarget | null> => {
  const rows = await tx
    .select({ content: fields.content })
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
  return row ? asSignablePdfContent(row.content) : null;
};

type PdfSigningFileDescriptorOptions = {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fileContent: PdfFieldContent;
  propertyId: SafeId<"property">;
  workspaceId: SafeId<"workspace">;
};

/** The descriptor `readEntityVersionFile` needs to fetch the stored bytes. */
export const pdfSigningFileDescriptor = ({
  entityId,
  entityVersionId,
  fileContent,
  propertyId,
  workspaceId,
}: PdfSigningFileDescriptorOptions): EntityVersionFile => ({
  entityId,
  entityVersionId,
  fileId: brandPersistedUserFileId(fileContent.id),
  fileName: fileContent.fileName,
  filePropertyId: propertyId,
  mimeType: fileContent.mimeType,
  sizeBytes: fileContent.sizeBytes,
  workspaceId,
});
