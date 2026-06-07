import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  cellMetadata,
  entities,
  entityVersions,
  fields,
  workspaces,
} from "@/api/db/schema";
import { computeVersionDiffStats } from "@/api/handlers/entities/compute-version-diff";
import { uploadVersionBodySchema } from "@/api/handlers/entities/upload-version-schema";
import {
  buildVersionStamp,
  cloneFieldsForRevision,
} from "@/api/handlers/entities/version-utils";
import { pdfDerivativeStateForFile } from "@/api/handlers/files/gotenberg";
import { thumbnailDerivativeStateForFile } from "@/api/handlers/files/image-derivative";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
} from "@/api/lib/file-derivative-queue";
import { getScanWarnings, scanFile } from "@/api/lib/file-scan/scan";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { getS3 } from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { broadcast } from "@/api/lib/sse";

const config = {
  permissions: { entity: ["update"] },
  body: uploadVersionBodySchema,
} satisfies HandlerConfig;

type UploadVersionWriteResult =
  | {
      status: "ok";
      versionNumber: number;
    }
  | {
      status:
        | "current-version-not-found"
        | "entity-not-found"
        | "entity-read-only"
        | "missing-file-field";
    };

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

    // Upload the source file first; PDF derivatives are generated
    // asynchronously by the file-derivative queue.
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

    await getS3().write(sourceKey, new Uint8Array(fileBuffer));

    // Get workspace reference for stamp
    const workspace = yield* Result.await(
      safeDb((tx) =>
        tx.query.workspaces.findFirst({
          where: { id: { eq: workspaceId } },
          columns: { reference: true },
        }),
      ),
    );

    const nextVersionId = createSafeId<"entityVersion">();
    const fileFieldId = createSafeId<"field">();

    // Create new version in DB
    const writeResult = yield* Result.await(
      safeDb(async (tx): Promise<UploadVersionWriteResult> => {
        const entityRows = await tx
          .select({
            currentVersionId: entities.currentVersionId,
            docSequence: entities.docSequence,
            readOnly: entities.readOnly,
          })
          .from(entities)
          .where(
            and(
              eq(entities.id, entityId),
              eq(entities.workspaceId, workspaceId),
            ),
          )
          .limit(1)
          .for("update");
        const lockedEntity = entityRows.at(0);

        if (!lockedEntity?.currentVersionId) {
          return { status: "entity-not-found" };
        }
        if (lockedEntity.readOnly) {
          return { status: "entity-read-only" };
        }

        const freshCurrentVersionId = lockedEntity.currentVersionId;
        const freshCurrentVersion = await tx.query.entityVersions.findFirst({
          where: { id: { eq: freshCurrentVersionId } },
          columns: { versionNumber: true },
          with: {
            fields: { columns: { content: true, propertyId: true } },
          },
        });

        if (!freshCurrentVersion) {
          return { status: "current-version-not-found" };
        }

        const freshFileField = freshCurrentVersion.fields.find(
          (f) => f.content.type === "file",
        );
        if (!freshFileField) {
          return { status: "missing-file-field" };
        }

        const nextVersionNumber = freshCurrentVersion.versionNumber + 1;
        const nextVersionStamp = buildVersionStamp({
          docSequence: lockedEntity.docSequence,
          versionNumber: nextVersionNumber,
          workspaceReference: workspace?.reference ?? null,
        });

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
            currentFields: freshCurrentVersion.fields,
            entityVersionId: nextVersionId,
            propertyId: freshFileField.propertyId,
            replacementFieldId: fileFieldId,
            replacementContent: {
              encrypted: false,
              fileName: sanitizedName,
              id: fileId,
              mimeType: file.type,
              pdfFileId: null,
              sha256Hex,
              sizeBytes: file.size,
              type: "file",
              version: 1,
              pdfDerivative: pdfDerivativeStateForFile({
                encrypted: false,
                mimeType: file.type,
              }),
              thumbnailFileId: null,
              thumbnailDerivative: thumbnailDerivativeStateForFile({
                encrypted: false,
                mimeType: file.type,
              }),
              ...(scanWarnings !== undefined && { scanWarnings }),
            },
            workspaceId,
          }),
        );

        const currentCellMetadataRows = await tx
          .select({
            createdAt: cellMetadata.createdAt,
            createdBy: cellMetadata.createdBy,
            metadata: cellMetadata.metadata,
            propertyId: cellMetadata.propertyId,
            updatedAt: cellMetadata.updatedAt,
            updatedBy: cellMetadata.updatedBy,
          })
          .from(cellMetadata)
          .where(
            and(
              eq(cellMetadata.workspaceId, workspaceId),
              eq(cellMetadata.entityVersionId, freshCurrentVersionId),
            ),
          )
          .for("update");

        const cellMetadataRowsToCopy = currentCellMetadataRows.filter(
          (row) => row.propertyId !== freshFileField.propertyId,
        );

        if (cellMetadataRowsToCopy.length > 0) {
          await tx.insert(cellMetadata).values(
            cellMetadataRowsToCopy.map((row) => ({
              workspaceId,
              entityVersionId: nextVersionId,
              propertyId: row.propertyId,
              metadata: row.metadata,
              createdBy: row.createdBy,
              updatedBy: row.updatedBy,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            })),
          );
        }

        await tx
          .update(entities)
          .set({
            currentVersionId: nextVersionId,
            lastEditedBy: userId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(entities.id, entityId),
              eq(entities.workspaceId, workspaceId),
            ),
          );

        await tx
          .update(workspaces)
          .set({ lastActivityAt: new Date() })
          .where(eq(workspaces.id, workspaceId));

        await recordAuditEvent(tx, [
          {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
            resourceId: nextVersionId,
            changes: {
              created: {
                old: null,
                new: {
                  entityId,
                  versionNumber: nextVersionNumber,
                  fileName: sanitizedName,
                  mimeType: file.type,
                  sizeBytes: file.size,
                  sha256Hex,
                },
              },
            },
            metadata: {
              fileName: sanitizedName,
              mimeType: file.type,
              sizeBytes: file.size,
              sha256Hex,
            },
          },
          {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
            resourceId: entityId,
            changes: {
              currentVersionId: {
                old: freshCurrentVersionId,
                new: nextVersionId,
              },
            },
          },
        ]);

        return { status: "ok", versionNumber: nextVersionNumber };
      }),
    );

    if (writeResult.status !== "ok") {
      switch (writeResult.status) {
        case "entity-not-found":
          return Result.err(
            new HandlerError({ status: 404, message: "Entity not found" }),
          );
        case "entity-read-only":
          return Result.err(
            new HandlerError({ status: 409, message: "Entity is read-only" }),
          );
        case "current-version-not-found":
          return Result.err(
            new HandlerError({
              status: 404,
              message: "Current version not found",
            }),
          );
        case "missing-file-field":
          return Result.err(
            new HandlerError({
              status: 400,
              message: "Entity has no file field",
            }),
          );
      }
    }
    const nextVersionNumber = writeResult.versionNumber;

    // Fire-and-forget: extraction + diff stats
    processExtraction(entityId).catch((error: unknown) => {
      captureError(error, { entityId });
    });

    enqueuePdfDerivativeOrMarkFailed({
      encrypted: false,
      entityId,
      fieldId: fileFieldId,
      mimeType: file.type,
      organizationId,
      userId,
      workspaceId,
    }).catch((error: unknown) => {
      captureError(error, {
        entityId,
        fieldId: fileFieldId,
        mimeType: file.type,
      });
    });

    enqueueImageThumbnailOrMarkFailed({
      encrypted: false,
      entityId,
      fieldId: fileFieldId,
      mimeType: file.type,
      organizationId,
      userId,
      workspaceId,
    }).catch((error: unknown) => {
      captureError(error, {
        entityId,
        fieldId: fileFieldId,
        mimeType: file.type,
      });
    });

    computeVersionDiffStats({
      versionId: nextVersionId,
      entityId,
      scopedDb: createRootScopedDb({
        organizationId,
        userId,
        workspaceIds: [workspaceId],
      }),
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
