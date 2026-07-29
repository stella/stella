import { Result } from "better-result";

import { createEntityVersionFromBuffer } from "@/api/handlers/entities/create-version-from-buffer";
import { uploadVersionBodySchema } from "@/api/handlers/entities/upload-version-schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getScanWarnings, scanFile } from "@/api/lib/file-scan/scan";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

const config = {
  permissions: { entity: ["update"] },
  mcp: { type: "capability", reason: "document_processing" },
  body: uploadVersionBodySchema,
} satisfies HandlerConfig;

/**
 * Legacy multipart transport for creating an entity version. The canonical
 * persistence transaction lives in createEntityVersionFromBuffer, which is
 * also used by server-generated template fills; the presigned transport joins
 * the same writeFileVersion transaction after promoting its staged object.
 *
 * @yields Safe database and handler errors to createSafeHandler.
 */
export default createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    body,
    session,
    user,
    recordAuditEvent,
  }) {
    const organizationId = session.activeOrganizationId;
    const userId = user.id;
    const { entityId, file } = body;
    const sanitizedName = sanitizeFilename(file.name);

    // Reject an invalid target before spending scan/storage work. The shared
    // transaction repeats these checks under FOR UPDATE to close the race.
    const entity = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          where: {
            id: { eq: entityId },
            workspaceId: { eq: workspaceId },
          },
          columns: { currentVersionId: true, readOnly: true },
        }),
      ),
    );
    if (!entity?.currentVersionId) {
      return Result.err(
        new HandlerError({ status: 404, message: "Entity not found" }),
      );
    }
    if (entity.readOnly) {
      return Result.err(
        new HandlerError({ status: 409, message: "Entity is read-only" }),
      );
    }

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
      const reasons = scanResult.value.findings.flatMap((finding) =>
        finding.severity === "reject" ? [finding.message] : [],
      );
      return Result.err(
        new HandlerError({
          status: 422,
          message: `File rejected: ${reasons.join("; ")}`,
        }),
      );
    }

    const created = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await createEntityVersionFromBuffer({
            safeDb,
            organizationId,
            workspaceId,
            entityId,
            userId,
            recordAuditEvent,
            buffer: fileBuffer,
            fileName: sanitizedName,
            mimeType: file.type,
            scanWarnings: getScanWarnings(scanResult.value) ?? undefined,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to store entity version",
            cause,
          }),
      }),
    );
    if (Result.isError(created)) {
      let status: 400 | 404 | 409 = 404;
      if (created.error.code === "entity-read-only") {
        status = 409;
      } else if (created.error.code === "missing-file-field") {
        status = 400;
      }
      return Result.err(
        new HandlerError({ status, message: created.error.message }),
      );
    }

    return Result.ok({
      fieldId: created.value.fieldId,
      versionId: created.value.entityVersionId,
      versionNumber: created.value.versionNumber,
    });
  },
);
