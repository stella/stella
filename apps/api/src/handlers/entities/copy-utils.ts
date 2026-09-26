import { panic, Result, TaggedError } from "better-result";
import { and, eq, isNull, like } from "drizzle-orm";

import { ENTITY_NAME_MAX_LENGTH, truncateEntityName } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import { entities, workspaces } from "@/api/db/schema";
import type { entityVersions } from "@/api/db/schema";
import type { EntityKind, FieldContent } from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { allocateEntityStamps } from "@/api/lib/document-counter";
import type { EntityStamp } from "@/api/lib/document-counter";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import {
  type CurrentVersionAssignment,
  insertEntityBatch,
} from "@/api/lib/entity-versions/insert-entity-batch";
import { carryVerificationCodes } from "@/api/lib/entity-versions/insert-entity-version";
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
import type { S3PresignError } from "@/api/lib/s3-presign";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
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
  id: SafeId<"field">;
  propertyId: SafeId<"property">;
  content: FieldContent;
};

/**
 * The version columns a move carries across unchanged. A stamp and its
 * verification code are frozen the moment they are printed, so re-homing a
 * document must reproduce the row, not mint a replacement for it. Picked from
 * the table so each column keeps the type the schema gives it.
 */
type CarriedVersionColumns = Pick<
  typeof entityVersions.$inferSelect,
  | "id"
  | "versionNumber"
  | "stamp"
  | "label"
  | "description"
  | "diffWordsAdded"
  | "diffWordsRemoved"
  | "createdBy"
  | "source"
  | "collaborationContributorUserIds"
  | "detectedLanguage"
  | "createdAt"
>;

/**
 * The relational-query column selection that produces {@link
 * CarriedVersionColumns}. Total over that shape, so a column added to the
 * carried set cannot be left unread by the loaders.
 */
const CARRIED_VERSION_COLUMNS = {
  id: true,
  versionNumber: true,
  stamp: true,
  label: true,
  description: true,
  diffWordsAdded: true,
  diffWordsRemoved: true,
  createdBy: true,
  source: true,
  collaborationContributorUserIds: true,
  detectedLanguage: true,
  createdAt: true,
} as const satisfies Record<keyof CarriedVersionColumns, true>;

export type EntityVersionSnapshot = CarriedVersionColumns & {
  fields: EntityFieldSnapshot[];
};

/**
 * One source entity and the versions to write for it. A copy loads the current
 * version alone and mints a fresh identity for it; a move loads the whole
 * non-deleted history, so both run through one insert path.
 */
export type EntitySnapshot = {
  id: SafeId<"entity">;
  kind: EntityKind;
  name: string;
  parentId: SafeId<"entity"> | null;
  readOnly?: boolean;
  currentVersionId: SafeId<"entityVersion"> | null;
  versions: EntityVersionSnapshot[];
};

type WritableEntityFieldSnapshot = {
  id: SafeId<"field">;
  propertyId: SafeId<"property">;
  content: WritableFieldContent;
};

export type WritableEntityVersionSnapshot = CarriedVersionColumns & {
  fields: WritableEntityFieldSnapshot[];
};

export type WritableEntitySnapshot = Omit<EntitySnapshot, "versions"> & {
  versions: WritableEntityVersionSnapshot[];
};

/**
 * Which operation the target rows belong to. A copy is a new document: one
 * version, numbered 1, stamped and coded under the target matter. A move is
 * the same document in another matter, so every version keeps the number,
 * stamp and verification code already printed on it.
 */
export type EntityTransfer = { type: "copy" } | { type: "move" };

/** Entity columns every snapshot carries. */
export const ENTITY_SNAPSHOT_COLUMNS = {
  id: true,
  kind: true,
  name: true,
  parentId: true,
  readOnly: true,
  currentVersionId: true,
} as const;

const VERSION_FIELDS_SELECT = {
  // Ascending field id is ascending creation order, the order
  // `findExtractionFileField` requires, so the copy resolves the
  // same extraction source as the entity it came from. At most
  // one field per property bounds the read.
  columns: { id: true, propertyId: true, content: true },
  orderBy: { id: "asc" },
  limit: LIMITS.propertiesCount,
} as const;

/** A copy writes one version, so it reads one: the entity as it stands. */
export const CURRENT_VERSION_SELECT = {
  currentVersion: {
    columns: CARRIED_VERSION_COLUMNS,
    with: { fields: VERSION_FIELDS_SELECT },
  },
} as const;

/**
 * A move re-homes the document itself, so it reads the whole surviving
 * history, oldest first. Tombstoned versions stay behind with the source rows.
 */
export const EVERY_LIVE_VERSION_SELECT = {
  versions: {
    columns: CARRIED_VERSION_COLUMNS,
    where: { deletedAt: { isNull: true } },
    orderBy: { versionNumber: "asc" },
    limit: LIMITS.versionsPerEntity,
    with: { fields: VERSION_FIELDS_SELECT },
  },
} as const;

type EntityRowWithCurrentVersion = Omit<EntitySnapshot, "versions"> & {
  currentVersion: EntityVersionSnapshot | null;
};

/**
 * The copy loader's row as a snapshot. The version it loaded is by
 * construction the current one, so naming it here lets one insert path serve
 * both transfers.
 */
export const snapshotOfCurrentVersion = ({
  currentVersion,
  ...entity
}: EntityRowWithCurrentVersion): EntitySnapshot => ({
  ...entity,
  currentVersionId: currentVersion?.id ?? null,
  versions: currentVersion ? [currentVersion] : [],
});

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

export type CopiedField = {
  sourceEntityId: SafeId<"entity">;
  sourceFieldId: SafeId<"field">;
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
};

type CopiedFieldInsert = {
  id: SafeId<"field">;
  workspaceId: SafeId<"workspace">;
  propertyId: SafeId<"property">;
  entityVersionId: SafeId<"entityVersion">;
  content: WritableFieldContent;
};

export type FileMapping = {
  sourceKey: string;
  targetKey: string;
  newFileId: MintedFileId;
  sourceEntityId: SafeId<"entity">;
  sourceFileId: string;
  mimeType: string;
};

export type FileCopySource = {
  sourceEntityId: SafeId<"entity">;
  sourceKey: string;
  sourceFileId: string;
  mimeType: string;
};

type FileMappingKeyInput = {
  sourceEntityId: SafeId<"entity">;
  sourceFileId: string;
};

/**
 * One target object per source object per entity.
 *
 * Keyed by file id, not by property: consecutive versions of a document share
 * the object whose bytes did not change, and the whole carried history must
 * point at one copy of it the way the source did. Keyed per entity all the
 * same: S3 keys derive from the file id and deleting an entity deletes its
 * objects, so two entities that happen to reference one source object still
 * get an object each.
 */
const fileMappingKey = ({
  sourceEntityId,
  sourceFileId,
}: FileMappingKeyInput) => `${sourceEntityId}:${sourceFileId}`;

type CollectFileCopySourcesOptions = {
  sourceEntities: EntitySnapshot[];
  organizationId: SafeId<"organization">;
  sourceWorkspaceId: SafeId<"workspace">;
};

/**
 * Collect all source file objects needed for S3 copy, across every version the
 * transfer carries.
 */
export const collectFileCopySources = ({
  sourceEntities,
  organizationId,
  sourceWorkspaceId,
}: CollectFileCopySourcesOptions): FileCopySource[] => {
  const sources: FileCopySource[] = [];
  const collected = new Set<string>();

  for (const entity of sourceEntities) {
    for (const version of entity.versions) {
      for (const field of version.fields) {
        if (field.content.type !== "file" || !field.content.id) {
          continue;
        }
        const { mimeType, id: fileId } = field.content;
        const key = fileMappingKey({
          sourceEntityId: entity.id,
          sourceFileId: fileId,
        });
        if (collected.has(key)) {
          continue;
        }
        collected.add(key);
        sources.push({
          sourceEntityId: entity.id,
          sourceFileId: fileId,
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
  sourceKey,
  mimeType,
  organizationId,
  targetWorkspaceId,
  copiedS3Keys,
}: CopyFileObjectOptions): Promise<Result<FileMapping, S3PresignError>> => {
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
  return copied.map(() => ({
    sourceEntityId,
    sourceFileId,
    sourceKey,
    targetKey,
    newFileId,
    mimeType,
  }));
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
}: CopyFileObjectsOptions): Promise<
  Result<FileMapping[], FileObjectCopyError>
> => {
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
  const failures: unknown[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      failures.push(result.reason);
      continue;
    }
    if (Result.isError(result.value)) {
      failures.push(result.value.error);
      continue;
    }
    mappings.push(result.value.value);
  }

  if (failures.length > 0) {
    return Result.err(
      new FileObjectCopyError({
        message: "Failed to copy file object",
        cause: failures.at(0),
      }),
    );
  }

  return Result.ok(mappings);
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

  return sourceEntities.map((entity) => ({
    ...entity,
    versions: entity.versions.map((version) => ({
      ...version,
      fields: version.fields.map((field) =>
        remapFieldFileId({ entityId: entity.id, field, idMap }),
      ),
    })),
  }));
};

type RemapFieldFileIdOptions = {
  entityId: SafeId<"entity">;
  field: EntityFieldSnapshot;
  idMap: Map<string, MintedFileId>;
};

const remapFieldFileId = ({
  entityId,
  field,
  idMap,
}: RemapFieldFileIdOptions): WritableEntityFieldSnapshot => {
  if (field.content.type !== "file") {
    return {
      id: field.id,
      content: field.content,
      propertyId: field.propertyId,
    };
  }

  const newFileId = idMap.get(
    fileMappingKey({
      sourceEntityId: entityId,
      sourceFileId: field.content.id,
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

  const longestSuffix = `_${LIMITS.entitiesCount}`;
  const searchPrefix = truncateEntityName(
    base,
    Math.max(ENTITY_NAME_MAX_LENGTH - ext.length - longestSuffix.length, 0),
  );
  const pattern = `${escapeLike(searchPrefix)}%`;
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

  const collisionName = (suffixNumber: number) => {
    const suffix = `_${suffixNumber}`;
    const boundedExtension = truncateEntityName(
      ext,
      ENTITY_NAME_MAX_LENGTH - suffix.length,
    );
    const boundedBase = truncateEntityName(
      base,
      ENTITY_NAME_MAX_LENGTH - suffix.length - boundedExtension.length,
    );
    return `${boundedBase}${suffix}${boundedExtension}`;
  };

  let maxSuffixNumber = 0;
  for (const siblingName of siblingNames) {
    for (const match of siblingName.matchAll(/_(\d+)/gu)) {
      const suffixNumber = Number.parseInt(match[1] ?? "", 10);
      if (
        suffixNumber > maxSuffixNumber &&
        siblingName === collisionName(suffixNumber)
      ) {
        maxSuffixNumber = suffixNumber;
      }
    }
  }

  return collisionName(maxSuffixNumber + 1);
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
  copiedField: CopiedField | null;
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
  /** Stable root identity supplied by a replay-safe same-matter duplicate. */
  targetRootEntityId?: SafeId<"entity"> | undefined;
  /** Caller-selected name for the root copy; descendants retain their names. */
  targetRootName?: string | undefined;
  /** Source workspace ID for audit log (cross-workspace only). */
  sourceWorkspaceId?: SafeId<"workspace">;
  /**
   * Whether the target rows are a new document (a copy) or the same
   * document in another matter (a move, whose source rows the caller
   * deletes in this transaction). Only a move mutates the source
   * workspace, so only a move needs the source row locked — see the
   * lock-set comment below.
   */
  transfer: EntityTransfer;
  fieldMapping:
    | { type: "omit" }
    | { type: "single"; sourceFieldId: SafeId<"field"> };
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

/** A source version and the row written in its place. */
type VersionTransfer = {
  sourceVersionId: SafeId<"entityVersion">;
  targetVersionId: SafeId<"entityVersion">;
};

type TargetVersionValuesOptions = {
  /** Stamp allocated in the target matter; null for folders and tasks. */
  copyStamp: string | null;
  entityId: SafeId<"entity">;
  id: SafeId<"entityVersion">;
  transfer: EntityTransfer;
  version: WritableEntityVersionSnapshot;
  workspaceId: SafeId<"workspace">;
};

/**
 * The row written for one source version. A copy is a new document, so its
 * single version starts the history again under the target matter's reference;
 * a move reproduces the version it carries, down to the stamp printed on it.
 * The verification code is never among these values: `insertEntityVersions`
 * mints one per stamped row, and `carryVerificationCodes` moves the printed
 * ones across afterwards.
 */
const targetVersionValues = ({
  copyStamp,
  entityId,
  id,
  transfer,
  version,
  workspaceId,
}: TargetVersionValuesOptions) => {
  switch (transfer.type) {
    case "copy":
      return {
        id,
        workspaceId,
        entityId,
        versionNumber: 1,
        stamp: copyStamp,
      };
    case "move":
      return {
        id,
        workspaceId,
        entityId,
        versionNumber: version.versionNumber,
        stamp: version.stamp,
        label: version.label,
        description: version.description,
        diffWordsAdded: version.diffWordsAdded,
        diffWordsRemoved: version.diffWordsRemoved,
        createdBy: version.createdBy,
        source: version.source,
        collaborationContributorUserIds:
          version.collaborationContributorUserIds,
        detectedLanguage: version.detectedLanguage,
        createdAt: version.createdAt,
      };
    default:
      transfer satisfies never;
      return panic("Unhandled entity transfer");
  }
};

type ResolveRootCopyNameOptions = {
  tx: Transaction;
  rootSource: WritableEntitySnapshot | undefined;
  targetParentId: SafeId<"entity"> | null;
  targetRootName: string | undefined;
  targetWorkspaceId: SafeId<"workspace">;
};

/** The copy root's name in its target folder; `undefined` without a root. */
const resolveRootCopyName = async ({
  tx,
  rootSource,
  targetParentId,
  targetRootName,
  targetWorkspaceId,
}: ResolveRootCopyNameOptions): Promise<string | undefined> =>
  rootSource === undefined
    ? undefined
    : await resolveEntityName({
        tx,
        workspaceId: targetWorkspaceId,
        parentId: targetParentId,
        name: targetRootName ?? rootSource.name,
      });

type ValidateCopySourcesOptions = {
  sourceEntities: WritableEntitySnapshot[];
  sourceEntityId: SafeId<"entity">;
};

/**
 * Every rejection the copy loop could raise, checked in the loop's own order
 * before anything is written. Sources arrive parents first, so a child whose
 * parent has not been seen yet would have no copied parent to attach to.
 */
const validateCopySources = ({
  sourceEntities,
  sourceEntityId,
}: ValidateCopySourcesOptions): Result<void, HandlerError> => {
  const seen = new Set<SafeId<"entity">>();
  for (const source of sourceEntities) {
    if (
      !source.versions.some((version) => version.id === source.currentVersionId)
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Entity has no current version",
        }),
      );
    }
    if (
      source.id !== sourceEntityId &&
      (source.parentId === null || !seen.has(source.parentId))
    ) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Copy parent was not created",
        }),
      );
    }
    seen.add(source.id);
  }

  if (!seen.has(sourceEntityId)) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Copy root was not created",
      }),
    );
  }
  return Result.ok();
};

type LockCopyWorkspacesOptions = {
  tx: Transaction;
  transfer: EntityTransfer;
  sourceWorkspaceId: SafeId<"workspace"> | undefined;
  targetWorkspaceId: SafeId<"workspace">;
};

/**
 * Same-workspace duplicate and cross-workspace copy both lock the target only:
 * a pure copy never mutates the source workspace's rows or its cap, so locking
 * the source would only add unrelated contention (blocking uploads/tasks/clips
 * there) for no correctness benefit. Only a cross-workspace MOVE also locks the
 * source, since the caller deletes the source rows in the same transaction and
 * that must serialize with concurrent source-side inserts. Both ids go through
 * `lockWorkspacesForEntityCap`, which sorts them ascending before locking — see
 * that function for why this closes the cross-workspace ABBA between an A->B
 * and a concurrent B->A move.
 */
const lockCopyWorkspaces = async ({
  tx,
  transfer,
  sourceWorkspaceId,
  targetWorkspaceId,
}: LockCopyWorkspacesOptions): Promise<void> => {
  await lockWorkspacesForEntityCap(
    tx,
    sourceWorkspaceId && transfer.type === "move"
      ? [sourceWorkspaceId, targetWorkspaceId]
      : [targetWorkspaceId],
  );
};

type ValidateCopyTargetOptions = {
  tx: Transaction;
  copyCount: number;
  sourceWorkspaceId: SafeId<"workspace"> | undefined;
  targetParentId: SafeId<"entity"> | null;
  targetWorkspaceId: SafeId<"workspace">;
};

/**
 * The target workspace must have room for every copy, and a cross-workspace
 * copy's parent must be a folder there. A same-workspace duplicate already
 * validated the parent via the source entity fetch.
 */
const validateCopyTarget = async ({
  tx,
  copyCount,
  sourceWorkspaceId,
  targetParentId,
  targetWorkspaceId,
}: ValidateCopyTargetOptions): Promise<Result<void, HandlerError>> => {
  const entityCount = await tx.$count(
    entities,
    eq(entities.workspaceId, targetWorkspaceId),
  );

  if (entityCount + copyCount > LIMITS.entitiesCount) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Entities limit reached",
      }),
    );
  }

  if (!sourceWorkspaceId || !targetParentId) {
    return Result.ok();
  }

  const parent = await tx.query.entities.findFirst({
    where: {
      id: { eq: targetParentId },
      workspaceId: { eq: targetWorkspaceId },
    },
    columns: { kind: true },
  });

  if (!parent) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Target parent folder not found",
      }),
    );
  }

  if (parent.kind !== "folder") {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Target parent must be a folder",
      }),
    );
  }

  return Result.ok();
};

/** What every copied entity shares: where it lands and how it is written. */
type CopyScope = Pick<
  CopyEntitiesProps,
  | "organizationId"
  | "targetWorkspaceId"
  | "targetParentId"
  | "userId"
  | "sourceEntityId"
  | "targetRootEntityId"
  | "targetRootName"
  | "transfer"
  | "fieldMapping"
>;

/** Every row and result a copy produces, built before the first insert. */
type CopyRows = {
  entityRows: (typeof entities.$inferInsert)[];
  versionRows: ReturnType<typeof targetVersionValues>[];
  versionTransfers: VersionTransfer[];
  currentVersions: CurrentVersionAssignment[];
  fieldRows: CopiedFieldInsert[];
  copiedEntities: CopiedEntity[];
  copiedField: CopiedField | null;
  entityIdsBySearchIndexOwner: Record<SearchIndexOwner, SafeId<"entity">[]>;
  nativeExtractionRequests: NativeExtractionRunRequest[];
  fileFields: CopiedFileField[];
};

type CopyPlan = CopyRows & { rootEntityId: SafeId<"entity"> };

/** Where one source entity lands in the target workspace. */
type CopyTarget = {
  entityId: SafeId<"entity">;
  parentId: SafeId<"entity"> | null;
  name: string;
};

type ResolveCopyTargetOptions = {
  scope: CopyScope;
  source: WritableEntitySnapshot;
  rootCopyName: string | undefined;
  targetIdBySourceId: ReadonlyMap<SafeId<"entity">, SafeId<"entity">>;
};

/**
 * The root takes the caller's parent and resolved name, and the caller's id
 * when a replay-safe duplicate supplies one. Every descendant keeps its name
 * under the copy of its parent.
 */
const resolveCopyTarget = ({
  scope: { sourceEntityId, targetParentId, targetRootEntityId },
  source,
  rootCopyName,
  targetIdBySourceId,
}: ResolveCopyTargetOptions): CopyTarget => {
  if (source.id === sourceEntityId) {
    return {
      entityId: targetRootEntityId ?? createSafeId<"entity">(),
      parentId: targetParentId,
      name: rootCopyName ?? panic("Copy root name was not resolved"),
    };
  }

  const parentId = source.parentId
    ? targetIdBySourceId.get(source.parentId)
    : undefined;
  if (parentId === undefined) {
    panic("Copy source parent order was not validated");
  }
  return { entityId: createSafeId<"entity">(), parentId, name: source.name };
};

type AppendVersionRowsOptions = {
  rows: CopyRows;
  scope: CopyScope;
  source: WritableEntitySnapshot;
  entityId: SafeId<"entity">;
  copyStamp: string | null;
};

/** Mint a target version per source version; returns source id -> target id. */
const appendVersionRows = ({
  rows,
  scope: { targetWorkspaceId, transfer },
  source,
  entityId,
  copyStamp,
}: AppendVersionRowsOptions): Map<
  SafeId<"entityVersion">,
  SafeId<"entityVersion">
> => {
  const targetVersionIds = new Map<
    SafeId<"entityVersion">,
    SafeId<"entityVersion">
  >();
  for (const version of source.versions) {
    const targetVersionId = createSafeId<"entityVersion">();
    targetVersionIds.set(version.id, targetVersionId);
    rows.versionTransfers.push({
      sourceVersionId: version.id,
      targetVersionId,
    });
    rows.versionRows.push(
      targetVersionValues({
        copyStamp,
        entityId,
        id: targetVersionId,
        transfer,
        version,
        workspaceId: targetWorkspaceId,
      }),
    );
  }
  return targetVersionIds;
};

type AppendFieldRowsOptions = {
  rows: CopyRows;
  scope: CopyScope;
  source: WritableEntitySnapshot;
  target: CopyTarget;
  currentVersion: WritableEntityVersionSnapshot;
  targetVersionIds: ReadonlyMap<
    SafeId<"entityVersion">,
    SafeId<"entityVersion">
  >;
};

/**
 * Mint a target field per source field across every carried version; returns
 * the current version's rows. The returned field, derivative queueing and
 * extraction all describe the document as it stands, so they read the current
 * version's rows; older versions are carried for their history alone.
 */
const appendFieldRows = ({
  rows,
  scope: { sourceEntityId, targetRootName, targetWorkspaceId, fieldMapping },
  source,
  target,
  currentVersion,
  targetVersionIds,
}: AppendFieldRowsOptions): CopiedFieldInsert[] => {
  const renamedRootFileFieldId =
    source.id === sourceEntityId && targetRootName !== undefined
      ? currentVersion.fields.find(({ content }) => content.type === "file")?.id
      : undefined;

  const currentFieldRows: CopiedFieldInsert[] = [];
  for (const version of source.versions) {
    const entityVersionId =
      targetVersionIds.get(version.id) ??
      panic("Carried version was not written for the copied entity");
    const isCurrentVersion = version.id === currentVersion.id;

    for (const field of version.fields) {
      const fieldId = createSafeId<"field">();

      if (
        isCurrentVersion &&
        fieldMapping.type === "single" &&
        field.id === fieldMapping.sourceFieldId
      ) {
        rows.copiedField = {
          sourceEntityId: source.id,
          sourceFieldId: field.id,
          entityId: target.entityId,
          fieldId,
        };
      }

      // Track file fields for PDF derivative enqueueing
      if (isCurrentVersion && field.content.type === "file") {
        rows.fileFields.push({
          entityId: target.entityId,
          fieldId,
          mimeType: field.content.mimeType,
          encrypted: field.content.encrypted,
        });
      }

      const content =
        field.id === renamedRootFileFieldId && field.content.type === "file"
          ? {
              ...field.content,
              fileName: sanitizeFilename(target.name),
            }
          : field.content;
      const fieldRow = {
        id: fieldId,
        workspaceId: targetWorkspaceId,
        propertyId: field.propertyId,
        entityVersionId,
        content,
      };
      rows.fieldRows.push(fieldRow);
      if (isCurrentVersion) {
        currentFieldRows.push(fieldRow);
      }
    }
  }
  return currentFieldRows;
};

type AppendCopiedEntityOptions = {
  rows: CopyRows;
  scope: CopyScope;
  source: WritableEntitySnapshot;
  target: CopyTarget;
  stamp: EntityStamp | null;
};

/** Build every row for one copied entity and record how it gets indexed. */
const appendCopiedEntity = ({
  rows,
  scope,
  source,
  target,
  stamp,
}: AppendCopiedEntityOptions): void => {
  const currentVersion =
    source.versions.find((version) => version.id === source.currentVersionId) ??
    panic("Copy source current version was not validated");

  rows.entityRows.push({
    id: target.entityId,
    workspaceId: scope.targetWorkspaceId,
    kind: source.kind,
    parentId: target.parentId,
    name: target.name,
    duplicateSourceEntityId:
      source.id === scope.sourceEntityId && scope.targetRootEntityId
        ? scope.sourceEntityId
        : null,
    createdBy: scope.userId,
    docSequence: stamp?.docSequence ?? null,
  });

  const targetVersionIds = appendVersionRows({
    rows,
    scope,
    source,
    entityId: target.entityId,
    copyStamp: stamp?.stamp ?? null,
  });
  const newVersionId =
    targetVersionIds.get(currentVersion.id) ??
    panic("Current version was not written for the copied entity");
  rows.currentVersions.push({
    entityId: target.entityId,
    versionId: newVersionId,
  });

  const currentFieldRows = appendFieldRows({
    rows,
    scope,
    source,
    target,
    currentVersion,
    targetVersionIds,
  });

  // The field ids above are minted in insertion order, so this derives the
  // same source the post-commit processor would select without re-reading
  // each copied entity.
  const extractionRequest = nativeExtractionRunRequestForFields({
    entityId: target.entityId,
    entityVersionId: newVersionId,
    fields: currentFieldRows,
    organizationId: scope.organizationId,
    workspaceId: scope.targetWorkspaceId,
  });
  if (extractionRequest === null) {
    rows.entityIdsBySearchIndexOwner[SEARCH_INDEX_OWNER.searchMark].push(
      target.entityId,
    );
  } else {
    rows.entityIdsBySearchIndexOwner[SEARCH_INDEX_OWNER.durableExtraction].push(
      target.entityId,
    );
    rows.nativeExtractionRequests.push(extractionRequest);
  }
  rows.copiedEntities.push({
    sourceId: source.id,
    entityId: target.entityId,
    kind: source.kind,
    name: target.name,
    parentId: target.parentId,
  });
};

type PlanEntityCopiesOptions = {
  scope: CopyScope;
  sourceEntities: WritableEntitySnapshot[];
  documentStamps: EntityStamp[];
  rootCopyName: string | undefined;
};

/**
 * Mint every target id and build every row the copy writes, so the caller
 * writes them in one batch. Sources arrive parents first, so every parent
 * resolves from the ids already minted.
 */
const planEntityCopies = ({
  scope,
  sourceEntities,
  documentStamps,
  rootCopyName,
}: PlanEntityCopiesOptions): CopyPlan => {
  const rows: CopyRows = {
    entityRows: [],
    versionRows: [],
    versionTransfers: [],
    currentVersions: [],
    fieldRows: [],
    copiedEntities: [],
    copiedField: null,
    // Split by which mechanism owns each copy's search projection, so every
    // copy is covered exactly once: a durable extraction run indexes the
    // documents it extracts, and a dirty mark committed with this transaction
    // covers everything else.
    entityIdsBySearchIndexOwner: {
      [SEARCH_INDEX_OWNER.durableExtraction]: [],
      [SEARCH_INDEX_OWNER.searchMark]: [],
    },
    nativeExtractionRequests: [],
    fileFields: [],
  };
  const targetIdBySourceId = new Map<SafeId<"entity">, SafeId<"entity">>();
  let nextStampIndex = 0;

  for (const source of sourceEntities) {
    const target = resolveCopyTarget({
      scope,
      source,
      rootCopyName,
      targetIdBySourceId,
    });
    const stamp =
      source.kind === "document"
        ? (documentStamps.at(nextStampIndex++) ??
          panic("Fewer document stamps allocated than documents copied"))
        : null;
    appendCopiedEntity({ rows, scope, source, target, stamp });
    targetIdBySourceId.set(source.id, target.entityId);
  }

  return {
    ...rows,
    rootEntityId:
      targetIdBySourceId.get(scope.sourceEntityId) ??
      panic("Copy root was not validated"),
  };
};

type WriteCopyPlanOptions = {
  tx: Transaction;
  plan: CopyPlan;
  transfer: EntityTransfer;
  targetWorkspaceId: SafeId<"workspace">;
  sourceWorkspaceId: SafeId<"workspace"> | undefined;
  recordAuditEvent: AuditRecorder;
};

/** Insert the planned rows and record an audit event per copied entity. */
const writeCopyPlan = async ({
  tx,
  plan,
  transfer,
  targetWorkspaceId,
  sourceWorkspaceId,
  recordAuditEvent,
}: WriteCopyPlanOptions): Promise<void> => {
  await insertEntityBatch({
    tx,
    entityRows: plan.entityRows,
    versionRows: plan.versionRows,
    stampOrigin: transfer.type === "copy" ? "issued" : "copied",
    currentVersions: plan.currentVersions,
    fieldRows: plan.fieldRows,
  });

  // A copy's versions were minted their own codes by the insert above. A move
  // is the same document elsewhere, so the codes already printed on its
  // versions travel with them and keep resolving.
  if (transfer.type === "move") {
    await carryVerificationCodes(tx, plan.versionTransfers);
  }

  await tx
    .update(workspaces)
    .set({ lastActivityAt: new Date() })
    .where(eq(workspaces.id, targetWorkspaceId));

  await recordAuditEvent(
    tx,
    plan.copiedEntities.map((entity) => ({
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
};

/**
 * Copy entities to a target workspace. Used by both duplicate
 * (same workspace) and copy-to-workspace (cross-workspace).
 *
 * This runs inside the caller's transaction, and returning from a transaction
 * callback commits whatever it has already written. Every rejection is
 * therefore decided before the first write (the stamp allocation), so an
 * `Err` leaves nothing behind: no partially copied subtree survives, and every
 * copied object is an orphan the caller cleans up.
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
  targetRootEntityId,
  targetRootName,
  transfer,
  fieldMapping,
  dependencies = defaultCopyEntitiesDependencies,
}: CopyEntitiesProps): Promise<Result<CopyEntitiesResult, HandlerError>> => {
  await lockCopyWorkspaces({
    tx,
    transfer,
    sourceWorkspaceId,
    targetWorkspaceId,
  });

  const targetValidated = await validateCopyTarget({
    tx,
    copyCount: sourceEntities.length,
    sourceWorkspaceId,
    targetParentId,
    targetWorkspaceId,
  });
  if (Result.isError(targetValidated)) {
    return targetValidated;
  }

  const validated = validateCopySources({ sourceEntities, sourceEntityId });
  if (Result.isError(validated)) {
    return validated;
  }

  // The document rows are known before the copy starts, so the whole run of
  // sequence numbers is allocated in one counter upsert plus one reference
  // read instead of two statements per copied document. The filter keeps
  // source order, so each document consumes the stamp for its own position.
  const documentStamps = await allocateEntityStamps({
    tx,
    workspaceId: targetWorkspaceId,
    count: sourceEntities.filter((source) => source.kind === "document").length,
  });
  const rootCopyName = await resolveRootCopyName({
    tx,
    rootSource: sourceEntities.find((source) => source.id === sourceEntityId),
    targetParentId,
    targetRootName,
    targetWorkspaceId,
  });

  const plan = planEntityCopies({
    scope: {
      organizationId,
      targetWorkspaceId,
      targetParentId,
      userId,
      sourceEntityId,
      targetRootEntityId,
      targetRootName,
      transfer,
      fieldMapping,
    },
    sourceEntities,
    documentStamps,
    rootCopyName,
  });

  await writeCopyPlan({
    tx,
    plan,
    transfer,
    targetWorkspaceId,
    sourceWorkspaceId,
    recordAuditEvent,
  });

  // Written here, inside the copy transaction: the mark commits or rolls back
  // with the copies themselves, so a lost post-commit flush costs nothing.
  await dependencies.enqueueEntitySearchRepairs(
    tx,
    plan.entityIdsBySearchIndexOwner[SEARCH_INDEX_OWNER.searchMark],
  );
  const nativeExtractionRunIds = await dependencies.requestNativeExtractionRuns(
    {
      requests: plan.nativeExtractionRequests,
      tx,
    },
  );

  return Result.ok({
    entityId: plan.rootEntityId,
    entityIdsBySearchIndexOwner: plan.entityIdsBySearchIndexOwner,
    copiedEntities: plan.copiedEntities,
    copiedField: plan.copiedField,
    fileFields: plan.fileFields,
    nativeExtractionRunIds,
  });
};
