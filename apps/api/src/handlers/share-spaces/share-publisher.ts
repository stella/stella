import { Result, TaggedError } from "better-result";
import { and, eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { shareItems, shareSpaces } from "@/api/db/schema";
import { convertToPdf } from "@/api/handlers/files/gotenberg";
import { THUMBNAIL_MIME_TYPE } from "@/api/handlers/files/image-derivative";
import { createFileKey, deleteS3Keys } from "@/api/handlers/files/utils";
import { loadPublicationSource } from "@/api/handlers/share-spaces/publication-source";
import {
  createShareDisplayStorageKey,
  createShareOriginalStorageKey,
  createShareThumbnailStorageKey,
} from "@/api/handlers/share-spaces/storage";
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { getS3 } from "@/api/lib/s3";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const SHARE_PUBLICATION_FAILURE = {
  conversionFailed: "conversion_failed",
  copyFailed: "copy_failed",
  sourceChanged: "source_changed",
  stateChanged: "state_changed",
} as const;

type SharePublicationFailureCode =
  | (typeof SHARE_PUBLICATION_FAILURE)[keyof typeof SHARE_PUBLICATION_FAILURE]
  | "encrypted_source"
  | "invalid_source"
  | "scan_warnings"
  | "unsupported_display";

export class SharePublicationError extends TaggedError(
  "SharePublicationError",
)<{
  message: string;
  failureCode: SharePublicationFailureCode;
  cause?: unknown;
}>() {}

type PublishShareItemOptions = {
  scopedDb: ScopedDb;
  recordAuditEvent: AuditRecorder;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  shareSpaceId: SafeId<"shareSpace">;
  shareItemId: SafeId<"shareItem">;
  storage?: SharePublicationStorage;
  convertDisplay?: ConvertShareDisplay;
};

export type SharePublicationStorage = {
  copy: (
    sourceKey: string,
    targetKey: string,
    mimeType: string,
  ) => Promise<void>;
  read: (key: string) => Promise<ArrayBuffer>;
  write: (key: string, bytes: ArrayBuffer, mimeType: string) => Promise<void>;
  delete: (keys: string[]) => Promise<void>;
};

export type ConvertShareDisplay = (
  source: ArrayBuffer,
  fileName: string,
  mimeType: string,
) => Promise<ArrayBuffer>;

const defaultStorage = (): SharePublicationStorage => ({
  copy: async (sourceKey, targetKey, mimeType) => {
    const s3 = getS3();
    await s3.write(targetKey, s3.file(sourceKey), { type: mimeType });
  },
  read: async (key) => await getS3().file(key).arrayBuffer(),
  write: async (key, bytes, mimeType) => {
    await getS3().write(key, bytes, { type: mimeType });
  },
  delete: async (keys) => {
    const result = await deleteS3Keys(keys);
    if (Result.isError(result)) {
      throw result.error;
    }
  },
});

const defaultConvertDisplay: ConvertShareDisplay = async (
  source,
  fileName,
  mimeType,
) => {
  const converted = await convertToPdf(source, fileName, mimeType);
  if (Result.isError(converted)) {
    throw converted.error;
  }
  return converted.value.buffer;
};

const sourceChanged = (
  item: {
    originalFileName: string;
    originalMimeType: string;
    originalSizeBytes: number;
    originalSha256Hex: string;
  },
  source: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    sha256Hex: string;
  },
): boolean =>
  item.originalFileName !== source.fileName ||
  item.originalMimeType !== source.mimeType ||
  item.originalSizeBytes !== source.sizeBytes ||
  item.originalSha256Hex !== source.sha256Hex;

const toPublicationError = (cause: unknown): SharePublicationError =>
  cause instanceof SharePublicationError
    ? cause
    : new SharePublicationError({
        message: "Failed to copy Share Space snapshot assets.",
        failureCode: SHARE_PUBLICATION_FAILURE.copyFailed,
        cause,
      });

/**
 * Copy the original and display assets, then atomically activate the item and
 * its one-document Share Space. S3 work happens outside DB transactions.
 */
export const publishShareItem = async ({
  scopedDb,
  recordAuditEvent,
  organizationId,
  workspaceId,
  shareSpaceId,
  shareItemId,
  storage = defaultStorage(),
  convertDisplay = defaultConvertDisplay,
}: PublishShareItemOptions): Promise<Result<void, SharePublicationError>> => {
  const copiedKeys: string[] = [];

  const publishResult = await Result.tryPromise({
    try: async () => {
      const item = await scopedDb((tx) =>
        tx.query.shareItems.findFirst({
          where: {
            id: { eq: shareItemId },
            shareSpaceId: { eq: shareSpaceId },
            workspaceId: { eq: workspaceId },
          },
          columns: {
            id: true,
            status: true,
            originalFileName: true,
            originalMimeType: true,
            originalSizeBytes: true,
            originalSha256Hex: true,
            sourceEntityId: true,
            sourceEntityVersionId: true,
            sourceFieldId: true,
          },
          with: { shareSpace: { columns: { status: true } } },
        }),
      );

      if (item?.status === "ready" && item.shareSpace?.status === "active") {
        return;
      }
      if (
        !item ||
        item.status !== "publishing" ||
        item.shareSpace?.status !== "publishing"
      ) {
        throw new SharePublicationError({
          message: "Share Space publication state changed before copying.",
          failureCode: SHARE_PUBLICATION_FAILURE.stateChanged,
        });
      }

      const sourceResult = await scopedDb(
        async (tx) =>
          await loadPublicationSource({
            tx,
            workspaceId,
            entityId: item.sourceEntityId,
            entityVersionId: item.sourceEntityVersionId,
            fieldId: item.sourceFieldId,
          }),
      );
      if (sourceResult.status === "error") {
        throw new SharePublicationError({
          message: "The source document is no longer publishable.",
          failureCode: sourceResult.code,
        });
      }
      const { source } = sourceResult;
      if (sourceChanged(item, source)) {
        throw new SharePublicationError({
          message: "The source file metadata changed before publication.",
          failureCode: SHARE_PUBLICATION_FAILURE.sourceChanged,
        });
      }

      const sourceOriginalKey = createFileKey({
        organizationId,
        workspaceId,
        fileId: source.fileId,
        mimeType: source.mimeType,
      });
      const targetOptions = { organizationId, shareSpaceId, shareItemId };
      const originalStorageKey = createShareOriginalStorageKey({
        ...targetOptions,
        mimeType: source.mimeType,
      });
      const displayStorageKey = createShareDisplayStorageKey({
        ...targetOptions,
        mimeType: PDF_MIME_TYPE,
      });
      await storage.copy(
        sourceOriginalKey,
        originalStorageKey,
        source.mimeType,
      );
      copiedKeys.push(originalStorageKey);

      if (source.mimeType === PDF_MIME_TYPE) {
        await storage.copy(sourceOriginalKey, displayStorageKey, PDF_MIME_TYPE);
      } else if (source.pdfFileId) {
        const sourceDisplayKey = createFileKey({
          organizationId,
          workspaceId,
          fileId: source.pdfFileId,
          mimeType: PDF_MIME_TYPE,
        });
        await storage.copy(sourceDisplayKey, displayStorageKey, PDF_MIME_TYPE);
      } else {
        const originalBuffer = await storage.read(sourceOriginalKey);
        const converted = await Result.tryPromise({
          try: async () =>
            await convertDisplay(
              originalBuffer,
              source.fileName,
              source.mimeType,
            ),
          catch: (cause) => cause,
        });
        if (Result.isError(converted)) {
          throw new SharePublicationError({
            message: "Failed to create the external PDF display asset.",
            failureCode: SHARE_PUBLICATION_FAILURE.conversionFailed,
            cause: converted.error,
          });
        }
        await storage.write(displayStorageKey, converted.value, PDF_MIME_TYPE);
      }
      copiedKeys.push(displayStorageKey);

      let thumbnailStorageKey: string | null = null;
      if (source.thumbnailFileId) {
        const sourceThumbnailKey = createFileKey({
          organizationId,
          workspaceId,
          fileId: source.thumbnailFileId,
          mimeType: THUMBNAIL_MIME_TYPE,
        });
        thumbnailStorageKey = createShareThumbnailStorageKey(targetOptions);
        await storage.copy(
          sourceThumbnailKey,
          thumbnailStorageKey,
          THUMBNAIL_MIME_TYPE,
        );
        copiedKeys.push(thumbnailStorageKey);
      }

      await scopedDb(async (tx) => {
        const activatedItems = await tx
          .update(shareItems)
          .set({
            status: "ready",
            originalStorageKey,
            displayMimeType: PDF_MIME_TYPE,
            displayStorageKey,
            thumbnailStorageKey,
            publishedAt: new Date(),
          })
          .where(
            and(
              eq(shareItems.id, shareItemId),
              eq(shareItems.shareSpaceId, shareSpaceId),
              eq(shareItems.status, "publishing"),
            ),
          )
          .returning({ id: shareItems.id });
        if (activatedItems.length !== 1) {
          throw new SharePublicationError({
            message: "Share item state changed before activation.",
            failureCode: SHARE_PUBLICATION_FAILURE.stateChanged,
          });
        }

        const activatedSpaces = await tx
          .update(shareSpaces)
          .set({ status: "active" })
          .where(
            and(
              eq(shareSpaces.id, shareSpaceId),
              eq(shareSpaces.status, "publishing"),
            ),
          )
          .returning({ id: shareSpaces.id });
        if (activatedSpaces.length !== 1) {
          throw new SharePublicationError({
            message: "Share Space state changed before activation.",
            failureCode: SHARE_PUBLICATION_FAILURE.stateChanged,
          });
        }

        await recordAuditEvent(tx, [
          {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.SHARE_ITEM,
            resourceId: shareItemId,
            changes: {
              status: { old: "publishing", new: "ready" },
            },
          },
          {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.SHARE_SPACE,
            resourceId: shareSpaceId,
            changes: {
              status: { old: "publishing", new: "active" },
            },
          },
        ]);
      });
    },
    catch: toPublicationError,
  });

  if (!Result.isError(publishResult)) {
    return Result.ok();
  }

  const cleanupResult = await Result.tryPromise(async () => {
    await storage.delete(copiedKeys);
  });
  if (Result.isError(cleanupResult)) {
    captureError(cleanupResult.error, {
      operation: "share_publication.cleanup",
      shareItemId,
      shareSpaceId,
    });
  }

  if (
    publishResult.error.failureCode !== SHARE_PUBLICATION_FAILURE.stateChanged
  ) {
    await scopedDb(async (tx) => {
      const failedItems = await tx
        .update(shareItems)
        .set({
          status: "failed",
          failureCode: publishResult.error.failureCode,
        })
        .where(
          and(
            eq(shareItems.id, shareItemId),
            eq(shareItems.status, "publishing"),
          ),
        )
        .returning({ id: shareItems.id });
      const resetSpaces = await tx
        .update(shareSpaces)
        .set({ status: "draft" })
        .where(
          and(
            eq(shareSpaces.id, shareSpaceId),
            eq(shareSpaces.status, "publishing"),
          ),
        )
        .returning({ id: shareSpaces.id });

      if (failedItems.length > 0 || resetSpaces.length > 0) {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.SHARE_SPACE,
          resourceId: shareSpaceId,
          metadata: { publicationFailure: publishResult.error.failureCode },
        });
      }
    });
  }

  return Result.err(publishResult.error);
};
