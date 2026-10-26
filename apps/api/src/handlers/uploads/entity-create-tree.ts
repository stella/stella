import { Result } from "better-result";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import { sha256HexToBase64 } from "@stll/sha256";

import type { Transaction } from "@/api/db/root";
import {
  type PendingUploadPurposeData,
  pendingUploads,
  workspaces,
} from "@/api/db/schema";
import { entityUploadRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { createErrorCapture } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { insertInChunks } from "@/api/lib/db/bulk-write";
import {
  createSiblingNamePlan,
  type NamedEntityInsert,
} from "@/api/lib/entities/sibling-name-insert";
import {
  type CurrentVersionAssignment,
  insertEntityBatch,
} from "@/api/lib/entity-versions/insert-entity-batch";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { resolveUploadMime } from "@/api/lib/files/utils";
import { LIMITS } from "@/api/lib/limits";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { presignUploadUrl } from "@/api/lib/s3-presign";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { flushEntitySearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueEntitySearchRepairs } from "@/api/lib/search/projection-repair-queue";
import {
  checkEntityCreateCapacityForInsert,
  checkEntityCreateParentForInsert,
  checkEntityCreateTargetForInsert,
  entityCreateWriteErrorMessage,
  type EntityCreateWriteFailureStatus,
} from "@/api/lib/uploads/entity-create";
import { documentUploadFileFields } from "@/api/lib/uploads/file-metadata-schema";
import {
  PRESIGN_URL_EXPIRY_SECONDS,
  tmpUploadKey,
  type UploadTimeline,
  uploadTimeline,
} from "@/api/lib/uploads/runtime";

const TREE_KEY_MAX_LENGTH = 512;

const treeDirectorySchema = v.object({
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(TREE_KEY_MAX_LENGTH)),
  parentKey: v.optional(
    v.nullable(
      v.pipe(v.string(), v.minLength(1), v.maxLength(TREE_KEY_MAX_LENGTH)),
    ),
  ),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
});

const treeFileSchema = v.object({
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(TREE_KEY_MAX_LENGTH)),
  parentKey: v.optional(
    v.nullable(
      v.pipe(v.string(), v.minLength(1), v.maxLength(TREE_KEY_MAX_LENGTH)),
    ),
  ),
  ...documentUploadFileFields,
});

const bodySchema = v.object({
  propertyId: v.optional(v.nullable(resourceIdSchema("property"))),
  parentId: v.optional(v.nullable(resourceIdSchema("entity"))),
  directories: v.pipe(
    v.array(treeDirectorySchema),
    v.maxLength(LIMITS.entitiesCount),
  ),
  files: v.pipe(v.array(treeFileSchema), v.maxLength(LIMITS.entitiesCount)),
});

type BodySchema = v.InferOutput<typeof bodySchema>;
type TreeDirectoryInput = v.InferOutput<typeof treeDirectorySchema>;
type TreeFileInput = v.InferOutput<typeof treeFileSchema>;

type NormalizedTreeDirectory = {
  key: string;
  parentKey: string | null;
  name: string;
};

type NormalizedTreeFile = {
  key: string;
  parentKey: string | null;
  name: string;
  mimeType: string;
  size: number;
  sha256Hex: string;
};

type SignedTreeFile = NormalizedTreeFile & {
  uploadId: SafeId<"pendingUpload">;
  resolvedMime: string;
  timeline: UploadTimeline;
  url: string;
  headers: Record<string, string>;
};

type NormalizedTree = {
  directories: NormalizedTreeDirectory[];
  files: NormalizedTreeFile[];
};

type PreparedTree = {
  directories: NormalizedTreeDirectory[];
  files: SignedTreeFile[];
};

type EntityCreatePurposeDataWithParent = Extract<
  PendingUploadPurposeData,
  { type: "entity_create" }
> & { parentId: SafeId<"entity"> | null };

type TreeWriteFile = {
  key: string;
  uploadId: SafeId<"pendingUpload">;
  parentId: SafeId<"entity"> | null;
  url: string;
  expiresAt: string;
  headers: Record<string, string>;
};

type TreeWriteResult =
  | {
      status: "ok";
      directories: { key: string; entityId: SafeId<"entity"> }[];
      files: TreeWriteFile[];
      indexedDirectoryIds: SafeId<"entity">[];
    }
  | {
      status:
        | EntityCreateWriteFailureStatus
        | "property-required"
        | "directory-parent-not-found"
        | "file-parent-not-found";
    };

const treeWriteErrorMessage = (
  status: Exclude<TreeWriteResult["status"], "ok">,
): string => {
  if (status === "property-required") {
    return "File property is required";
  }
  if (status === "directory-parent-not-found") {
    return "Directory parent not found in upload plan";
  }
  if (status === "file-parent-not-found") {
    return "File parent not found in upload plan";
  }
  return entityCreateWriteErrorMessage(status);
};

const normalizeDirectory = ({
  key,
  parentKey,
  name,
}: TreeDirectoryInput): Result<NormalizedTreeDirectory, HandlerError> => {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Directory name is required",
      }),
    );
  }

  return Result.ok({
    key,
    parentKey: parentKey ?? null,
    name: trimmedName,
  });
};

const normalizeFile = ({
  key,
  parentKey,
  name,
  mimeType,
  size,
  sha256Hex,
}: TreeFileInput): NormalizedTreeFile => ({
  key,
  parentKey: parentKey ?? null,
  name,
  mimeType,
  size,
  sha256Hex,
});

const normalizeTree = ({
  directories,
  files,
}: Pick<BodySchema, "directories" | "files">): Result<
  NormalizedTree,
  HandlerError
> => {
  const totalEntityCount = directories.length + files.length;
  if (totalEntityCount === 0) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Upload tree must contain at least one entity",
      }),
    );
  }
  if (totalEntityCount > LIMITS.entitiesCount) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Entities limit reached",
      }),
    );
  }

  const directoryKeys = new Set<string>();
  const normalizedDirectories: NormalizedTreeDirectory[] = [];
  for (const directoryInput of directories) {
    if (directoryKeys.has(directoryInput.key)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Duplicate directory key in upload plan",
        }),
      );
    }

    const normalized = normalizeDirectory(directoryInput);
    if (Result.isError(normalized)) {
      return Result.err(normalized.error);
    }
    if (
      normalized.value.parentKey &&
      !directoryKeys.has(normalized.value.parentKey)
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Directory parent must precede child in upload plan",
        }),
      );
    }

    directoryKeys.add(normalized.value.key);
    normalizedDirectories.push(normalized.value);
  }

  const fileKeys = new Set<string>();
  const normalizedFiles: NormalizedTreeFile[] = [];
  for (const fileInput of files) {
    if (fileKeys.has(fileInput.key)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Duplicate file key in upload plan",
        }),
      );
    }

    const normalized = normalizeFile(fileInput);
    if (normalized.parentKey && !directoryKeys.has(normalized.parentKey)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "File parent directory not found in upload plan",
        }),
      );
    }

    fileKeys.add(normalized.key);
    normalizedFiles.push(normalized);
  }

  return Result.ok({
    directories: normalizedDirectories,
    files: normalizedFiles,
  });
};

type PrepareSignedFilesProps = {
  userId: SafeId<"user">;
  files: NormalizedTreeFile[];
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  timeline: UploadTimeline;
};

const prepareSignedFiles = async ({
  userId,
  files,
  organizationId,
  workspaceId,
  timeline,
}: PrepareSignedFilesProps): Promise<
  Result<SignedTreeFile[], HandlerError>
> => {
  const signedFiles: SignedTreeFile[] = [];

  for (const file of files) {
    const uploadId = createSafeId<"pendingUpload">();
    const sanitizedName = sanitizeFilename(file.name);
    const resolvedMime = resolveUploadMime({
      declaredMime: file.mimeType,
      fileName: sanitizedName,
    });
    const tmpKey = tmpUploadKey({
      organizationId,
      uploadId,
      workspaceId,
    });
    const presign = await presignUploadUrl({
      userId,
      key: tmpKey,
      expiresIn: PRESIGN_URL_EXPIRY_SECONDS,
      contentType: resolvedMime,
      contentLength: file.size,
      sha256Base64: sha256HexToBase64(file.sha256Hex),
      scope: {
        organizationId,
        workspaceId,
      },
      tagAsTemporaryUpload: true,
    });
    if (Result.isError(presign)) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to issue upload URL",
          cause: presign.error,
        }),
      );
    }

    signedFiles.push({
      ...file,
      name: sanitizedName,
      uploadId,
      resolvedMime,
      timeline,
      url: presign.value.url,
      headers: presign.value.headers,
    });
  }

  return Result.ok(signedFiles);
};

type CreateDirectoryRowsProps = {
  tx: Transaction;
  directories: NormalizedTreeDirectory[];
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  rootParentId: SafeId<"entity"> | null;
  recordAuditEvent: AuditRecorder;
};

const createDirectoryRows = async ({
  tx,
  directories,
  workspaceId,
  userId,
  rootParentId,
  recordAuditEvent,
}: CreateDirectoryRowsProps): Promise<
  Result<
    {
      directoryIdsByKey: Map<string, SafeId<"entity">>;
      createdDirectories: { key: string; entityId: SafeId<"entity"> }[];
    },
    "directory-parent-not-found"
  >
> => {
  const directoryIdsByKey = new Map<string, SafeId<"entity">>();
  const createdDirectories: { key: string; entityId: SafeId<"entity"> }[] = [];
  const auditEvents: AuditEvent[] = [];
  // Ids are minted here and each parent resolves from an earlier directory, so
  // the loop only builds rows and `insertEntityBatch` writes them after it.
  const entityRows: NamedEntityInsert[] = [];
  const resolvePlannedName = await createSiblingNamePlan({ tx, workspaceId });
  const currentVersions: CurrentVersionAssignment[] = [];

  for (const directory of directories) {
    let parentId = rootParentId;
    if (directory.parentKey) {
      const directoryParentId = directoryIdsByKey.get(directory.parentKey);
      if (!directoryParentId) {
        return Result.err("directory-parent-not-found");
      }
      parentId = directoryParentId;
    }

    const entityId = createSafeId<"entity">();
    const entityVersionId = createSafeId<"entityVersion">();

    const resolvedName = resolvePlannedName({
      parentId,
      name: directory.name,
      kind: "folder",
    });
    entityRows.push({
      id: entityId,
      workspaceId,
      kind: "folder",
      parentId,
      name: resolvedName.name,
      createdBy: userId,
    });
    currentVersions.push({ entityId, versionId: entityVersionId });

    auditEvents.push({
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
      resourceId: entityId,
      changes: {
        created: {
          old: null,
          new: {
            kind: "folder",
            name: resolvedName.name,
            parentId,
          },
        },
      },
    });

    directoryIdsByKey.set(directory.key, entityId);
    createdDirectories.push({ key: directory.key, entityId });
  }

  await insertEntityBatch({
    tx,
    entityRows,
    versionRows: currentVersions.map(({ entityId, versionId }) => ({
      id: versionId,
      workspaceId,
      entityId,
      versionNumber: 1,
    })),
    stampOrigin: "issued",
    currentVersions,
    fieldRows: [],
  });
  if (auditEvents.length > 0) {
    await recordAuditEvent(tx, auditEvents);
  }

  return Result.ok({ directoryIdsByKey, createdDirectories });
};

type CreatePendingRowsProps = {
  tx: Transaction;
  files: SignedTreeFile[];
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  propertyId: SafeId<"property">;
  rootParentId: SafeId<"entity"> | null;
  directoryIdsByKey: ReadonlyMap<string, SafeId<"entity">>;
  now: Date;
};

const createPendingRows = async ({
  tx,
  files,
  workspaceId,
  organizationId,
  userId,
  propertyId,
  rootParentId,
  directoryIdsByKey,
  now,
}: CreatePendingRowsProps): Promise<
  Result<TreeWriteFile[], "file-parent-not-found">
> => {
  const createdFiles: TreeWriteFile[] = [];
  const pendingUploadRows: (typeof pendingUploads.$inferInsert)[] = [];

  for (const file of files) {
    let parentId = rootParentId;
    if (file.parentKey) {
      const directoryParentId = directoryIdsByKey.get(file.parentKey);
      if (!directoryParentId) {
        return Result.err("file-parent-not-found");
      }
      parentId = directoryParentId;
    }

    const purposeData: EntityCreatePurposeDataWithParent = {
      type: "entity_create",
      propertyId,
      parentId,
    };

    pendingUploadRows.push({
      id: file.uploadId,
      organizationId,
      workspaceId,
      userId,
      purpose: "entity_create",
      purposeData,
      declaredName: file.name,
      declaredMime: file.resolvedMime,
      declaredSize: file.size,
      declaredSha256: file.sha256Hex,
      status: "pending",
      expiresAt: file.timeline.finalizeDeadline,
      createdAt: now,
    });

    createdFiles.push({
      key: file.key,
      uploadId: file.uploadId,
      parentId,
      url: file.url,
      expiresAt: file.timeline.urlExpiresAt.toISOString(),
      headers: file.headers,
    });
  }

  await insertInChunks(pendingUploadRows, async (batch) => {
    // audit: skip — presigned URL bookkeeping; entity audit lands on finalize.
    await tx.insert(pendingUploads).values(batch);
  });

  return Result.ok(createdFiles);
};

// The purpose is fixed at entity_create, so the grant that purpose spends is
// the static gate; nothing is left for the handler to authorize.
const config = {
  contract: "patch",
  permissions: { entity: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: entityUploadRealtimeUpdates,
  mcp: { type: "internal", reason: "upload_mechanics" },
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

const entityCreateTree = createSafeHandler(
  config,
  async function* ({
    safeDb,
    session,
    workspaceId,
    user,
    body,
    recordAuditEvent,
  }) {
    const normalizedTree = normalizeTree(body);
    if (Result.isError(normalizedTree)) {
      return Result.err(normalizedTree.error);
    }
    const propertyId = body.propertyId ?? null;
    if (normalizedTree.value.files.length > 0 && !propertyId) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: treeWriteErrorMessage("property-required"),
        }),
      );
    }

    const now = new Date();
    const signedFiles = await prepareSignedFiles({
      userId: user.id,
      files: normalizedTree.value.files,
      organizationId: session.activeOrganizationId,
      workspaceId,
      timeline: uploadTimeline(now),
    });
    if (Result.isError(signedFiles)) {
      return Result.err(signedFiles.error);
    }

    const preparedTree: PreparedTree = {
      directories: normalizedTree.value.directories,
      files: signedFiles.value,
    };

    const writeResult = yield* Result.await(
      safeDb(async (tx): Promise<TreeWriteResult> => {
        const entityCount =
          preparedTree.directories.length + preparedTree.files.length;
        const capacityResult = await checkEntityCreateCapacityForInsert({
          tx,
          workspaceId,
          entityCount,
        });
        if (Result.isError(capacityResult)) {
          return { status: capacityResult.error };
        }

        const rootParentId = body.parentId ?? null;
        let createdFiles: TreeWriteFile[] = [];
        if (preparedTree.files.length > 0) {
          if (!propertyId) {
            return { status: "property-required" };
          }

          const targetResult = await checkEntityCreateTargetForInsert({
            tx,
            workspaceId,
            propertyId,
            parentId: rootParentId,
          });
          if (Result.isError(targetResult)) {
            return { status: targetResult.error };
          }
        } else {
          const parentResult = await checkEntityCreateParentForInsert({
            tx,
            workspaceId,
            parentId: rootParentId,
          });
          if (Result.isError(parentResult)) {
            return { status: parentResult.error };
          }
        }

        const directoryResult = await createDirectoryRows({
          tx,
          directories: preparedTree.directories,
          workspaceId,
          userId: user.id,
          rootParentId,
          recordAuditEvent,
        });
        if (Result.isError(directoryResult)) {
          return { status: directoryResult.error };
        }

        if (preparedTree.files.length > 0) {
          if (!propertyId) {
            return { status: "property-required" };
          }

          const pendingResult = await createPendingRows({
            tx,
            files: preparedTree.files,
            workspaceId,
            organizationId: session.activeOrganizationId,
            userId: user.id,
            propertyId,
            rootParentId,
            directoryIdsByKey: directoryResult.value.directoryIdsByKey,
            now,
          });
          if (Result.isError(pendingResult)) {
            return { status: pendingResult.error };
          }
          createdFiles = pendingResult.value;
        }

        if (preparedTree.directories.length > 0) {
          // audit: skip — activity timestamp mirrors the folder create audit rows.
          await tx
            .update(workspaces)
            .set({ lastActivityAt: now })
            .where(eq(workspaces.id, workspaceId));
        }

        const indexedDirectoryIds =
          directoryResult.value.createdDirectories.map(
            ({ entityId }) => entityId,
          );
        await enqueueEntitySearchRepairs(tx, indexedDirectoryIds);

        return {
          status: "ok",
          directories: directoryResult.value.createdDirectories,
          files: createdFiles,
          indexedDirectoryIds,
        };
      }),
    );
    if (writeResult.status !== "ok") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: treeWriteErrorMessage(writeResult.status),
        }),
      );
    }

    flushEntitySearchRepairs(writeResult.indexedDirectoryIds).catch(
      createErrorCapture(
        handlerErrorContext("entityCreateTree.flushEntitySearchRepairs"),
      ),
    );

    return Result.ok({
      directories: writeResult.directories,
      files: writeResult.files,
    });
  },
);

export default entityCreateTree;
