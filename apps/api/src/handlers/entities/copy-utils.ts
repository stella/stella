import { panic, Result, TaggedError } from "better-result";
import { deepEquals } from "bun";
import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";

import { chunk as chunkItems } from "@stll/concurrency/chunk";

import type { Transaction } from "@/api/db/root";
import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import type { EntityKind, FieldContent } from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { allocateEntityStamps } from "@/api/lib/document-counter";
import type { EntityStamp } from "@/api/lib/document-counter";
import { validateEntityRemovalState } from "@/api/lib/entities/entity-removal-state";
import {
  createSiblingNamePlan,
  resolveSiblingNameForInsert,
  type NamedEntityInsert,
  type ResolvedSiblingNames,
} from "@/api/lib/entities/sibling-name-insert";
import {
  lockWorkspacesForEntityCap,
  lockWorkspacesForEntityTransfer,
} from "@/api/lib/entity-cap-lock";
import {
  type CurrentVersionAssignment,
  insertEntityBatch,
} from "@/api/lib/entity-versions/insert-entity-batch";
import { carryVerificationCodes } from "@/api/lib/entity-versions/insert-entity-version";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { copyOrganizationFiles } from "@/api/lib/files/copy-organization-files";
import { deleteOrganizationFilesWithSignal } from "@/api/lib/files/delete-organization-file";
import { storedFileEncryption } from "@/api/lib/files/detect-file-encryption";
import {
  allocateFileObject,
  fileContentWithMintedObject,
  type MintedFileId,
  type WritableFieldContent,
} from "@/api/lib/files/file-object-ids";
import { pdfDerivativeStateForFile } from "@/api/lib/files/gotenberg";
import { thumbnailDerivativeStateForFile } from "@/api/lib/files/image-derivative";
import type { OrganizationFileUsageError } from "@/api/lib/files/organization-file-usage";
import { createFileKey } from "@/api/lib/files/utils";
import { admitFlowReviewTaskDeletion } from "@/api/lib/flows/review-gate-task";
import { admitTaskFlowMutation } from "@/api/lib/flows/review-task-admission";
import { LIMITS } from "@/api/lib/limits";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { copyObject, headObject } from "@/api/lib/s3-presign";
import type { S3PresignError } from "@/api/lib/s3-presign";
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
import { findExtractionFileFieldRow } from "@/api/lib/search/types";

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
} as const satisfies Record<keyof Omit<EntitySnapshot, "versions">, true>;

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

const FILE_COPY_CONCURRENCY = 16;

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
export const copyFileObject = async (
  options: CopyFileObjectOptions,
): Promise<
  Result<FileMapping, S3PresignError | OrganizationFileUsageError>
> => {
  const copied = await stageAndCopyFiles({
    sources: [options],
    organizationId: options.organizationId,
    targetWorkspaceId: options.targetWorkspaceId,
    copiedS3Keys: options.copiedS3Keys,
  });
  if (Result.isError(copied)) {
    return Result.err(copied.error);
  }
  const mapping = copied.value.at(0);
  if (!mapping) {
    panic("A successful file copy must have a destination mapping");
  }
  return Result.ok(mapping);
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

const stageAndCopyFiles = async ({
  sources,
  organizationId,
  targetWorkspaceId,
  copiedS3Keys,
}: CopyFileObjectsOptions): Promise<
  Result<FileMapping[], S3PresignError | OrganizationFileUsageError>
> => {
  const mappings = sources.map((source) => {
    const newFileId = allocateFileObject();
    const targetKey = createFileKey({
      organizationId,
      workspaceId: targetWorkspaceId,
      fileId: newFileId,
      mimeType: source.mimeType,
    });
    copiedS3Keys.push(targetKey);
    return { ...source, targetKey, newFileId };
  });
  const prepareFile = async ({ sourceKey, targetKey }: FileMapping) => {
    const source = isDeploymentFeatureEnabled("FEATURE_FILE_USAGE_LIMITS")
      ? await headObject(sourceKey)
      : Result.ok({ contentLength: 0 });
    if (Result.isError(source)) {
      return Result.err(source.error);
    }
    return Result.ok({
      organizationId,
      objectKey: targetKey,
      sizeBytes: source.value.contentLength,
      copy: async () => await copyObject(sourceKey, targetKey),
    });
  };
  const prepared: Awaited<ReturnType<typeof prepareFile>>[] = [];
  for (const itemBatch of chunkItems(mappings, FILE_COPY_CONCURRENCY)) {
    prepared.push(...(await Promise.all(itemBatch.map(prepareFile))));
  }
  const inputs = Result.all(prepared);
  if (Result.isError(inputs)) {
    return Result.err(inputs.error);
  }
  const copied = await copyOrganizationFiles({
    inputs: inputs.value,
    concurrency: FILE_COPY_CONCURRENCY,
  });
  if (Result.isError(copied)) {
    return Result.err(copied.error);
  }
  const completed = Result.all(copied.value);
  return Result.isError(completed)
    ? Result.err(completed.error)
    : Result.ok(mappings);
};

export const copyFileObjects = async (
  options: CopyFileObjectsOptions,
): Promise<Result<FileMapping[], FileObjectCopyError>> => {
  const copied = await stageAndCopyFiles(options);
  return Result.isError(copied)
    ? Result.err(
        new FileObjectCopyError({
          message: "Failed to copy file object",
          cause: copied.error,
        }),
      )
    : Result.ok(copied.value);
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
    encrypted: _encrypted,
    pdfDerivative: _pdfDerivative,
    placeholder: _placeholder,
    thumbnailDerivative: _thumbnailDerivative,
    ...restContent
  } = field.content;

  return {
    ...field,
    content: fileContentWithMintedObject({
      ...restContent,
      // A copy holds the same bytes, so the stored attribute carries over.
      encryption: storedFileEncryption(field.content),
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
  const result = Result.flatten(
    await Result.tryPromise({
      try: async () =>
        await deleteOrganizationFilesWithSignal(
          keys,
          AbortSignal.timeout(10_000),
        ),
      catch: (error: unknown) => error,
    }),
  );
  if (Result.isError(result)) {
    captureError(result.error, { source: "entity-copy-rollback" });
  }
};

export const resolveEntityName = resolveSiblingNameForInsert;

export const getFolderSubtree = <
  TEntity extends Pick<EntitySnapshot, "id" | "parentId">,
>(
  allEntities: TEntity[],
  rootId: SafeId<"entity">,
): TEntity[] | null => {
  const childrenByParentId = new Map<SafeId<"entity">, TEntity[]>();

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

  const subtree: TEntity[] = [];
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
  /** Caller-selected root label; descendants resolve against their copied siblings. */
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
  transfer:
    | { type: "copy" }
    | {
        type: "move";
        sourceWorkspaceId: SafeId<"workspace">;
        sourceSnapshot: EntitySnapshot[];
      };
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
}: ResolveRootCopyNameOptions): Promise<ResolvedSiblingNames | undefined> =>
  rootSource === undefined
    ? undefined
    : await resolveEntityName({
        tx,
        workspaceId: targetWorkspaceId,
        parentId: targetParentId,
        name: targetRootName ?? rootSource.name,
        kind: rootSource.kind,
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
  transfer: CopyEntitiesProps["transfer"];
  targetWorkspaceId: SafeId<"workspace">;
};

/**
 * Same-workspace duplicate and cross-workspace copy both lock the target only:
 * a pure copy never mutates the source workspace's rows or its cap, so locking
 * the source would only add unrelated contention (blocking uploads/tasks/clips
 * there) for no correctness benefit. Only a cross-workspace MOVE also locks the
 * source, since the caller deletes the source rows in the same transaction and
 * that must serialize with concurrent source-side inserts. Both ids go through
 * the shared workspace lock owner, which sorts them ascending before locking.
 * Moves use its transfer mode so source-side FK checks can finish while the
 * transfer waits for source rows.
 */
const lockCopyWorkspaces = async ({
  tx,
  transfer,
  targetWorkspaceId,
}: LockCopyWorkspacesOptions): Promise<void> => {
  if (transfer.type === "move") {
    await lockWorkspacesForEntityTransfer(tx, [
      transfer.sourceWorkspaceId,
      targetWorkspaceId,
    ]);
    return;
  }
  await lockWorkspacesForEntityCap(tx, [targetWorkspaceId]);
};

const orderedSourceSnapshot = (snapshot: EntitySnapshot[]) =>
  snapshot
    .map(({ readOnly = false, versions, ...entity }) => ({
      ...entity,
      readOnly,
      versions: versions
        .map(({ fields: versionFields, ...version }) => ({
          ...version,
          fields: versionFields.toSorted(
            (left, right) =>
              Number(left.id > right.id) - Number(left.id < right.id),
          ),
        }))
        .toSorted(
          (left, right) =>
            Number(left.id > right.id) - Number(left.id < right.id),
        ),
    }))
    .toSorted(
      (left, right) => Number(left.id > right.id) - Number(left.id < right.id),
    );

/** Row order is incidental; every carried column and row identity is not. */
export const sourceSnapshotsMatch = (
  expected: EntitySnapshot[],
  current: EntitySnapshot[],
): boolean =>
  deepEquals(orderedSourceSnapshot(expected), orderedSourceSnapshot(current));

type ValidateMoveSourceOptions = {
  tx: Transaction;
  sourceEntityId: SafeId<"entity">;
  sourceWorkspaceId: SafeId<"workspace">;
  sourceSnapshot: EntitySnapshot[];
};

export const validateMoveSourceReadLimits = async ({
  tx,
  sourceWorkspaceId,
  sourceSnapshot,
}: Omit<ValidateMoveSourceOptions, "sourceEntityId">): Promise<
  Result<void, HandlerError>
> => {
  const sourceIds = sourceSnapshot.map(({ id }) => id);
  const overVersionLimit = await tx
    .select({ entityId: entityVersions.entityId })
    .from(entityVersions)
    .where(
      and(
        eq(entityVersions.workspaceId, sourceWorkspaceId),
        inArray(entityVersions.entityId, sourceIds),
        isNull(entityVersions.deletedAt),
      ),
    )
    .groupBy(entityVersions.entityId)
    .having(sql`${count()} > ${LIMITS.versionsPerEntity}`)
    .limit(1);
  const overFieldLimit = await tx
    .select({ entityVersionId: fields.entityVersionId })
    .from(fields)
    .innerJoin(entityVersions, eq(fields.entityVersionId, entityVersions.id))
    .where(
      and(
        eq(fields.workspaceId, sourceWorkspaceId),
        inArray(entityVersions.entityId, sourceIds),
        isNull(entityVersions.deletedAt),
      ),
    )
    .groupBy(fields.entityVersionId)
    .having(sql`${count()} > ${LIMITS.propertiesCount}`)
    .limit(1);
  if (overVersionLimit.length === 0 && overFieldLimit.length === 0) {
    return Result.ok();
  }
  return Result.err(
    new HandlerError({
      status: 409,
      code: "entity_transfer_source_limit",
      retryable: false,
      message: "The source has too many versions or fields to move.",
    }),
  );
};

/** A failed NOWAIT must roll back its savepoint before returning a refusal. */
const validateMoveSource = async (
  options: ValidateMoveSourceOptions,
): Promise<Result<void, HandlerError>> => {
  const checked = await Result.tryPromise(
    async () =>
      await options.tx.transaction(
        async (tx) => await validateMoveSourceRows({ ...options, tx }),
      ),
  );
  if (Result.isOk(checked)) {
    return checked.value;
  }
  if (getPgErrorCode(checked.error) !== PG_ERROR.LOCK_NOT_AVAILABLE) {
    return Result.err(
      new HandlerError({
        cause: checked.error,
        status: 500,
        message: "Failed to validate the entity transfer source",
      }),
    );
  }
  return Result.err(
    new HandlerError({
      cause: checked.error,
      status: 409,
      code: "entity_transfer_source_changed",
      retryable: true,
      message: "The source changed or is busy. Try moving it again.",
    }),
  );
};

/** The unremapped snapshot is the exact state a move is allowed to remove. */
const validateMoveSourceRows = async ({
  tx,
  sourceEntityId,
  sourceWorkspaceId,
  sourceSnapshot,
}: ValidateMoveSourceOptions): Promise<Result<void, HandlerError>> => {
  const sourceIds = sourceSnapshot.map(({ id }) => id);
  const expectedVersionIds = new Set(
    sourceSnapshot.flatMap(({ versions }) => versions.map(({ id }) => id)),
  );
  const expectedFieldIds = new Set(
    sourceSnapshot.flatMap(({ versions }) =>
      versions.flatMap(({ fields: versionFields }) =>
        versionFields.map(({ id }) => id),
      ),
    ),
  );
  await tx
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, sourceWorkspaceId),
        inArray(entities.id, sourceIds),
      ),
    )
    .orderBy(asc(entities.id))
    .limit(sourceIds.length)
    .for("update", { noWait: true });
  // Annotations and derived field content can change without an entity write.
  // Lock those owners as well before reading the full carried state.
  const liveVersions = await tx
    .select({ id: entityVersions.id })
    .from(entityVersions)
    .where(
      and(
        eq(entityVersions.workspaceId, sourceWorkspaceId),
        inArray(entityVersions.entityId, sourceIds),
        isNull(entityVersions.deletedAt),
      ),
    )
    .orderBy(asc(entityVersions.id))
    .limit(expectedVersionIds.size + 1)
    .for("update", { noWait: true });
  const liveFields = await tx
    .select({ id: fields.id })
    .from(fields)
    .innerJoin(entityVersions, eq(fields.entityVersionId, entityVersions.id))
    .where(
      and(
        eq(fields.workspaceId, sourceWorkspaceId),
        inArray(entityVersions.entityId, sourceIds),
        isNull(entityVersions.deletedAt),
      ),
    )
    .orderBy(asc(fields.id))
    .limit(expectedFieldIds.size + 1)
    .for("update", { of: fields, noWait: true });

  // Activity may have started during the object copy. Source locks keep new
  // dependent inserts from passing their foreign-key checks before deletion.
  const removal = await validateEntityRemovalState({
    tx,
    workspaceId: sourceWorkspaceId,
    entityIds: sourceIds,
    operation: "move",
    now: new Date(),
  });
  if (Result.isError(removal)) {
    return removal;
  }
  const limits = await validateMoveSourceReadLimits({
    tx,
    sourceWorkspaceId,
    sourceSnapshot,
  });
  if (Result.isError(limits)) {
    return limits;
  }

  // Read full history only for the source set, never for the entire matter.
  const currentEntities = await tx.query.entities.findMany({
    where: {
      workspaceId: { eq: sourceWorkspaceId },
      id: { in: sourceIds },
    },
    columns: ENTITY_SNAPSHOT_COLUMNS,
    with: EVERY_LIVE_VERSION_SELECT,
    limit: sourceIds.length,
  });
  let membershipMatches = true;
  if (
    sourceSnapshot.find(({ id }) => id === sourceEntityId)?.kind === "folder"
  ) {
    // Workspace locks exclude inserts; source entity locks exclude moving a
    // child out, and the folder-parent locks exclude moving a child in.
    const workspaceEntities = await tx.query.entities.findMany({
      where: { workspaceId: { eq: sourceWorkspaceId } },
      columns: ENTITY_SNAPSHOT_COLUMNS,
      limit: LIMITS.entitiesCount,
    });
    const currentSubtree = getFolderSubtree(workspaceEntities, sourceEntityId);
    const expectedIds = new Set(sourceIds);
    membershipMatches =
      currentSubtree !== null &&
      currentSubtree.length === expectedIds.size &&
      currentSubtree.every(({ id }) => expectedIds.has(id));
  }
  if (
    !membershipMatches ||
    liveVersions.length !== expectedVersionIds.size ||
    liveVersions.some(({ id }) => !expectedVersionIds.has(id)) ||
    liveFields.length !== expectedFieldIds.size ||
    liveFields.some(({ id }) => !expectedFieldIds.has(id)) ||
    !sourceSnapshotsMatch(sourceSnapshot, currentEntities)
  ) {
    return Result.err(
      new HandlerError({
        status: 409,
        code: "entity_transfer_source_changed",
        retryable: true,
        message: "The source changed. Try moving it again.",
      }),
    );
  }
  return Result.ok();
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
  entityRows: NamedEntityInsert[];
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
  name: ResolvedSiblingNames["name"];
  fileName: ResolvedSiblingNames["fileName"];
};

type ResolveCopyTargetOptions = {
  scope: CopyScope;
  source: WritableEntitySnapshot;
  rootCopyName: ResolvedSiblingNames | undefined;
  targetIdBySourceId: ReadonlyMap<SafeId<"entity">, SafeId<"entity">>;
  resolvePlannedName: Awaited<ReturnType<typeof createSiblingNamePlan>>;
};

/**
 * The root takes the caller's parent and resolved name, and the caller's id
 * when a replay-safe duplicate supplies one. Descendants reserve their names
 * among the siblings planned under each copied parent.
 */
const resolveCopyTarget = ({
  scope: { sourceEntityId, targetParentId, targetRootEntityId },
  source,
  rootCopyName,
  targetIdBySourceId,
  resolvePlannedName,
}: ResolveCopyTargetOptions): CopyTarget => {
  if (source.id === sourceEntityId) {
    return {
      entityId: targetRootEntityId ?? createSafeId<"entity">(),
      parentId: targetParentId,
      ...(rootCopyName ?? panic("Copy root name was not resolved")),
    };
  }

  const parentId = source.parentId
    ? targetIdBySourceId.get(source.parentId)
    : undefined;
  if (parentId === undefined) {
    panic("Copy source parent order was not validated");
  }
  return {
    entityId: createSafeId<"entity">(),
    parentId,
    ...resolvePlannedName({
      name: source.name,
      kind: source.kind,
      parentId,
    }),
  };
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
  scope: { targetWorkspaceId, fieldMapping },
  source,
  target,
  currentVersion,
  targetVersionIds,
}: AppendFieldRowsOptions): CopiedFieldInsert[] => {
  const primaryFile = findExtractionFileFieldRow(currentVersion.fields);

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
        isCurrentVersion && primaryFile !== null && field.id === primaryFile.id
          ? {
              ...primaryFile.content,
              fileName: target.fileName,
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
  tx: Transaction;
  scope: CopyScope;
  sourceEntities: WritableEntitySnapshot[];
  documentStamps: EntityStamp[];
  rootCopyName: ResolvedSiblingNames | undefined;
};

/**
 * Mint every target id and build every row the copy writes, so the caller
 * writes them in one batch. Sources arrive parents first, so every parent
 * resolves from the ids already minted.
 */
const planEntityCopies = async ({
  tx,
  scope,
  sourceEntities,
  documentStamps,
  rootCopyName,
}: PlanEntityCopiesOptions): Promise<CopyPlan> => {
  const resolvePlannedName = await createSiblingNamePlan({
    tx,
    workspaceId: scope.targetWorkspaceId,
  });
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
      resolvePlannedName,
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
  sourceWorkspaceId: copySourceWorkspaceId,
  targetRootEntityId,
  targetRootName,
  transfer,
  fieldMapping,
  dependencies = defaultCopyEntitiesDependencies,
}: CopyEntitiesProps): Promise<Result<CopyEntitiesResult, HandlerError>> => {
  const sourceWorkspaceId =
    transfer.type === "move"
      ? transfer.sourceWorkspaceId
      : (copySourceWorkspaceId ?? targetWorkspaceId);
  const sourceAdmission = await admitTaskFlowMutation(tx, {
    workspaceId: sourceWorkspaceId,
    userId,
    target: {
      type: "subtree",
      rootEntityIds: [sourceEntityId],
      additionalEntityIds: sourceEntities.map((entity) => entity.id),
    },
  });
  if (sourceAdmission.isErr()) {
    return sourceAdmission;
  }
  const targetAdmission = await admitTaskFlowMutation(tx, {
    workspaceId: targetWorkspaceId,
    userId,
    target: {
      type: "entities",
      entityIds: [targetParentId, targetRootEntityId].filter(
        (id) => id !== null && id !== undefined,
      ),
    },
  });
  if (targetAdmission.isErr()) {
    return targetAdmission;
  }
  if (transfer.type === "move") {
    const deletionAdmission = await admitFlowReviewTaskDeletion(tx, {
      workspaceId: sourceWorkspaceId,
      taskEntityIds: sourceEntities.map((entity) => entity.id),
      userId,
    });
    if (deletionAdmission.isErr()) {
      return deletionAdmission;
    }
  }
  await lockCopyWorkspaces({
    tx,
    transfer,
    targetWorkspaceId,
  });

  if (transfer.type === "move") {
    const sourceValidated = await validateMoveSource({
      tx,
      sourceEntityId,
      sourceWorkspaceId: transfer.sourceWorkspaceId,
      sourceSnapshot: transfer.sourceSnapshot,
    });
    if (Result.isError(sourceValidated)) {
      return sourceValidated;
    }
  }

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

  const plan = await planEntityCopies({
    tx,
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
