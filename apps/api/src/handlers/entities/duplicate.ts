import { Result } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db";
import type { EntitySnapshot } from "@/api/handlers/entities/copy-utils";
import {
  collectFileMappings,
  copyEntities,
  getFolderSubtree,
  remapFileIds,
  rollbackS3Copies,
} from "@/api/handlers/entities/copy-utils";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
} from "@/api/lib/file-derivative-queue";
import { LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import { processExtraction } from "@/api/lib/search/process-extraction";

const duplicateEntityBodySchema = t.Object({
  entityId: tSafeId("entity"),
});

type DuplicateEntityHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof duplicateEntityBodySchema>;
};

const duplicateEntityHandler = async function* ({
  safeDb,
  organizationId,
  workspaceId,
  userId,
  recordAuditEvent,
  body: { entityId: sourceEntityId },
}: DuplicateEntityHandlerProps) {
  const source = yield* Result.await(
    safeDb((tx) =>
      tx.query.entities.findFirst({
        where: { id: { eq: sourceEntityId }, workspaceId: { eq: workspaceId } },
        columns: {
          id: true,
          kind: true,
          name: true,
          parentId: true,
        },
        with: {
          currentVersion: {
            columns: { id: true },
            with: {
              fields: {
                columns: {
                  propertyId: true,
                  content: true,
                },
              },
            },
          },
        },
      }),
    ),
  );

  if (!source) {
    return Result.err(
      new HandlerError({ status: 404, message: "Entity not found" }),
    );
  }

  let sourceEntities: EntitySnapshot[] = [source];
  if (source.kind === "folder") {
    const workspaceEntities = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findMany({
          where: { workspaceId: { eq: workspaceId } },
          columns: {
            id: true,
            kind: true,
            name: true,
            parentId: true,
          },
          with: {
            currentVersion: {
              columns: { id: true },
              with: {
                fields: {
                  columns: {
                    propertyId: true,
                    content: true,
                  },
                },
              },
            },
          },
          limit: LIMITS.entitiesCount,
        }),
      ),
    );

    const subtree = getFolderSubtree(workspaceEntities, sourceEntityId);
    if (!subtree) {
      return Result.err(
        new HandlerError({ status: 404, message: "Entity not found" }),
      );
    }

    sourceEntities = subtree;
  }

  // Copies must not share storage objects with their source: deleting
  // an entity deletes its objects, so a shared reference would let
  // deleting the duplicate destroy the original's file. Mint new file
  // IDs and copy the objects before the DB transaction.
  const fileMappings = collectFileMappings({
    sourceEntities,
    organizationId,
    sourceWorkspaceId: workspaceId,
    targetWorkspaceId: workspaceId,
  });

  const s3 = getS3();
  const copiedS3Keys: string[] = [];

  try {
    for (const { sourceKey, targetKey, mimeType } of fileMappings) {
      // Stream directly from source to target without buffering in memory
      await s3.write(targetKey, s3.file(sourceKey), { type: mimeType });
      copiedS3Keys.push(targetKey);
    }
  } catch (error) {
    await rollbackS3Copies(copiedS3Keys);
    captureError(error, { workspaceId, sourceEntityId });
    return Result.err(
      new HandlerError({ status: 500, message: "Failed to copy files" }),
    );
  }

  const remappedEntities = remapFileIds(sourceEntities, fileMappings);

  const txResult = yield* Result.await(
    safeDb(
      async (tx) =>
        await copyEntities({
          tx,
          targetWorkspaceId: workspaceId,
          targetParentId: source.parentId,
          userId,
          recordAuditEvent,
          sourceEntityId,
          sourceEntities: remappedEntities,
        }),
    ),
  );

  if (!txResult.ok) {
    await rollbackS3Copies(copiedS3Keys);
    return Result.err(
      new HandlerError({ status: txResult.status, message: txResult.message }),
    );
  }

  for (const entityId of txResult.entityIds) {
    processExtraction(entityId).catch(captureError);
  }

  // The copies reference fresh file IDs, so each needs its own
  // PDF/thumbnail derivatives.
  for (const fileField of txResult.fileFields) {
    enqueuePdfDerivativeOrMarkFailed({
      entityId: fileField.entityId,
      fieldId: fileField.fieldId,
      mimeType: fileField.mimeType,
      encrypted: fileField.encrypted,
      organizationId,
      userId,
      workspaceId,
    }).catch(captureError);
    enqueueImageThumbnailOrMarkFailed({
      entityId: fileField.entityId,
      fieldId: fileField.fieldId,
      mimeType: fileField.mimeType,
      encrypted: fileField.encrypted,
      organizationId,
      userId,
      workspaceId,
    }).catch(captureError);
  }

  return Result.ok({ entityId: txResult.entityId });
};

const config = {
  permissions: { entity: ["create"] },
  body: duplicateEntityBodySchema,
} satisfies HandlerConfig;

const duplicateEntity = createSafeHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    workspaceId,
    body,
    recordAuditEvent,
  }) {
    return yield* duplicateEntityHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      userId: user.id,
      recordAuditEvent,
      body,
    });
  },
);

export default duplicateEntity;
