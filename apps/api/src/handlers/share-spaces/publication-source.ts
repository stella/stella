import { and, eq, isNull } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { entities, entityVersions, fields } from "@/api/db/schema";
import { isConvertibleMimeType } from "@/api/handlers/files/gotenberg";
import type { SafeId } from "@/api/lib/branded-types";
import { PDF_MIME_TYPE } from "@/api/mime-types";

type LoadPublicationSourceOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
};

export const PUBLICATION_SOURCE_ERROR = {
  encrypted: "encrypted_source",
  invalid: "invalid_source",
  scanWarnings: "scan_warnings",
  unsupportedDisplay: "unsupported_display",
} as const;

export type PublicationSourceErrorCode =
  (typeof PUBLICATION_SOURCE_ERROR)[keyof typeof PUBLICATION_SOURCE_ERROR];

export type PublicationSource = {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  displayName: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256Hex: string;
  fileId: string;
  pdfFileId: string | null;
  thumbnailFileId: string | null;
  versionStamp: string | null;
  verificationCode: string | null;
};

export type LoadPublicationSourceResult =
  | { status: "ready"; source: PublicationSource }
  | { status: "error"; code: PublicationSourceErrorCode };

/**
 * Resolve one exact, live document-version file field. All ownership joins and
 * the tombstone check happen in one statement so stale or cross-document IDs
 * fail as the same invalid-source result.
 */
export const loadPublicationSource = async ({
  tx,
  workspaceId,
  entityId,
  entityVersionId,
  fieldId,
}: LoadPublicationSourceOptions): Promise<LoadPublicationSourceResult> => {
  const row = await tx
    .select({
      entityId: entities.id,
      entityKind: entities.kind,
      displayName: entities.displayName,
      entityVersionId: entityVersions.id,
      versionStamp: entityVersions.stamp,
      verificationCode: entityVersions.verificationCode,
      fieldId: fields.id,
      content: fields.content,
    })
    .from(fields)
    .innerJoin(
      entityVersions,
      and(
        eq(entityVersions.id, fields.entityVersionId),
        eq(entityVersions.workspaceId, fields.workspaceId),
      ),
    )
    .innerJoin(
      entities,
      and(
        eq(entities.id, entityVersions.entityId),
        eq(entities.workspaceId, entityVersions.workspaceId),
      ),
    )
    .where(
      and(
        eq(fields.id, fieldId),
        eq(fields.workspaceId, workspaceId),
        eq(entityVersions.id, entityVersionId),
        eq(entities.id, entityId),
        isNull(entityVersions.deletedAt),
      ),
    )
    .limit(1);
  const source = row.at(0);

  if (!source || source.entityKind !== "document") {
    return { status: "error", code: PUBLICATION_SOURCE_ERROR.invalid };
  }
  if (source.content.type !== "file") {
    return { status: "error", code: PUBLICATION_SOURCE_ERROR.invalid };
  }
  if (source.content.encrypted) {
    return { status: "error", code: PUBLICATION_SOURCE_ERROR.encrypted };
  }
  if ((source.content.scanWarnings?.length ?? 0) > 0) {
    return { status: "error", code: PUBLICATION_SOURCE_ERROR.scanWarnings };
  }
  if (
    source.content.mimeType !== PDF_MIME_TYPE &&
    !source.content.pdfFileId &&
    !isConvertibleMimeType(source.content.mimeType)
  ) {
    return {
      status: "error",
      code: PUBLICATION_SOURCE_ERROR.unsupportedDisplay,
    };
  }

  return {
    status: "ready",
    source: {
      entityId: source.entityId,
      entityVersionId: source.entityVersionId,
      fieldId: source.fieldId,
      displayName: source.displayName,
      fileName: source.content.fileName,
      mimeType: source.content.mimeType,
      sizeBytes: source.content.sizeBytes,
      sha256Hex: source.content.sha256Hex,
      fileId: source.content.id,
      pdfFileId: source.content.pdfFileId,
      thumbnailFileId: source.content.thumbnailFileId ?? null,
      versionStamp: source.versionStamp,
      verificationCode: source.verificationCode,
    },
  };
};
