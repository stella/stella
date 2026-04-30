import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import { computeVersionDiffStats } from "@/api/handlers/entities/compute-version-diff";
import { uploadVersionBodySchema } from "@/api/handlers/entities/upload-version-schema";
import {
  buildVersionStamp,
  cloneFieldsForRevision,
} from "@/api/handlers/entities/version-utils";
import {
  convertToPdf,
  isConvertibleMimeType,
} from "@/api/handlers/files/gotenberg";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getScanWarnings, scanFile } from "@/api/lib/file-scan/scan";
import { getS3 } from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { broadcast } from "@/api/lib/sse";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const config = {
  permissions: { entity: ["update"] },
  body: uploadVersionBodySchema,
} satisfies HandlerConfig;

export default createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, session, user }) {
    const organizationId = session.activeOrganizationId;
    const userId = user.id;
    const { entityId, file } = body;
    const sanitizedName = sanitizeFilename(file.name);

    // Verify entity exists and get current version info
    const entity = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          where: {
            id: { eq: entityId },
            workspaceId: { eq: workspaceId },
          },
          columns: {
            currentVersionId: true,
            docSequence: true,
            id: true,
            readOnly: true,
          },
        }),
      ),
    );

    if (!entity || !entity.currentVersionId) {
      return Result.err(
        new HandlerError({ status: 404, message: "Entity not found" }),
      );
    }
    if (entity.readOnly) {
      return Result.err(
        new HandlerError({ status: 409, message: "Entity is read-only" }),
      );
    }

    const currentVersionId = entity.currentVersionId;

    // Get current version number and fields
    const currentVersion = yield* Result.await(
      safeDb((tx) =>
        tx.query.entityVersions.findFirst({
          where: { id: { eq: currentVersionId } },
          columns: { versionNumber: true },
          with: {
            fields: { columns: { content: true, propertyId: true } },
          },
        }),
      ),
    );

    if (!currentVersion) {
      return Result.err(
        new HandlerError({ status: 404, message: "Current version not found" }),
      );
    }

    // Find the file property from existing fields
    const fileField = currentVersion.fields.find(
      (f) => f.content.type === "file",
    );
    if (!fileField) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Entity has no file field",
        }),
      );
    }

    // Scan the uploaded file
    const fileBuffer = await file.arrayBuffer();
    const scanResult = await scanFile({
      buffer: new Uint8Array(fileBuffer),
      declaredMimeType: file.type,
      fileName: sanitizedName,
    });

    if (Result.isError(scanResult)) {
      return Result.err(
        new HandlerError({ status: 422, message: "File scan failed" }),
      );
    }

    if (scanResult.value.verdict === "reject") {
      const reasons = scanResult.value.findings
        .filter((finding) => finding.severity === "reject")
        .map((finding) => finding.message);
      return Result.err(
        new HandlerError({
          status: 422,
          message: `File rejected: ${reasons.join("; ")}`,
        }),
      );
    }

    const scanWarnings = getScanWarnings(scanResult.value) ?? undefined;

    // Upload to S3 and convert to PDF
    const fileId = Bun.randomUUIDv7();
    const sha256Hex = new Bun.CryptoHasher("sha256")
      .update(new Uint8Array(fileBuffer))
      .digest("hex");
    const sourceKey = createFileKey({
      organizationId,
      workspaceId,
      fileId,
      mimeType: file.type,
    });

    const shouldConvert = isConvertibleMimeType(file.type);
    const [, conversionResult] = await Promise.all([
      getS3().write(sourceKey, new Uint8Array(fileBuffer)),
      shouldConvert
        ? convertToPdf(fileBuffer, sanitizedName, file.type)
        : Promise.resolve(null),
    ]);

    if (conversionResult && Result.isError(conversionResult)) {
      await getS3().delete(sourceKey);
      return Result.err(
        new HandlerError({
          status: 502,
          message: "File conversion to PDF failed",
        }),
      );
    }

    let pdfFileId: string | null = null;
    if (conversionResult && Result.isOk(conversionResult)) {
      pdfFileId = Bun.randomUUIDv7();
      const pdfKey = createFileKey({
        organizationId,
        workspaceId,
        fileId: pdfFileId,
        mimeType: PDF_MIME_TYPE,
      });
      await getS3().write(
        pdfKey,
        new Uint8Array(conversionResult.value.buffer),
      );
    }

    // Get workspace reference for stamp
    const workspace = yield* Result.await(
      safeDb((tx) =>
        tx.query.workspaces.findFirst({
          where: { id: { eq: workspaceId } },
          columns: { reference: true },
        }),
      ),
    );

    const nextVersionNumber = currentVersion.versionNumber + 1;
    const nextVersionId = createSafeId<"entityVersion">();
    const nextVersionStamp = buildVersionStamp({
      docSequence: entity.docSequence,
      versionNumber: nextVersionNumber,
      workspaceReference: workspace?.reference ?? null,
    });

    // Create new version in DB
    yield* Result.await(
      safeDb(async (tx) => {
        await tx.insert(entityVersions).values({
          createdBy: userId,
          entityId,
          id: nextVersionId,
          stamp: nextVersionStamp.stamp,
          verificationCode: nextVersionStamp.verificationCode,
          versionNumber: nextVersionNumber,
          workspaceId,
        });

        await tx.insert(fields).values(
          cloneFieldsForRevision({
            currentFields: currentVersion.fields,
            entityVersionId: nextVersionId,
            propertyId: fileField.propertyId,
            replacementContent: {
              encrypted: false,
              fileName: sanitizedName,
              id: fileId,
              mimeType: file.type,
              pdfFileId,
              sha256Hex,
              sizeBytes: file.size,
              type: "file",
              version: 1,
              ...(scanWarnings !== undefined && { scanWarnings }),
            },
            workspaceId,
          }),
        );

        await tx
          .update(entities)
          .set({
            currentVersionId: nextVersionId,
            lastEditedBy: userId,
            updatedAt: new Date(),
          })
          .where(eq(entities.id, entityId));

        await tx
          .update(workspaces)
          .set({ lastActivityAt: new Date() })
          .where(eq(workspaces.id, workspaceId));
      }),
    );

    // Fire-and-forget: extraction + diff stats
    processExtraction(entityId).catch((error: unknown) => {
      captureError(error, { entityId });
    });

    computeVersionDiffStats({
      versionId: nextVersionId,
      entityId,
      workspaceId,
      organizationId,
    }).catch((error: unknown) => {
      captureError(error, { versionId: nextVersionId });
    });

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["entities", workspaceId],
    });

    return Result.ok({
      versionId: nextVersionId,
      versionNumber: nextVersionNumber,
    });
  },
);
