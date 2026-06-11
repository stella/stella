import { panic, TaggedError } from "better-result";
import { and, eq, isNull, like } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import type { EntityKind, FieldContent } from "@/api/db/schema-validators";
import {
  allocateFileObject,
  fileContentWithMintedObject,
  type MintedFileId,
  type WritableFieldContent,
} from "@/api/handlers/files/file-object-ids";
import { pdfDerivativeStateForFile } from "@/api/handlers/files/gotenberg";
import { thumbnailDerivativeStateForFile } from "@/api/handlers/files/image-derivative";
import { createFileKey } from "@/api/handlers/files/utils";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { allocateEntityStamp } from "@/api/lib/document-counter";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";

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
      if (field.content.type === "file" && field.content.id) {
        const { mimeType } = field.content;
        sources.push({
          sourceEntityId: entity.id,
          sourceFileId: field.content.id,
          sourcePropertyId: field.propertyId,
          mimeType,
          sourceKey: createFileKey({
            organizationId,
            workspaceId: sourceWorkspaceId,
            fileId: field.content.id,
            mimeType,
          }),
        });
      }
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
  const s3 = getS3();

  await s3.write(targetKey, s3.file(sourceKey), { type: mimeType });
  copiedS3Keys.push(targetKey);

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
}>() {}

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
 * Best-effort cleanup of S3 keys. Failures are silently ignored
 * since this is rollback/cleanup code.
 */
export const rollbackS3Copies = async (keys: string[]): Promise<void> => {
  const s3 = getS3();
  await Promise.all(
    keys.map(async (key) => {
      await s3.delete(key).catch(() => {
        // Intentional no-op: best-effort cleanup
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

  for (const entity of queue) {
    subtree.push(entity);
    for (const child of childrenByParentId.get(entity.id) ?? []) {
      queue.push(child);
    }
  }

  return subtree;
};

type CopyEntitiesErrorResult = {
  ok: false;
  status: 400 | 404 | 500;
  message: string;
};

type CopyEntitiesSuccessResult = {
  ok: true;
  entityId: SafeId<"entity">;
  entityIds: SafeId<"entity">[];
  copiedEntities: CopiedEntity[];
  /** File fields that may need PDF derivative generation. */
  fileFields: CopiedFileField[];
};

export type CopyEntitiesResult =
  | CopyEntitiesErrorResult
  | CopyEntitiesSuccessResult;

type CopyEntitiesProps = {
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
};

/**
 * Copy entities to a target workspace. Used by both duplicate
 * (same workspace) and copy-to-workspace (cross-workspace).
 */
export const copyEntities = async ({
  tx,
  targetWorkspaceId,
  targetParentId,
  userId,
  recordAuditEvent,
  sourceEntityId,
  sourceEntities,
  sourceWorkspaceId,
}: CopyEntitiesProps): Promise<CopyEntitiesResult> => {
  const entityCount = await tx.$count(
    entities,
    eq(entities.workspaceId, targetWorkspaceId),
  );

  if (entityCount + sourceEntities.length > LIMITS.entitiesCount) {
    return {
      ok: false,
      status: 400,
      message: "Entities limit reached",
    };
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
      return {
        ok: false,
        status: 400,
        message: "Target parent folder not found",
      };
    }

    if (parent.kind !== "folder") {
      return {
        ok: false,
        status: 400,
        message: "Target parent must be a folder",
      };
    }
  }

  const idMap = new Map<SafeId<"entity">, SafeId<"entity">>();
  const copiedEntities: CopiedEntity[] = [];
  const copiedEntityIds: SafeId<"entity">[] = [];
  const fileFields: CopiedFileField[] = [];

  for (const source of sourceEntities) {
    if (!source.currentVersion) {
      return {
        ok: false,
        status: 400,
        message: "Entity has no current version",
      };
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

    const copyName =
      source.id === sourceEntityId
        ? await resolveEntityName({
            tx,
            workspaceId: targetWorkspaceId,
            parentId: newParentId ?? null,
            name: source.name,
          })
        : source.name;

    if (source.id !== sourceEntityId && newParentId === undefined) {
      return {
        ok: false,
        status: 500,
        message: "Copy parent was not created",
      };
    }

    const entityStamp =
      source.kind === "document"
        ? await allocateEntityStamp(tx, targetWorkspaceId)
        : null;

    await tx.insert(entities).values({
      id: newEntityId,
      workspaceId: targetWorkspaceId,
      kind: source.kind,
      parentId: newParentId ?? null,
      name: copyName,
      createdBy: userId,
      docSequence: entityStamp?.docSequence ?? null,
    });

    await tx.insert(entityVersions).values({
      id: newVersionId,
      workspaceId: targetWorkspaceId,
      entityId: newEntityId,
      versionNumber: 1,
      stamp: entityStamp?.stamp ?? null,
      verificationCode: entityStamp?.verificationCode ?? null,
    });

    await tx
      .update(entities)
      .set({ currentVersionId: newVersionId })
      .where(eq(entities.id, newEntityId));

    const sourceFields = source.currentVersion.fields;
    if (sourceFields.length > 0) {
      const fieldInserts = sourceFields.map((field) => {
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

      await tx.insert(fields).values(fieldInserts);
    }

    idMap.set(source.id, newEntityId);
    copiedEntityIds.push(newEntityId);
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
    return {
      ok: false,
      status: 500,
      message: "Copy root was not created",
    };
  }

  return {
    ok: true,
    entityId: rootEntityId,
    entityIds: copiedEntityIds,
    copiedEntities,
    fileFields,
  };
};
