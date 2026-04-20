import { Result } from "better-result";
import { and, eq, like } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb, Transaction } from "@/api/db";
import { jsonField } from "@/api/db/json-utils";
import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import {
  convertToPdf,
  isConvertibleMimeType,
} from "@/api/handlers/files/gotenberg";
import { isEncryptedPdf } from "@/api/handlers/files/pdf-utils";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { allocateEntityStamp } from "@/api/lib/document-counter";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { scanFile } from "@/api/lib/file-scan/scan";
import { FILE_SIZE_LIMITS, LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const uploadEntityBodySchema = t.Object({
  file: t.File({
    maxSize: FILE_SIZE_LIMITS.document,
  }),
  name: tDefaultVarchar,
  propertyId: tNanoid,
});

type UploadEntityHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  body: Static<typeof uploadEntityBodySchema>;
};

type ResolveFileNameProps = {
  tx: Transaction;
  propertyId: string;
  name: string;
};

const resolveFileName = async ({
  tx,
  propertyId,
  name,
}: ResolveFileNameProps) => {
  const lastDot = name.lastIndexOf(".");
  const base = lastDot === -1 ? name : name.slice(0, lastDot);
  const ext = lastDot === -1 ? "" : name.slice(lastDot);

  const pattern = `${escapeLike(base)}%${escapeLike(ext)}`;

  const fieldsCount = await tx.$count(
    fields,
    and(
      eq(fields.propertyId, propertyId),
      like(jsonField(fields.content, "v1")("fileName"), pattern),
    ),
  );

  if (fieldsCount === 0) {
    return { renamed: false, value: name };
  }

  return { renamed: true, value: `${base}_${fieldsCount}${ext}` };
};

const uploadEntityHandler = async function* ({
  safeDb,
  organizationId,
  workspaceId,
  userId,
  body: { file, name: rawName, propertyId },
}: UploadEntityHandlerProps) {
  const name = sanitizeFilename(rawName);
  const [entityCountResult, propertyResult] = await Promise.all([
    safeDb((tx) => tx.$count(entities, eq(entities.workspaceId, workspaceId))),
    safeDb((tx) =>
      tx.query.properties.findFirst({
        columns: { id: true, content: true },
        where: { id: propertyId, workspaceId: { eq: workspaceId } },
      }),
    ),
  ]);

  const entityCount = yield* entityCountResult;
  const property = yield* propertyResult;

  if (entityCount >= LIMITS.entitiesCount) {
    return Result.err(
      new HandlerError({ status: 400, message: "Entities limit reached" }),
    );
  }

  if (!property) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Property not found in workspace",
      }),
    );
  }

  if (property.content.type !== "file") {
    return Result.err(
      new HandlerError({ status: 400, message: "Property isn't of type file" }),
    );
  }

  const fileBuffer = await file.arrayBuffer();
  const sha256Hex = new Bun.CryptoHasher("sha256")
    .update(fileBuffer)
    .digest("hex");

  // Security scan before S3 upload
  const scanResult = await scanFile({
    buffer: new Uint8Array(fileBuffer),
    declaredMimeType: file.type,
    fileName: name,
  });

  if (Result.isError(scanResult)) {
    return Result.err(
      new HandlerError({ status: 422, message: "File security scan failed" }),
    );
  }

  if (scanResult.value.verdict === "reject") {
    const reasons = scanResult.value.findings
      .filter((f) => f.severity === "reject")
      .map((f) => f.message);
    return Result.err(
      new HandlerError({
        status: 422,
        message: `File rejected: ${reasons.join("; ")}`,
      }),
    );
  }

  const scanWarnings =
    scanResult.value.verdict === "warn"
      ? scanResult.value.findings
          .filter((f) => f.severity === "warn")
          .map((f) => f.message)
      : undefined;

  let encrypted = false;
  if (file.type === PDF_MIME_TYPE) {
    const result = await isEncryptedPdf(fileBuffer);

    if (Result.isError(result)) {
      captureError(result.error, {
        mimeType: PDF_MIME_TYPE,
        sizeBytes: String(fileBuffer.byteLength),
      });
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Failed to open PDF: file appears corrupted",
        }),
      );
    }

    encrypted = result.value;
  }

  const fileId = crypto.randomUUID();
  const sourceKey = createFileKey({
    organizationId,
    workspaceId,
    fileId,
    mimeType: file.type,
  });

  const s3Keys = [sourceKey];

  // Run S3 upload and Gotenberg conversion in parallel
  const shouldConvert = !encrypted && isConvertibleMimeType(file.type);

  const [, conversionResult] = await Promise.all([
    getS3().write(sourceKey, new Uint8Array(fileBuffer)),
    shouldConvert
      ? convertToPdf(fileBuffer, name, file.type)
      : Promise.resolve(null),
  ]);

  // If conversion was expected but failed, clean up and
  // return error so the client can retry
  if (conversionResult && Result.isError(conversionResult)) {
    captureError(conversionResult.error, {
      mimeType: file.type,
      sizeBytes: String(fileBuffer.byteLength),
    });
    await getS3().delete(sourceKey);
    return Result.err(
      new HandlerError({
        status: 502,
        message: "File conversion to PDF failed",
      }),
    );
  }

  // Upload converted PDF if conversion succeeded
  let pdfFileId: string | null = null;

  if (conversionResult && Result.isOk(conversionResult)) {
    pdfFileId = crypto.randomUUID();

    const pdfKey = createFileKey({
      organizationId,
      workspaceId,
      fileId: pdfFileId,
      mimeType: PDF_MIME_TYPE,
    });

    s3Keys.push(pdfKey);

    await getS3().write(pdfKey, new Uint8Array(conversionResult.value.buffer));
  }

  try {
    const entityId = crypto.randomUUID();
    const entityVersionId = crypto.randomUUID();

    const fileName = yield* Result.await(
      safeDb(async (tx) => {
        const resolvedName = await resolveFileName({ tx, propertyId, name });

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
          propertyId: property.id,
          entityVersionId,
          content: {
            type: "file",
            version: 1,
            id: fileId,
            fileName: resolvedName.value,
            mimeType: file.type,
            sizeBytes: file.size,
            encrypted,
            sha256Hex,
            pdfFileId,
            ...(scanWarnings !== undefined && { scanWarnings }),
          },
        });

        await tx
          .update(workspaces)
          .set({ lastActivityAt: new Date() })
          .where(eq(workspaces.id, workspaceId));

        return resolvedName;
      }),
    );

    await processExtraction(entityId).catch((error: unknown) =>
      captureError(error, { entityId, mimeType: file.type }),
    );

    return Result.ok({
      entityId,
      fileId,
      fileName: fileName.value,
      renamed: fileName.renamed,
    });
  } catch (error) {
    await Promise.all(s3Keys.map(async (key) => await getS3().delete(key)));
    throw error;
  }
};

const config = {
  permissions: { entity: ["create"] },
  body: uploadEntityBodySchema,
} satisfies HandlerConfig;

const uploadEntity = createSafeHandler(
  config,
  async function* ({ safeDb, session, workspaceId, user, body }) {
    return yield* uploadEntityHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      userId: user.id,
      body,
    });
  },
);

export default uploadEntity;
