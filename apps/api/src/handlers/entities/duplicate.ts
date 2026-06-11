import { Result } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db";
import {
  collectFileCopySources,
  copyEntities,
  copyFileObjects,
  type EntitySnapshot,
  type FileMapping,
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

  const fileCopySources = collectFileCopySources({
    sourceEntities,
    organizationId,
    sourceWorkspaceId: workspaceId,
  });

  const copiedS3Keys: string[] = [];
  let fileMappings: FileMapping[];

  try {
    fileMappings = await copyFileObjects({
      sources: fileCopySources,
      organizationId,
      targetWorkspaceId: workspaceId,
      copiedS3Keys,
    });
  } catch (error) {
    await rollbackS3Copies(copiedS3Keys);
    captureError(error, { workspaceId, sourceEntityId });
    return Result.err(
      new HandlerError({ status: 500, message: "Failed to copy files" }),
    );
  }

  const remappedEntities = remapFileIds(sourceEntities, fileMappings);

  const txResultResult = await safeDb(
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
  );

  if (Result.isError(txResultResult)) {
    await rollbackS3Copies(copiedS3Keys);
    return Result.err(txResultResult.error);
  }

  const txResult = txResultResult.value;

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
