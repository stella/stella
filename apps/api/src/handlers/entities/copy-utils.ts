import { panic, Result, TaggedError } from "better-result";
import { and, eq, isNull, like } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import type { EntityKind, FieldContent } from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { allocateEntityStamps } from "@/api/lib/document-counter";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import {
  allocateFileObject,
  fileContentWithMintedObject,
  type MintedFileId,
  type WritableFieldContent,
} from "@/api/lib/files/file-object-ids";
import { pdfDerivativeStateForFile } from "@/api/lib/files/gotenberg";
import { thumbnailDerivativeStateForFile } from "@/api/lib/files/image-derivative";
import { createFileKey } from "@/api/lib/files/utils";
import { LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import { copyObject } from "@/api/lib/s3-presign";
import {
  nativeExtractionRunRequestForFields,
  requestNativeExtractionRuns,
  SEARCH_INDEX_OWNER,
} from "@/api/lib/search/process-extraction";
import type {
  NativeExtractionRunRequest,
  SearchIndexOwner,
} from "@/api/lib/search/process-extraction";
import { enqueueEntitySearchRepairs } from "@/api/lib/search/projection-repair-queue";

export type EntityFieldSnapshot = {
  propertyId: SafeId<"property">;
  content: FieldContent;
};

export type EntitySnapshot = {
  id: SafeId<"entity">;
  kind: EntityKind;
  name: string;
  parentId: SafeId<"entity"> | null;
  readOnly?: boolean;
  currentVersion: {
    fields: EntityFieldSnapshot[];
  } | null;
};

type WritableEntityFieldSnapshot = {
  propertyId: SafeId<"property">;
  content: WritableFieldContent;
};

export type WritableEntitySnapshot = Omit<EntitySnapshot, "currentVersion"> & {
  currentVersion: {
    fields: WritableEntityFieldSnapshot[];
  } | null;
};

export type CopiedEntity = {
  sourceId: SafeId<"entity">;
  entityId: SafeId<"entity">;
  kind: EntityKind;
  name: string;
  parentId: SafeId<"entity"> | null;
};

/** File field info needed for PDF derivative enqueueing. */
export type CopiedFileField = {
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  mimeType: string;
  encrypted: boolean;
};

export type FileMapping = {
  sourceKey: string;
  targetKey: string;
  newFileId: MintedFileId;
  sourceEntityId: SafeId<"entity">;
  sourceFileId: string;
  sourcePropertyId: SafeId<"property">;
  mimeType: string;
};

export type FileCopySource = {
  sourceEntityId: SafeId<"entity">;
  sourceKey: string;
  sourceFileId: string;
  sourcePropertyId: SafeId<"property">;
  mimeType: string;
};

type FileMappingKeyInput = {
  sourceEntityId: SafeId<"entity">;
  sourcePropertyId: SafeId<"property">;
};

const fileMappingKey = ({
  sourceEntityId,
  sourcePropertyId,
}: FileMappingKeyInput) => `${sourceEntityId}:${sourcePropertyId}`;

type CollectFileCopySourcesOptions = {
  sourceEntities: EntitySnapshot[];
  organizationId: SafeId<"organization">;
  sourceWorkspaceId: SafeId<"workspace">;
};

/**
 * Collect all source file objects needed for S3 copy.
 */
export const collectFileCopySources = ({
  sourceEntities,
  organizationId,
  sourceWorkspaceId,
}: CollectFileCopySourcesOptions): FileCopySource[] => {
  const sources: FileCopySource[] = [];

  for (const entity of sourceEntities) {
    if (!entity.currentVersion) {
      continue;
    }
    for (const field of entity.currentVersion.fields) {
      if (field.content.type !== "file" || !field.content.id) {
        continue;
      }
      const { mimeType, id: fileId } = field.content;
      sources.push({
        sourceEntityId: entity.id,
        sourceFileId: fileId,
        sourcePropertyId: field.propertyId,
        mimeType,
        sourceKey: createFileKey({
          organizationId,
          workspaceId: sourceWorkspaceId,
          fileId,
          mimeType,
        }),
      });
    }
  }

  return sources;
};

type CopyFileObjectOptions = FileCopySource & {
  organizationId: SafeId<"organization">;
  targetWorkspaceId: SafeId<"workspace">;
  copiedS3Keys: string[];
};

/**
 * Copy one field-backed file object and return the minted target ID.
 * Copies must never share storage objects with their source: S3 keys
 * are derived from the file ID, and entity deletion deletes the
 * underlying objects.
 */
export const copyFileObject = async ({
  sourceEntityId,
  sourceFileId,
  sourcePropertyId,
  sourceKey,
  mimeType,
  organizationId,
  targetWorkspaceId,
  copiedS3Keys,
}: CopyFileObjectOptions): Promise<FileMapping> => {
  const newFileId = allocateFileObject();
  const targetKey = createFileKey({
    organizationId,
    workspaceId: targetWorkspaceId,
    fileId: newFileId,
    mimeType,
  });
  // Reserve the deterministic destination before starting the copy. A timed-out
  // request may still have completed in S3, so rollback must delete this key even
  // when the client never observes a successful response.
  copiedS3Keys.push(targetKey);
  const copied = await copyObject(sourceKey, targetKey);
  if (Result.isError(copied)) {
    throw copied.error;
  }

  return {
    sourceEntityId,
    sourceFileId,
    sourcePropertyId,
    sourceKey,
    targetKey,
    newFileId,
    mimeType,
  };
};

type CopyFileObjectsOptions = {
  sources: FileCopySource[];
  organizationId: SafeId<"organization">;
  targetWorkspaceId: SafeId<"workspace">;
  copiedS3Keys: string[];
};

class FileObjectCopyError extends TaggedError("FileObjectCopyError")<{
  message: string;
  cause?: unknown;
}> {}

export const copyFileObjects = async ({
  sources,
  organizationId,
  targetWorkspaceId,
  copiedS3Keys,
}: CopyFileObjectsOptions): Promise<FileMapping[]> => {
  const results = await Promise.allSettled(
    sources.map(
      async (source) =>
        await copyFileObject({
          ...source,
          organizationId,
          targetWorkspaceId,
          copiedS3Keys,
        }),
    ),
  );

  const mappings: FileMapping[] = [];
  let firstError: unknown;
  let hasError = false;

  for (const result of results) {
    if (result.status === "fulfilled") {
      mappings.push(result.value);
      continue;
    }

    if (!hasError) {
      firstError = result.reason;
      hasError = true;
    }
  }

  if (hasError) {
    throw new FileObjectCopyError({
      message: "Failed to copy file object",
      cause: firstError,
    });
  }

  return mappings;
};

/**
 * Remap file IDs in entity snapshots so copied fields reference the
 * new S3 objects, and reset PDF/thumbnail derivative state (each copy
 * generates its own derivatives).
 */
export const remapFileIds = (
  sourceEntities: EntitySnapshot[],
  fileMappings: FileMapping[],
): WritableEntitySnapshot[] => {
  const idMap = new Map(
    fileMappings.map((m) => [fileMappingKey(m), m.newFileId]),
  );

  return sourceEntities.map((entity) => {
    if (!entity.currentVersion) {
      return { ...entity, currentVersion: null };
    }

    const remappedFields: WritableEntityFieldSnapshot[] =
      entity.currentVersion.fields.map((field) => {
        if (field.content.type !== "file") {
          return {
            content: field.content,
            propertyId: field.propertyId,
          };
        }

        const newFileId = idMap.get(
          fileMappingKey({
            sourceEntityId: entity.id,
            sourcePropertyId: field.propertyId,
          }),
        );
        if (!newFileId) {
          panic("Missing file mapping for copied file field");
        }

        const {
          pdfDerivative: _pdfDerivative,
          placeholder: _placeholder,
          thumbnailDerivative: _thumbnailDerivative,
          ...restContent
        } = field.content;

        return {
          ...field,
          content: fileContentWithMintedObject({
            ...restContent,
            id: newFileId,
            pdfFileId: null,
            pdfDerivative: pdfDerivativeStateForFile({
              encrypted: field.content.encrypted,
              mimeType: field.content.mimeType,
            }),
            thumbnailFileId: null,
            thumbnailDerivative: thumbnailDerivativeStateForFile({
              encrypted: field.content.encrypted,
              mimeType: field.content.mimeType,
            }),
          }),
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
 * Best-effort cleanup of S3 keys. A failure never fails the rollback, but
 * it is reported: the object stays in the bucket, billed and unreferenced.
 */
export const rollbackS3Copies = async (keys: string[]): Promise<void> => {
  const s3 = getS3();
  await Promise.all(
    keys.map(async (key) => {
      await s3.delete(key).catch((error: unknown) => {
        captureError(error, { source: "entity-copy-rollback" });
      });
    }),
  );
};

/** Escape regex metacharacters. */
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const trailingSuffixRe = /_\d+$/u;

type ResolveEntityNameProps = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  parentId: SafeId<"entity"> | null;
  name: string;
};

/**
 * Generate a unique entity name by appending `_N` suffix.
 * Splits on the last dot to preserve file extensions:
 *   "Report.pdf" → "Report_1.pdf", "Report_2.pdf", …
 *   "My Folder"  → "My Folder_1", "My Folder_2", …
 * Strips any existing `_N` suffix before computing the
 * next number so re-duplicating "Report_1" still increments
 * from the highest sibling, not from the stripped base.
 */
export const resolveEntityName = async ({
  tx,
  workspaceId,
  parentId,
  name,
}: ResolveEntityNameProps): Promise<string> => {
  const lastDot = name.lastIndexOf(".");
  const hasExt = lastDot > 0;
  const rawBase = hasExt ? name.slice(0, lastDot) : name;
  const ext = hasExt ? name.slice(lastDot) : "";

  // Strip trailing _N to get the root name
  const base = rawBase.replace(trailingSuffixRe, "");

  const pattern = `${escapeLike(base)}%${escapeLike(ext)}`;
  const parentCondition = parentId
    ? eq(entities.parentId, parentId)
    : isNull(entities.parentId);

  const siblings = await tx
    .select({ name: entities.name })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        parentCondition,
        like(entities.name, pattern),
      ),
    );

  // If no conflict with the original name, keep it unchanged
  const siblingNames = new Set(siblings.map((s) => s.name));
  if (!siblingNames.has(name)) {
    return name;
  }

  const suffixRe = new RegExp(
    `^${escapeRegex(base)}(?:_(\\d+))?${escapeRegex(ext)}$`,
    "u",
  );

  let maxN = 0;
  for (const sibling of siblings) {
    if (!sibling.name) {
      continue;
    }
    const match = suffixRe.exec(sibling.name);
    if (!match) {
      continue;
    }
    const n = match[1] ? Number.parseInt(match[1], 10) : 0;
    if (n > maxN) {
      maxN = n;
    }
  }

  return `${base}_${maxN + 1}${ext}`;
};

export const getFolderSubtree = (
  allEntities: EntitySnapshot[],
  rootId: SafeId<"entity">,
): EntitySnapshot[] | null => {
  const childrenByParentId = new Map<SafeId<"entity">, EntitySnapshot[]>();

  for (const entity of allEntities) {
    if (!entity.parentId) {
      continue;
    }

    const children = childrenByParentId.get(entity.parentId);
    if (children) {
      children.push(entity);
      continue;
    }

    childrenByParentId.set(entity.parentId, [entity]);
  }

  const root = allEntities.find((entity) => entity.id === rootId);
  if (!root) {
    return null;
  }

  const subtree: EntitySnapshot[] = [];
  const queue = [root];
  // The queue grows while it is walked, so a parent cycle in the snapshot
  // would enqueue forever. A cycle cannot exist in a well-formed tree; seeing
  // one means the rows contradict the model, and copying half a cycle would
  // persist the contradiction.
  const visited = new Set<SafeId<"entity">>();

  for (const entity of queue) {
    if (visited.has(entity.id)) {
      panic("Entity parent chain contains a cycle");
    }
    visited.add(entity.id);
    subtree.push(entity);
    const children = childrenByParentId.get(entity.id);
    if (!children) {
      continue;
    }
    for (const child of children) {
      queue.push(child);
    }
  }

  return subtree;
};

export type CopyEntitiesResult = {
  entityId: SafeId<"entity">;
  /**
   * The copies grouped by which mechanism writes their search projection.
   * `search-mark` copies already carry a dirty mark committed with this
   * transaction; the caller only flushes it. `durable-extraction` copies are
   * indexed by the run committed with the copy.
   */
  entityIdsBySearchIndexOwner: Record<SearchIndexOwner, SafeId<"entity">[]>;
  /** Newly created runs to hand to the queue after this transaction commits. */
  nativeExtractionRunIds: SafeId<"documentProcessingRun">[];
  copiedEntities: CopiedEntity[];
  /** File fields that may need PDF derivative generation. */
  fileFields: CopiedFileField[];
};

type CopyEntitiesProps = {
  organizationId: SafeId<"organization">;
  tx: Transaction;
  targetWorkspaceId: SafeId<"workspace">;
  targetParentId: SafeId<"entity"> | null;
  userId: SafeId<"user">;
  /**
   * Recorder for the target workspace audit rows. Caller is
   * responsible for binding it to `targetWorkspaceId` (via
   * `ctx.createAuditRecorder({ workspaceId: targetWorkspaceId })`
   * for cross-workspace copies, or just `ctx.recordAuditEvent`
   * when target equals the handler's workspace).
   */
  recordAuditEvent: AuditRecorder;
  sourceEntityId: SafeId<"entity">;
  sourceEntities: WritableEntitySnapshot[];
  /** Source workspace ID for audit log (cross-workspace only). */
  sourceWorkspaceId?: SafeId<"workspace">;
  /**
   * Whether the caller will delete the source rows in the same
   * transaction (a move) as opposed to leaving them untouched (a
   * copy). Only a move mutates the source workspace, so only a move
   * needs the source row locked — see the lock-set comment below.
   */
  deleteSource: boolean;
  dependencies?: CopyEntitiesDependencies | undefined;
};

export type CopyEntitiesDependencies = {
  enqueueEntitySearchRepairs: typeof enqueueEntitySearchRepairs;
  requestNativeExtractionRuns: typeof requestNativeExtractionRuns;
};

const defaultCopyEntitiesDependencies = {
  enqueueEntitySearchRepairs,
  requestNativeExtractionRuns: async (options) =>
    await requestNativeExtractionRuns(options),
} satisfies CopyEntitiesDependencies;

/**
 * Copy entities to a target workspace. Used by both duplicate
 * (same workspace) and copy-to-workspace (cross-workspace).
 *
 * Every rejection throws a `HandlerError` rather than returning one. This runs
 * inside the caller's transaction, and returning from a transaction callback
 * commits whatever it has already written: a rejection raised part-way through
 * the loop would persist a partially copied subtree, and the caller would then
 * delete the copied objects those committed rows point at. Throwing aborts the
 * transaction, so no copy survives and every copied object is an orphan the
 * caller cleans up. Callers recover the thrown error with
 * `transactionAbortError` and answer with it unchanged.
 */
export const copyEntities = async ({
  organizationId,
  tx,
  targetWorkspaceId,
  targetParentId,
  userId,
  recordAuditEvent,
  sourceEntityId,
  sourceEntities,
  sourceWorkspaceId,
  deleteSource,
  dependencies = defaultCopyEntitiesDependencies,
}: CopyEntitiesProps): Promise<CopyEntitiesResult> => {
  // Same-workspace duplicate and cross-workspace copy both lock the
  // target only: a pure copy never mutates the source workspace's
  // rows or its cap, so locking the source would only add unrelated
  // contention (blocking uploads/tasks/clips there) for no
  // correctness benefit. Only a cross-workspace MOVE
  // (`deleteSource`) also locks the source, since the caller deletes
  // source rows in the same transaction and that must serialize with
  // concurrent source-side inserts. Both ids go through
  // `lockWorkspacesForEntityCap`, which sorts them ascending before
  // locking — see that function for why this closes the
  // cross-workspace ABBA between an A->B and a concurrent B->A move.
  await lockWorkspacesForEntityCap(
    tx,
    sourceWorkspaceId && deleteSource
      ? [sourceWorkspaceId, targetWorkspaceId]
      : [targetWorkspaceId],
  );

  const entityCount = await tx.$count(
    entities,
    eq(entities.workspaceId, targetWorkspaceId),
  );

  if (entityCount + sourceEntities.length > LIMITS.entitiesCount) {
    throw new HandlerError({
      status: 400,
      message: "Entities limit reached",
    });
  }

  // Validate target parent for cross-workspace copy only.
  // Same-workspace (duplicate) already validated the parent via the source entity fetch.
  if (sourceWorkspaceId && targetParentId) {
    const parent = await tx.query.entities.findFirst({
      where: {
        id: { eq: targetParentId },
        workspaceId: { eq: targetWorkspaceId },
      },
      columns: { kind: true },
    });

    if (!parent) {
      throw new HandlerError({
        status: 400,
        message: "Target parent folder not found",
      });
    }

    if (parent.kind !== "folder") {
      throw new HandlerError({
        status: 400,
        message: "Target parent must be a folder",
      });
    }
  }

  const idMap = new Map<SafeId<"entity">, SafeId<"entity">>();
  const copiedEntities: CopiedEntity[] = [];
  // Split by which mechanism owns each copy's search projection, so every
  // copy is covered exactly once: a durable extraction run indexes the
  // documents it extracts, and a dirty mark committed with this transaction
  // covers everything else.
  const copiedEntityIds: Record<SearchIndexOwner, SafeId<"entity">[]> = {
    [SEARCH_INDEX_OWNER.durableExtraction]: [],
    [SEARCH_INDEX_OWNER.searchMark]: [],
  };
  const nativeExtractionRequests: NativeExtractionRunRequest[] = [];
  const fileFields: CopiedFileField[] = [];
  // The document rows are known before the copy starts, so the whole run of
  // sequence numbers is allocated in one counter upsert plus one reference
  // read instead of two statements per copied document. The filter keeps
  // source order, so each document consumes the stamp for its own position.
  const documentStamps = await allocateEntityStamps({
    tx,
    workspaceId: targetWorkspaceId,
    count: sourceEntities.filter((source) => source.kind === "document").length,
  });
  let nextStampIndex = 0;

  for (const source of sourceEntities) {
    if (!source.currentVersion) {
      throw new HandlerError({
        status: 400,
        message: "Entity has no current version",
      });
    }

    const newEntityId = createSafeId<"entity">();
    const newVersionId = createSafeId<"entityVersion">();
    const mappedParentId = source.parentId
      ? idMap.get(source.parentId)
      : undefined;

    // For root entity: use targetParentId (caller provides the correct value)
    // For children: use mapped parent from idMap
    const newParentId =
      source.id === sourceEntityId ? targetParentId : mappedParentId;

    if (source.id !== sourceEntityId && newParentId === undefined) {
      throw new HandlerError({
        status: 500,
        message: "Copy parent was not created",
      });
    }

    const copyName =
      source.id === sourceEntityId
        ? // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- runs for the copy root only, once per call, not per row
          await resolveEntityName({
            tx,
            workspaceId: targetWorkspaceId,
            parentId: newParentId ?? null,
            name: source.name,
          })
        : source.name;

    const entityStamp =
      source.kind === "document"
        ? (documentStamps.at(nextStampIndex++) ??
          panic("Fewer document stamps allocated than documents copied"))
        : null;

    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential by design: same DB transaction client; children reference parent IDs created in earlier iterations, and the version insert/currentVersionId update just below depend on this row
    await tx.insert(entities).values({
      id: newEntityId,
      workspaceId: targetWorkspaceId,
      kind: source.kind,
      parentId: newParentId ?? null,
      name: copyName,
      createdBy: userId,
      docSequence: entityStamp?.docSequence ?? null,
    });

    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential version insert depends on the entity row created just above in this iteration
    await tx.insert(entityVersions).values({
      id: newVersionId,
      workspaceId: targetWorkspaceId,
      entityId: newEntityId,
      versionNumber: 1,
      stamp: entityStamp?.stamp ?? null,
      verificationCode: entityStamp?.verificationCode ?? null,
    });

    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential update sets currentVersionId on the just-created entity/version pair
    await tx
      .update(entities)
      .set({ currentVersionId: newVersionId })
      .where(eq(entities.id, newEntityId));

    const fieldInserts = source.currentVersion.fields.map((field) => {
      const fieldId = createSafeId<"field">();

      // Track file fields for PDF derivative enqueueing
      if (field.content.type === "file") {
        fileFields.push({
          entityId: newEntityId,
          fieldId,
          mimeType: field.content.mimeType,
          encrypted: field.content.encrypted,
        });
      }

      return {
        id: fieldId,
        workspaceId: targetWorkspaceId,
        propertyId: field.propertyId,
        entityVersionId: newVersionId,
        content: field.content,
      };
    });
    if (fieldInserts.length > 0) {
      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential field insert depends on the version created in this iteration
      await tx.insert(fields).values(fieldInserts);
    }

    idMap.set(source.id, newEntityId);
    // The field ids above are minted in insertion order, so this derives the
    // same source the post-commit processor would select without re-reading
    // each copied entity.
    const extractionRequest = nativeExtractionRunRequestForFields({
      entityId: newEntityId,
      entityVersionId: newVersionId,
      fields: fieldInserts,
      organizationId,
      workspaceId: targetWorkspaceId,
    });
    if (extractionRequest === null) {
      copiedEntityIds[SEARCH_INDEX_OWNER.searchMark].push(newEntityId);
    } else {
      copiedEntityIds[SEARCH_INDEX_OWNER.durableExtraction].push(newEntityId);
      nativeExtractionRequests.push(extractionRequest);
    }
    copiedEntities.push({
      sourceId: source.id,
      entityId: newEntityId,
      kind: source.kind,
      name: copyName,
      parentId: newParentId ?? null,
    });
  }

  await tx
    .update(workspaces)
    .set({ lastActivityAt: new Date() })
    .where(eq(workspaces.id, targetWorkspaceId));

  await recordAuditEvent(
    tx,
    copiedEntities.map((entity) => ({
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
      resourceId: entity.entityId,
      changes: {
        created: {
          old: {
            sourceEntityId: entity.sourceId,
            ...(sourceWorkspaceId ? { sourceWorkspaceId } : {}),
          },
          new: {
            kind: entity.kind,
            name: entity.name,
            parentId: entity.parentId,
          },
        },
      },
    })),
  );

  const rootEntityId = idMap.get(sourceEntityId);
  if (!rootEntityId) {
    throw new HandlerError({
      status: 500,
      message: "Copy root was not created",
    });
  }

  // Written here, inside the copy transaction: the mark commits or rolls back
  // with the copies themselves, so a lost post-commit flush costs nothing.
  await dependencies.enqueueEntitySearchRepairs(
    tx,
    copiedEntityIds[SEARCH_INDEX_OWNER.searchMark],
  );
  const nativeExtractionRunIds = await dependencies.requestNativeExtractionRuns(
    {
      requests: nativeExtractionRequests,
      tx,
    },
  );

  return {
    entityId: rootEntityId,
    entityIdsBySearchIndexOwner: copiedEntityIds,
    copiedEntities,
    fileFields,
    nativeExtractionRunIds,
  };
};
