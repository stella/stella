import { Result } from "better-result";
import { eq } from "drizzle-orm";
import type { Static } from "elysia";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { entities, workspaces } from "@/api/db/schema";
import type { EntitySnapshot } from "@/api/handlers/entities/copy-utils";
import {
  copyEntities,
  getFolderSubtree,
} from "@/api/handlers/entities/copy-utils";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { AuditContext } from "@/api/lib/audit-log";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditContext,
  writeAuditLog,
} from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { enqueuePdfDerivativeOrMarkFailed } from "@/api/lib/file-derivative-queue";
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

type FileMapping = {
  sourceKey: string;
  targetKey: string;
  newFileId: string;
  sourceFileId: string;
};

type CopyToWorkspaceHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  sourceWorkspaceId: SafeId<"workspace">;
  targetWorkspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  sourceAuditContext: AuditContext;
  targetAuditContext: AuditContext;
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
 * Collect all file mappings from entities for S3 copy.
 * Creates new file IDs for the target workspace.
 */
const collectFileMappings = (
  sourceEntities: EntitySnapshot[],
  organizationId: SafeId<"organization">,
  sourceWorkspaceId: SafeId<"workspace">,
  targetWorkspaceId: SafeId<"workspace">,
): FileMapping[] => {
  const mappings: FileMapping[] = [];

  for (const entity of sourceEntities) {
    if (!entity.currentVersion) {
      continue;
    }
    for (const field of entity.currentVersion.fields) {
      if (field.content.type === "file" && field.content.id) {
        const newFileId = Bun.randomUUIDv7();
        mappings.push({
          sourceFileId: field.content.id,
          newFileId,
          sourceKey: createFileKey({
            organizationId,
            workspaceId: sourceWorkspaceId,
            fileId: field.content.id,
            mimeType: field.content.mimeType,
          }),
          targetKey: createFileKey({
            organizationId,
            workspaceId: targetWorkspaceId,
            fileId: newFileId,
            mimeType: field.content.mimeType,
          }),
        });
      }
    }
  }

  return mappings;
};

/**
 * Remap file IDs in entity snapshots for cross-workspace copy.
 * S3 keys include workspaceId, so files copied to another workspace
 * get new IDs. This updates field content to reference those new IDs
 * and resets PDF derivative state (each workspace needs its own).
 */
const remapFileIds = (
  sourceEntities: EntitySnapshot[],
  fileMappings: FileMapping[],
): EntitySnapshot[] => {
  const idMap = new Map(fileMappings.map((m) => [m.sourceFileId, m.newFileId]));

  return sourceEntities.map((entity) => {
    if (!entity.currentVersion) {
      return entity;
    }

    const remappedFields = entity.currentVersion.fields.map((field) => {
      if (field.content.type !== "file" || !field.content.id) {
        return field;
      }

      const newFileId = idMap.get(field.content.id);
      if (!newFileId) {
        return field;
      }

      const { pdfDerivative: _, ...restContent } = field.content;

      return {
        ...field,
        content: {
          ...restContent,
          id: newFileId,
          pdfFileId: null,
          ...(field.content.pdfDerivative
            ? { pdfDerivative: { status: "pending" as const } }
            : {}),
        },
      };
    });

    return {
      ...entity,
      currentVersion: {
        ...entity.currentVersion,
        fields: remappedFields,
      },
    };
  });
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
  sourceAuditContext,
  targetAuditContext,
  body: { entityId: sourceEntityId, targetParentId, deleteSource },
}: CopyToWorkspaceHandlerProps) {
  // Prevent copy to same workspace
  if (sourceWorkspaceId === targetWorkspaceId) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Cannot copy to the same workspace; use duplicate instead",
      }),
    );
  }

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

  // Collect file mappings for S3 copy
  const fileMappings = collectFileMappings(
    sourceEntities,
    organizationId,
    sourceWorkspaceId,
    targetWorkspaceId,
  );

  // S3 copy phase: copy all files before DB transaction
  const s3 = getS3();
  const copiedS3Keys: string[] = [];

  try {
    for (const { sourceKey, targetKey } of fileMappings) {
      const sourceFile = s3.file(sourceKey);
      const content = await sourceFile.arrayBuffer();
      await s3.write(targetKey, new Uint8Array(content));
      copiedS3Keys.push(targetKey);
    }
  } catch (error) {
    // Rollback S3 copies on failure
    await Promise.all(
      copiedS3Keys.map(
        async (key) =>
          await s3.delete(key).catch(() => {
            // Intentional no-op: best-effort cleanup
          }),
      ),
    );
    captureError(error, {
      sourceWorkspaceId,
      targetWorkspaceId,
      sourceEntityId,
    });
    return Result.err(
      new HandlerError({ status: 500, message: "Failed to copy files" }),
    );
  }

  // Collect property IDs needed for copy
  const requiredPropertyIds = collectPropertyIds(sourceEntities);

  // Remap file IDs in source entities to reference the new S3 copies
  const remappedEntities = remapFileIds(sourceEntities, fileMappings);

  // DB transaction phase
  const txResult = yield* Result.await(
    safeDb(async (tx) => {
      // Build property map: source ID → target ID for properties present in both workspaces
      const propertyIdMap = new Map<SafeId<"property">, SafeId<"property">>();

      if (requiredPropertyIds.size > 0) {
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

        // Index target properties by name+type for matching
        const targetByKey = new Map<string, SafeId<"property">>();
        for (const prop of targetProperties) {
          const key = `${prop.name}:${prop.content.type}`;
          targetByKey.set(key, prop.id);
        }

        // Map source properties to matching target properties
        for (const sourceProp of sourceProperties) {
          const key = `${sourceProp.name}:${sourceProp.content.type}`;
          const targetId = targetByKey.get(key);
          if (targetId) {
            propertyIdMap.set(sourceProp.id, targetId);
          }
        }
      }

      // Remap property IDs to target workspace equivalents
      const propertyRemappedEntities = remapPropertyIds(
        remappedEntities,
        propertyIdMap,
      );

      return await copyEntities({
        tx,
        targetWorkspaceId,
        targetParentId,
        userId,
        auditContext: targetAuditContext,
        sourceEntityId,
        sourceEntities: propertyRemappedEntities,
        sourceWorkspaceId,
      });
    }),
  );

  if (!txResult.ok) {
    // Rollback S3 copies on DB failure
    await Promise.all(
      copiedS3Keys.map(
        async (key) =>
          await s3.delete(key).catch(() => {
            // Intentional no-op: best-effort cleanup
          }),
      ),
    );
    return Result.err(
      new HandlerError({ status: txResult.status, message: txResult.message }),
    );
  }

  // Handle delete source (move operation)
  if (deleteSource) {
    // Delete source entities from DB
    const sourceEntityIds = sourceEntities.map((e) => e.id);
    yield* Result.await(
      safeDb(async (tx) => {
        // Delete in reverse order (children first) by deleting all at once
        // The cascade will handle versions and fields
        for (const id of sourceEntityIds.toReversed()) {
          await tx.delete(entities).where(eq(entities.id, id));
        }

        await tx
          .update(workspaces)
          .set({ lastActivityAt: new Date() })
          .where(eq(workspaces.id, sourceWorkspaceId));

        await writeAuditLog(
          txResult.copiedEntities.map((entity) => ({
            organizationId: sourceAuditContext.organizationId,
            workspaceId: sourceWorkspaceId,
            userId: sourceAuditContext.userId,
            metadata: sourceAuditContext.metadata,
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
          tx,
        );
      }),
    );

    // Delete source S3 objects after DB transaction succeeds
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
  }

  // Sync search indexes
  syncWorkspaceSearchActivity(targetWorkspaceId).catch(captureError);
  if (deleteSource) {
    syncWorkspaceSearchActivity(sourceWorkspaceId).catch(captureError);
  }

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
    request,
    server,
    body,
    workspaceId: sourceWorkspaceId,
    accessibleWorkspaces,
  }) {
    const { targetWorkspaceId } = body;

    // Validate access to target workspace
    const targetWorkspace = accessibleWorkspaces.find(
      (w: AccessibleWorkspace) =>
        w.id === targetWorkspaceId && w.status === "active",
    );
    if (!targetWorkspace) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Target workspace not found",
        }),
      );
    }

    const organizationId = session.activeOrganizationId;

    return yield* copyToWorkspaceHandler({
      safeDb,
      organizationId,
      sourceWorkspaceId,
      targetWorkspaceId,
      userId: user.id,
      sourceAuditContext: createAuditContext({
        organizationId,
        workspaceId: sourceWorkspaceId,
        userId: user.id,
        request,
        server,
      }),
      targetAuditContext: createAuditContext({
        organizationId,
        workspaceId: targetWorkspaceId,
        userId: user.id,
        request,
        server,
      }),
      body,
    });
  },
);

export default copyToWorkspace;
