import { Result } from "better-result";
import { and, eq, like } from "drizzle-orm";
import { status, t, type Static } from "elysia";
import { nanoid } from "nanoid";

import { db, type Transaction } from "@/api/db";
import { jsonField } from "@/api/db/json-utils";
import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import {
  convertToPdf,
  isConvertibleMimeType,
} from "@/api/handlers/files/gotenberg";
import { isEncryptedPdf } from "@/api/handlers/files/pdf-utils";
import { createFileKey } from "@/api/handlers/files/utils";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { escapeLike } from "@/api/lib/escape-like";
import { scanFile } from "@/api/lib/file-scan/scan";
import { FILE_SIZE_LIMITS, LIMITS } from "@/api/lib/limits";
import { captureError } from "@/api/lib/posthog";
import { s3 } from "@/api/lib/s3";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { PDF_MIME_TYPE } from "@/api/mime-types";

export const uploadEntityBodySchema = t.Object({
  file: t.File({
    maxSize: FILE_SIZE_LIMITS.document,
  }),
  name: tDefaultVarchar,
  propertyId: tNanoid,
});

type UploadEntityHandlerProps = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: string;
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

export const uploadEntityHandler = async ({
  organizationId,
  workspaceId,
  userId,
  body: { file, name, propertyId },
}: UploadEntityHandlerProps) => {
  const [entityCount, property] = await Promise.all([
    db.$count(entities, eq(entities.workspaceId, workspaceId)),
    db.query.properties.findFirst({
      columns: { id: true, content: true },
      where: { id: propertyId, workspaceId: { eq: workspaceId } },
    }),
  ]);

  if (entityCount >= LIMITS.entitiesCount) {
    return status(400, { message: "Entities limit reached" });
  }

  if (!property) {
    return status(400, {
      message: "Property not found in workspace",
    });
  }

  if (property.content.type !== "file") {
    return status(400, {
      message: "Property isn't of type file",
    });
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
    return status(422, {
      message: "File security scan failed",
    });
  }

  if (scanResult.value.verdict === "reject") {
    const reasons = scanResult.value.findings
      .filter((f) => f.severity === "reject")
      .map((f) => f.message);
    return status(422, {
      message: `File rejected: ${reasons.join("; ")}`,
    });
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
      return status(422, {
        message: "Failed to open PDF: file appears corrupted",
      });
    }

    encrypted = result.value;
  }

  const fileId = nanoid();
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
    s3.write(sourceKey, new Uint8Array(fileBuffer)),
    shouldConvert ? convertToPdf(fileBuffer, name) : Promise.resolve(null),
  ]);

  // If conversion was expected but failed, clean up and
  // return error so the client can retry
  if (conversionResult && Result.isError(conversionResult)) {
    captureError(conversionResult.error, {
      mimeType: file.type,
      sizeBytes: String(fileBuffer.byteLength),
    });
    await s3.delete(sourceKey);
    return status(502, {
      message: "File conversion to PDF failed",
    });
  }

  // Upload converted PDF if conversion succeeded
  let pdfFileId: string | null = null;

  if (conversionResult && Result.isOk(conversionResult)) {
    pdfFileId = nanoid();

    const pdfKey = createFileKey({
      organizationId,
      workspaceId,
      fileId: pdfFileId,
      mimeType: PDF_MIME_TYPE,
    });

    s3Keys.push(pdfKey);

    await s3.write(pdfKey, new Uint8Array(conversionResult.value.buffer));
  }

  try {
    const entityId = nanoid();
    const entityVersionId = nanoid();

    const fileName = await db.transaction(async (tx) => {
      const resolvedName = await resolveFileName({ tx, propertyId, name });

      await tx.insert(entities).values({
        id: entityId,
        workspaceId,
        createdBy: userId,
      });

      await tx.insert(entityVersions).values({
        id: entityVersionId,
        entityId,
      });

      await tx
        .update(entities)
        .set({ currentVersionId: entityVersionId })
        .where(eq(entities.id, entityId));

      await tx.insert(fields).values({
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
          scanWarnings,
        },
      });

      await tx
        .update(workspaces)
        .set({ lastActivityAt: new Date() })
        .where(eq(workspaces.id, workspaceId));

      return resolvedName;
    });

    await processExtraction(entityId).catch((err) =>
      captureError(err, { entityId, mimeType: file.type }),
    );

    return {
      entityId,
      fileId,
      fileName: fileName.value,
      renamed: fileName.renamed,
    };
  } catch (error) {
    await Promise.all(s3Keys.map((key) => s3.delete(key)));
    throw error;
  }
};
