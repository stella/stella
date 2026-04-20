import { Result, TaggedError } from "better-result";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import {
  convertToPdf,
  isConvertibleMimeType,
} from "@/api/handlers/files/gotenberg";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { allocateEntityStamp } from "@/api/lib/document-counter";
import { LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { PDF_MIME_TYPE } from "@/api/mime-types";

type CreateEntityFromBufferInput = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  buffer: Uint8Array | ArrayBuffer;
  fileName: string;
  mimeType: string;
};

class EntityLimitError extends TaggedError("EntityLimitError")<{
  message: string;
}>() {}

class MissingFilePropertyError extends TaggedError("MissingFilePropertyError")<{
  message: string;
}>() {}

export type CreateEntityFromBufferResult = Result<
  {
    entityId: string;
    fileName: string;
  },
  EntityLimitError | MissingFilePropertyError
>;

/**
 * Create a new entity from a raw file buffer. Handles S3
 * upload, Gotenberg PDF conversion, DB entity creation,
 * and triggers search extraction.
 *
 * Shared between the upload handler and AI chat tools.
 */
export const createEntityFromBuffer = async ({
  scopedDb,
  organizationId,
  workspaceId,
  userId,
  buffer,
  fileName,
  mimeType,
}: CreateEntityFromBufferInput): Promise<CreateEntityFromBufferResult> => {
  const fileId = crypto.randomUUID();
  const s3Key = createFileKey({
    organizationId,
    workspaceId,
    fileId,
    mimeType,
  });

  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const sha256Hex = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

  // Check for file property before uploading to avoid
  // orphaned S3 files if the property doesn't exist.
  const wsProperties = await scopedDb((tx) =>
    tx.query.properties.findMany({
      columns: { id: true, content: true },
      where: { workspaceId: { eq: workspaceId } },
    }),
  );
  const fileProperty = wsProperties.find((p) => p.content.type === "file");

  if (!fileProperty) {
    return Result.err(
      new MissingFilePropertyError({
        message: "No file property found",
      }),
    );
  }

  // Track S3 keys for cleanup before any uploads.
  const s3Keys = [s3Key];

  let pdfFileId: string | null = null;

  const entityId = crypto.randomUUID();
  const entityVersionId = crypto.randomUUID();

  try {
    // Upload source file and convert to PDF in parallel.
    const shouldConvert = isConvertibleMimeType(mimeType);

    const [pdfResult] = await Promise.all([
      shouldConvert
        ? convertToPdf(bytes.slice().buffer, fileName, mimeType)
        : Promise.resolve(null),
      getS3().write(s3Key, bytes),
    ]);

    if (pdfResult && Result.isOk(pdfResult)) {
      pdfFileId = crypto.randomUUID();
      const pdfKey = createFileKey({
        organizationId,
        workspaceId,
        fileId: pdfFileId,
        mimeType: PDF_MIME_TYPE,
      });
      s3Keys.push(pdfKey);
      await getS3().write(pdfKey, new Uint8Array(pdfResult.value.buffer));
    }

    await scopedDb(async (tx) => {
      // The authoritative limit check must stay in the same
      // transaction as the insert to avoid TOCTOU races.
      const entityCount = await tx.$count(
        entities,
        eq(entities.workspaceId, workspaceId),
      );
      if (entityCount >= LIMITS.entitiesCount) {
        throw new EntityLimitError({
          message: "Entities limit reached",
        });
      }

      const entityStamp = await allocateEntityStamp(tx, workspaceId);

      await tx.insert(entities).values({
        id: entityId,
        workspaceId,
        createdBy: userId,
        docSequence: entityStamp.docSequence,
      });

      await tx.insert(entityVersions).values({
        id: entityVersionId,
        workspaceId,
        entityId,
        versionNumber: 1,
        stamp: entityStamp.stamp,
        verificationCode: entityStamp.verificationCode,
      });

      await tx
        .update(entities)
        .set({ currentVersionId: entityVersionId })
        .where(eq(entities.id, entityId));

      await tx.insert(fields).values({
        workspaceId,
        propertyId: fileProperty.id,
        entityVersionId,
        content: {
          type: "file",
          version: 1,
          id: fileId,
          fileName,
          mimeType,
          sizeBytes: bytes.byteLength,
          encrypted: false,
          sha256Hex,
          pdfFileId,
        },
      });

      await tx
        .update(workspaces)
        .set({ lastActivityAt: new Date() })
        .where(eq(workspaces.id, workspaceId));
    });
  } catch (error) {
    await Promise.all(s3Keys.map(async (k) => await getS3().delete(k)));

    if (EntityLimitError.is(error)) {
      return Result.err(error);
    }

    throw error;
  }

  processExtraction(entityId).catch(captureError);

  return Result.ok({ entityId, fileName });
};
