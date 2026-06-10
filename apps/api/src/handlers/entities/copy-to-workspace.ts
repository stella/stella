import { Result } from "better-result";
import { eq } from "drizzle-orm";
import type { Static } from "elysia";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { entities, workspaces } from "@/api/db/schema";
import type { EntitySnapshot } from "@/api/handlers/entities/copy-utils";
import {
  collectFileMappings,
  copyEntities,
  getFolderSubtree,
  remapFileIds,
  rollbackS3Copies,
} from "@/api/handlers/entities/copy-utils";
import { captureError } from "@/api/lib/analytics";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
} from "@/api/lib/file-derivative-queue";
import { broadcastQueryInvalidationToTargetWorkspace } from "@/api/lib/invalidate-query-macro";
import { LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import { syncWorkspaceSearchActivity } from "@/api/lib/search/index-global";
import { processExtraction } from "@/api/lib/search/process-extraction";

const copyToWorkspaceBodySchema = t.Object({
  entityId: tSafeId("entity"),
  targetWorkspaceId: tSafeId("workspace"),
  targetParentId: t.Nullable(tSafeId("entity")),
  deleteSource: t.Boolean(),
});

type CopyToWorkspaceBody = Static<typeof copyToWorkspaceBodySchema>;

type CopyToWorkspaceHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  sourceWorkspaceId: SafeId<"workspace">;
  targetWorkspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  /** Recorder bound to sourceWorkspaceId — for delete events on move. */
  recordSourceAuditEvent: AuditRecorder;
  /** Recorder bound to targetWorkspaceId — for create events on copy. */
  recordTargetAuditEvent: AuditRecorder;
  body: CopyToWorkspaceBody;
};

/**
 * Collect all unique property IDs used by source entities.
 */
const collectPropertyIds = (
  sourceEntities: EntitySnapshot[],
): Set<SafeId<"property">> => {
  const propertyIds = new Set<SafeId<"property">>();

  for (const entity of sourceEntities) {
    if (!entity.currentVersion) {
      continue;
    }
    for (const field of entity.currentVersion.fields) {
      propertyIds.add(field.propertyId);
    }
  }

  return propertyIds;
};

/**
 * Remap property IDs in entity snapshots for cross-workspace copy.
 * Properties are workspace-scoped, so we match by name+type and remap
 * to the target workspace's property IDs. Fields with no matching
 * property in the target workspace are dropped.
 */
const remapPropertyIds = (
  sourceEntities: EntitySnapshot[],
  propertyIdMap: Map<SafeId<"property">, SafeId<"property">>,
): EntitySnapshot[] =>
  sourceEntities.map((entity) => {
    if (!entity.currentVersion) {
      return entity;
    }

    const remappedFields = entity.currentVersion.fields.flatMap((field) => {
      const targetPropertyId = propertyIdMap.get(field.propertyId);
      if (!targetPropertyId) {
        // Property not available in target workspace; drop this field
        return [];
      }
      return [{ ...field, propertyId: targetPropertyId }];
    });

    return {
      ...entity,
      currentVersion: {
        ...entity.currentVersion,
        fields: remappedFields,
      },
    };
  });

const copyToWorkspaceHandler = async function* ({
  safeDb,
  organizationId,
  sourceWorkspaceId,
  targetWorkspaceId,
  userId,
  recordSourceAuditEvent,
  recordTargetAuditEvent,
  body: { entityId: sourceEntityId, targetParentId, deleteSource },
}: CopyToWorkspaceHandlerProps) {
  // Fetch source entity
  const source = yield* Result.await(
    safeDb((tx) =>
      tx.query.entities.findFirst({
        where: {
          id: { eq: sourceEntityId },
          workspaceId: { eq: sourceWorkspaceId },
        },
        columns: {
          id: true,
          kind: true,
          name: true,
          parentId: true,
          readOnly: true,
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

  if (deleteSource && source.readOnly) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Cannot move read-only entity",
      }),
    );
  }

  // Get subtree for folders
  let sourceEntities: EntitySnapshot[] = [source];
  if (source.kind === "folder") {
    const workspaceEntities = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findMany({
          where: { workspaceId: { eq: sourceWorkspaceId } },
          columns: {
            id: true,
            kind: true,
            name: true,
            parentId: true,
            readOnly: true,
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

    // For move operations, check if any entity in the subtree is read-only
    if (deleteSource) {
      const readOnlyEntity = subtree.find((e) => e.readOnly);
      if (readOnlyEntity) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: "Cannot move folder containing read-only entities",
          }),
        );
      }
    }

    sourceEntities = subtree;
  }

  // Build property map before copying S3 objects. Fields whose
  // properties do not exist in the target workspace are dropped, so
  // their files must not be copied either.
  const requiredPropertyIds = collectPropertyIds(sourceEntities);
  const propertyIdMap = new Map<SafeId<"property">, SafeId<"property">>();

  if (requiredPropertyIds.size > 0) {
    const properties = yield* Result.await(
      safeDb(async (tx) => {
        const [sourceProperties, targetProperties] = await Promise.all([
          tx.query.properties.findMany({
            where: {
              workspaceId: { eq: sourceWorkspaceId },
              id: { in: [...requiredPropertyIds] },
            },
            columns: { id: true, name: true, content: true },
          }),
          tx.query.properties.findMany({
            where: { workspaceId: { eq: targetWorkspaceId } },
            columns: { id: true, name: true, content: true },
          }),
        ]);

        return { sourceProperties, targetProperties };
      }),
    );

    const targetByKey = new Map<string, SafeId<"property">>();
    for (const prop of properties.targetProperties) {
      const key = `${prop.name}:${prop.content.type}`;
      targetByKey.set(key, prop.id);
    }

    for (const sourceProp of properties.sourceProperties) {
      const key = `${sourceProp.name}:${sourceProp.content.type}`;
      const targetId = targetByKey.get(key);
      if (targetId) {
        propertyIdMap.set(sourceProp.id, targetId);
      }
    }
  }

  const propertyRemappedEntities = remapPropertyIds(
    sourceEntities,
    propertyIdMap,
  );

  // Collect file mappings for S3 copy after property remapping, so
  // files from dropped fields do not leave orphaned target objects.
  const fileMappings = collectFileMappings({
    sourceEntities: propertyRemappedEntities,
    organizationId,
    sourceWorkspaceId,
    targetWorkspaceId,
  });

  // S3 copy phase: copy all files before DB transaction
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
    captureError(error, {
      sourceWorkspaceId,
      targetWorkspaceId,
      sourceEntityId,
    });
    return Result.err(
      new HandlerError({ status: 500, message: "Failed to copy files" }),
    );
  }

  // Remap file IDs in source entities to reference the new S3 copies
  const remappedEntities = remapFileIds(propertyRemappedEntities, fileMappings);

  // DB transaction phase: copy (and delete for moves) in a single transaction
  // to ensure atomicity — either both succeed or neither does.
  const sourceEntityIds = sourceEntities.map((e) => e.id);
  const txResult = yield* Result.await(
    safeDb(async (tx) => {
      const copyResult = await copyEntities({
        tx,
        targetWorkspaceId,
        targetParentId,
        userId,
        recordAuditEvent: recordTargetAuditEvent,
        sourceEntityId,
        sourceEntities: remappedEntities,
        sourceWorkspaceId,
      });

      if (!copyResult.ok) {
        return copyResult;
      }

      // For move operations, delete source entities in the same transaction
      if (deleteSource) {
        // Delete in reverse order (children first) to respect FK constraints.
        // The cascade will handle versions and fields.
        for (const id of sourceEntityIds.toReversed()) {
          await tx.delete(entities).where(eq(entities.id, id));
        }

        await tx
          .update(workspaces)
          .set({ lastActivityAt: new Date() })
          .where(eq(workspaces.id, sourceWorkspaceId));

        await recordSourceAuditEvent(
          tx,
          copyResult.copiedEntities.map((entity) => ({
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
            resourceId: entity.sourceId,
            changes: {
              deleted: {
                old: { kind: entity.kind, name: entity.name },
                new: { movedToWorkspaceId: targetWorkspaceId },
              },
            },
          })),
        );
      }

      return copyResult;
    }),
  );

  if (!txResult.ok) {
    await rollbackS3Copies(copiedS3Keys);
    return Result.err(
      new HandlerError({ status: txResult.status, message: txResult.message }),
    );
  }

  // Delete source S3 objects after DB transaction succeeds (for moves)
  if (deleteSource) {
    const sourceKeys = fileMappings.map((m) => m.sourceKey);
    await Promise.all(
      sourceKeys.map(
        async (key) =>
          await s3.delete(key).catch((error: unknown) => {
            captureError(error, { key, operation: "move-cleanup" });
          }),
      ),
    );
  }

  // Process search extraction for new entities
  for (const entityId of txResult.entityIds) {
    processExtraction(entityId).catch(captureError);
  }

  // Enqueue PDF derivative generation for copied file fields
  for (const fileField of txResult.fileFields) {
    enqueuePdfDerivativeOrMarkFailed({
      entityId: fileField.entityId,
      fieldId: fileField.fieldId,
      mimeType: fileField.mimeType,
      encrypted: fileField.encrypted,
      organizationId,
      userId,
      workspaceId: targetWorkspaceId,
    }).catch(captureError);
    enqueueImageThumbnailOrMarkFailed({
      entityId: fileField.entityId,
      fieldId: fileField.fieldId,
      mimeType: fileField.mimeType,
      encrypted: fileField.encrypted,
      organizationId,
      userId,
      workspaceId: targetWorkspaceId,
    }).catch(captureError);
  }

  // Sync search indexes
  syncWorkspaceSearchActivity(targetWorkspaceId).catch(captureError);
  if (deleteSource) {
    syncWorkspaceSearchActivity(sourceWorkspaceId).catch(captureError);
  }

  // Broadcast invalidation to target workspace so other clients viewing it
  // receive SSE updates. The macro handles the source workspace via ctx.workspaceId.
  broadcastQueryInvalidationToTargetWorkspace(targetWorkspaceId, [
    "entities",
    targetWorkspaceId,
  ]);

  return Result.ok({
    entityId: txResult.entityId,
    entityIds: txResult.entityIds,
  });
};

const config = {
  permissions: { entity: ["create", "delete"] },
  body: copyToWorkspaceBodySchema,
} satisfies HandlerConfig;

const copyToWorkspace = createSafeHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    body,
    workspaceId: sourceWorkspaceId,
    accessibleWorkspaces,
    recordAuditEvent,
    createAuditRecorder,
  }) {
    const { targetWorkspaceId } = body;

    if (sourceWorkspaceId === targetWorkspaceId) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Cannot copy to the same workspace; use duplicate instead",
        }),
      );
    }

    // Validate access to target workspace
    const targetWorkspace = accessibleWorkspaces.find(
      (w) => w.id === targetWorkspaceId && w.status === "active",
    );
    if (!targetWorkspace) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Target workspace not found",
        }),
      );
    }

    return yield* copyToWorkspaceHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      sourceWorkspaceId,
      targetWorkspaceId,
      userId: user.id,
      // ctx.workspaceId === sourceWorkspaceId (validated path param),
      // so the default-bound recorder writes to the source workspace.
      recordSourceAuditEvent: recordAuditEvent,
      recordTargetAuditEvent: createAuditRecorder({
        workspaceId: targetWorkspaceId,
      }),
      body,
    });
  },
);

export default copyToWorkspace;
