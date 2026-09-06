import { panic, Result } from "better-result";
import { eq, inArray } from "drizzle-orm";
import type { Static } from "elysia";
import { t } from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import { transactionAbortError } from "@/api/db/safe-db";
import { entities, workspaces } from "@/api/db/schema";
import {
  collectFileCopySources,
  copyEntities,
  type CopyEntitiesDependencies,
  copyFileObjects,
  type EntitySnapshot,
  type FileMapping,
  getFolderSubtree,
  remapFileIds,
  rollbackS3Copies,
} from "@/api/handlers/entities/copy-utils";
import { captureError } from "@/api/lib/analytics/capture";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { enqueueDocumentProcessingRun } from "@/api/lib/document-processing-enqueue";
import { handoffCommittedDocumentProcessingRuns } from "@/api/lib/document-processing-handoff";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
} from "@/api/lib/file-derivative-queue";
import {
  extractFieldFileRefs,
  filterUnreferencedFieldFileRefs,
  type FieldFileRef,
} from "@/api/lib/files/field-file-refs";
import { deleteS3Objects } from "@/api/lib/files/utils";
import { LIMITS } from "@/api/lib/limits";
import { DOCUMENT_TYPE_CLASSIFIER_ROLE } from "@/api/lib/properties/create-schema";
import { broadcastWorkspaceResourceSetUpdated } from "@/api/lib/resource-realtime";
import { syncWorkspaceSearchActivity } from "@/api/lib/search/index-global";
import {
  requestNativeExtractionRuns,
  SEARCH_INDEX_OWNER,
} from "@/api/lib/search/process-extraction";
import {
  enqueueEntitySearchRepairs,
  flushEntitySearchRepairs,
} from "@/api/lib/search/projection-repair-queue";

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
  dependencies: CopyToWorkspaceDependencies;
};

export type CopyToWorkspaceDependencies = CopyEntitiesDependencies & {
  enqueueDocumentProcessingRun: typeof enqueueDocumentProcessingRun;
  enqueueImageThumbnailOrMarkFailed: typeof enqueueImageThumbnailOrMarkFailed;
  enqueuePdfDerivativeOrMarkFailed: typeof enqueuePdfDerivativeOrMarkFailed;
  flushEntitySearchRepairs: typeof flushEntitySearchRepairs;
  syncWorkspaceSearchActivity: typeof syncWorkspaceSearchActivity;
};

const defaultCopyToWorkspaceDependencies = {
  enqueueDocumentProcessingRun,
  enqueueEntitySearchRepairs,
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
  flushEntitySearchRepairs,
  requestNativeExtractionRuns,
  syncWorkspaceSearchActivity,
} satisfies CopyToWorkspaceDependencies;

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

type PropertyMappingRow = {
  id: SafeId<"property">;
  name: string;
  content: { type: string };
  system: boolean;
  role: string | null;
  tool?: { type: string } | undefined;
};

const normalizePropertyName = (name: string): string =>
  name.trim().toLowerCase();

const isClassifierShape = (property: PropertyMappingRow): boolean =>
  property.content.type === "single-select" &&
  property.tool?.type === "ai-model";

const isLegacyClassifier = (property: PropertyMappingRow): boolean =>
  property.role === null &&
  normalizePropertyName(property.name) === "document type" &&
  isClassifierShape(property);

const findClassifierId = (
  properties: readonly PropertyMappingRow[],
): SafeId<"property"> | undefined => {
  const tagged = properties.find(
    (property) => property.role === DOCUMENT_TYPE_CLASSIFIER_ROLE,
  );
  if (tagged) {
    return tagged.id;
  }

  const legacyCandidates = properties.filter(isLegacyClassifier);
  return legacyCandidates.length === 1 ? legacyCandidates[0]?.id : undefined;
};

/**
 * Map source workspace property IDs to the target workspace's. Custom columns
 * match by name+type. The system file property (Documents) holds the document
 * itself and can be named differently per workspace (locale or rename), so it
 * is matched to the target's system file property by its system+file identity;
 * matching it by name would drop the file field and leave the copy with no
 * clickable, typed file.
 */
const buildPropertyIdMap = (
  sourceProperties: readonly PropertyMappingRow[],
  targetProperties: readonly PropertyMappingRow[],
): Map<SafeId<"property">, SafeId<"property">> => {
  const propertyIdMap = new Map<SafeId<"property">, SafeId<"property">>();
  const targetByKey = new Map<string, SafeId<"property">>();
  let targetSystemFileId: SafeId<"property"> | undefined;
  const sourceClassifierId = findClassifierId(sourceProperties);
  const targetClassifierId = findClassifierId(targetProperties);
  for (const prop of targetProperties) {
    if (prop.system && prop.content.type === "file") {
      targetSystemFileId = prop.id;
    }
    targetByKey.set(`${prop.name}:${prop.content.type}`, prop.id);
  }
  if (targetSystemFileId === undefined) {
    // Every workspace is created with a system file property (see
    // workspaces/create.ts); a target missing it is a structural invariant
    // violation, not an input to silently drop the document's file field for.
    panic("Target workspace is missing its system file property");
  }
  for (const sourceProp of sourceProperties) {
    if (sourceProp.system && sourceProp.content.type === "file") {
      propertyIdMap.set(sourceProp.id, targetSystemFileId);
      continue;
    }
    if (sourceProp.id === sourceClassifierId) {
      if (targetClassifierId !== undefined) {
        propertyIdMap.set(sourceProp.id, targetClassifierId);
      }
      continue;
    }
    if (isLegacyClassifier(sourceProp)) {
      continue;
    }
    const targetId = targetByKey.get(
      `${sourceProp.name}:${sourceProp.content.type}`,
    );
    if (targetId) {
      propertyIdMap.set(sourceProp.id, targetId);
    }
  }
  return propertyIdMap;
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

type CleanupMovedSourceFilesOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  sourceWorkspaceId: SafeId<"workspace">;
  sourceEntityId: SafeId<"entity">;
  sourceFileRefs: FieldFileRef[];
};

const cleanupMovedSourceFiles = async ({
  safeDb,
  organizationId,
  sourceWorkspaceId,
  sourceEntityId,
  sourceFileRefs,
}: CleanupMovedSourceFilesOptions): Promise<void> => {
  if (sourceFileRefs.length === 0) {
    return;
  }

  const unreferencedSourceFileRefsResult = await safeDb(
    async (tx) =>
      await filterUnreferencedFieldFileRefs({
        tx,
        workspaceId: sourceWorkspaceId,
        fileRows: sourceFileRefs,
      }),
  );

  if (Result.isError(unreferencedSourceFileRefsResult)) {
    captureError(unreferencedSourceFileRefsResult.error, {
      operation: "move-cleanup",
      sourceWorkspaceId,
      sourceEntityId,
    });
    return;
  }

  const deleteResult = await deleteS3Objects({
    fileRows: unreferencedSourceFileRefsResult.value,
    organizationId,
    workspaceId: sourceWorkspaceId,
  });

  if (Result.isError(deleteResult)) {
    captureError(deleteResult.error, {
      operation: "move-cleanup",
      sourceWorkspaceId,
      sourceEntityId,
    });
  }
};

const copyToWorkspaceHandler = async function* ({
  safeDb,
  organizationId,
  sourceWorkspaceId,
  targetWorkspaceId,
  userId,
  recordSourceAuditEvent,
  recordTargetAuditEvent,
  body: { entityId: sourceEntityId, targetParentId, deleteSource },
  dependencies,
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
              // Ascending field id is ascending creation order, the order
              // `findExtractionFileField` requires, so the copy resolves the
              // same extraction source as the entity it came from. At most
              // one field per property bounds the read.
              fields: {
                columns: {
                  propertyId: true,
                  content: true,
                },
                orderBy: { id: "asc" },
                limit: LIMITS.propertiesCount,
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
                  orderBy: { id: "asc" },
                  limit: LIMITS.propertiesCount,
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
  let propertyIdMap = new Map<SafeId<"property">, SafeId<"property">>();

  if (requiredPropertyIds.size > 0) {
    const properties = yield* Result.await(
      safeDb(async (tx) => {
        const [sourceProperties, targetProperties] = await Promise.all([
          tx.query.properties.findMany({
            where: { workspaceId: { eq: sourceWorkspaceId } },
            columns: {
              id: true,
              name: true,
              content: true,
              system: true,
              role: true,
              tool: true,
            },
            limit: LIMITS.propertiesCount,
          }),
          tx.query.properties.findMany({
            where: { workspaceId: { eq: targetWorkspaceId } },
            columns: {
              id: true,
              name: true,
              content: true,
              system: true,
              role: true,
              tool: true,
            },
            limit: LIMITS.propertiesCount,
          }),
        ]);

        return { sourceProperties, targetProperties };
      }),
    );

    propertyIdMap = buildPropertyIdMap(
      properties.sourceProperties,
      properties.targetProperties,
    );
  }

  const propertyRemappedEntities = remapPropertyIds(
    sourceEntities,
    propertyIdMap,
  );
  const sourceFileRefs = sourceEntities.flatMap((entity) => {
    const currentVersion =
      entity.currentVersion ??
      panic("Source entity is missing its current version");
    return currentVersion.fields.flatMap((field) =>
      extractFieldFileRefs(field.content),
    );
  });

  // Collect file objects for S3 copy after property remapping, so
  // files from dropped fields do not leave orphaned target objects.
  const fileCopySources = collectFileCopySources({
    sourceEntities: propertyRemappedEntities,
    organizationId,
    sourceWorkspaceId,
  });

  // S3 copy phase: copy all files before DB transaction
  const copiedS3Keys: string[] = [];
  let fileMappings: FileMapping[];

  try {
    fileMappings = await copyFileObjects({
      sources: fileCopySources,
      organizationId,
      targetWorkspaceId,
      copiedS3Keys,
    });
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
  const txResultResult = await safeDb(async (tx) => {
    const copyResult = await copyEntities({
      organizationId,
      tx,
      targetWorkspaceId,
      targetParentId,
      userId,
      recordAuditEvent: recordTargetAuditEvent,
      sourceEntityId,
      sourceEntities: remappedEntities,
      sourceWorkspaceId,
      deleteSource,
      dependencies,
    });

    // For move operations, delete source entities in the same transaction.
    if (deleteSource) {
      // The whole moved subtree goes in one statement. Ordering the deletes
      // bought nothing: `entities.parent_id` is ON DELETE SET NULL, so no
      // child is ever left referencing a removed parent, and every child is
      // in this set anyway. Versions and fields still cascade.
      await tx.delete(entities).where(inArray(entities.id, sourceEntityIds));

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
  });

  // An aborted copy leaves no rows in the target and no deletions in the
  // source, so every object copied for it is an orphan and the whole set
  // goes back.
  if (Result.isError(txResultResult)) {
    await rollbackS3Copies(copiedS3Keys);
    return Result.err(transactionAbortError(txResultResult.error));
  }

  const txResult = txResultResult.value;

  if (deleteSource) {
    await cleanupMovedSourceFiles({
      safeDb,
      organizationId,
      sourceWorkspaceId,
      sourceEntityId,
      sourceFileRefs,
    });
  }

  // Acceleration only: the marks are already committed, and the standing
  // drain repairs whatever a lost flush leaves behind.
  dependencies
    .flushEntitySearchRepairs(
      txResult.entityIdsBySearchIndexOwner[SEARCH_INDEX_OWNER.searchMark],
    )
    .catch(captureError);

  // Acceleration only: each run already committed with its copied source.
  handoffCommittedDocumentProcessingRuns({
    enqueue: dependencies.enqueueDocumentProcessingRun,
    runIds: txResult.nativeExtractionRunIds,
  }).catch(captureError);

  // Enqueue PDF derivative generation for copied file fields
  for (const fileField of txResult.fileFields) {
    dependencies
      .enqueuePdfDerivativeOrMarkFailed({
        entityId: fileField.entityId,
        fieldId: fileField.fieldId,
        mimeType: fileField.mimeType,
        encrypted: fileField.encrypted,
        organizationId,
        userId,
        workspaceId: targetWorkspaceId,
      })
      .catch(captureError);
    dependencies
      .enqueueImageThumbnailOrMarkFailed({
        entityId: fileField.entityId,
        fieldId: fileField.fieldId,
        mimeType: fileField.mimeType,
        encrypted: fileField.encrypted,
        organizationId,
        userId,
        workspaceId: targetWorkspaceId,
      })
      .catch(captureError);
  }

  // Sync search indexes
  dependencies
    .syncWorkspaceSearchActivity(targetWorkspaceId)
    .catch(captureError);
  if (deleteSource) {
    dependencies
      .syncWorkspaceSearchActivity(sourceWorkspaceId)
      .catch(captureError);
  }

  // The source workspace event is emitted by the route macro. This explicit
  // event reaches clients connected to the distinct target workspace.
  broadcastWorkspaceResourceSetUpdated(targetWorkspaceId, RESOURCE_TYPE.ENTITY);

  return Result.ok({
    entityId: txResult.entityId,
    entityIds: txResult.copiedEntities.map(({ entityId }) => entityId),
  });
};

const config = {
  description:
    "Copy a document or folder subtree into another matter, or move it with " +
    "deleteSource, which permanently deletes the source documents, their " +
    "version history, and their no-longer-referenced files. Fields whose " +
    "property has no counterpart in the target matter are dropped rather than " +
    "remapped, so a move can lose column values; read-only entities are " +
    "refused.",
  permissions: { entity: ["create", "delete"] },
  mcp: { type: "capability", reason: "document_processing" },
  body: copyToWorkspaceBodySchema,
} satisfies HandlerConfig;

export const createCopyToWorkspace = (
  dependencies: CopyToWorkspaceDependencies = defaultCopyToWorkspaceDependencies,
) =>
  createSafeHandler(
    config,
    async function* ({
      safeDb,
      session,
      user,
      body,
      workspaceId: sourceWorkspaceId,
      getWorkspaceAccess,
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
      const targetWorkspace = yield* Result.await(
        Result.tryPromise(
          async () => await getWorkspaceAccess(targetWorkspaceId),
        ),
      );
      if (!targetWorkspace || targetWorkspace.status !== "active") {
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
        dependencies,
      });
    },
  );

const copyToWorkspace = createCopyToWorkspace();

export default copyToWorkspace;
