import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { Transaction } from "@/api/db";
import {
  entities,
  entityVersions,
  pendingUploads,
  type PendingUploadPurposeData,
  workspaces,
} from "@/api/db/schema";
import { resolveUploadMime } from "@/api/handlers/files/utils";
import {
  checkEntityCreateCapacityForInsert,
  checkEntityCreateParentForInsert,
  checkEntityCreateTargetForInsert,
  entityCreateWriteErrorMessage,
  type EntityCreateWriteFailureStatus,
} from "@/api/handlers/uploads/entity-create";
import {
  PRESIGN_URL_EXPIRY_SECONDS,
  sha256HexToBase64,
  tmpUploadKey,
} from "@/api/handlers/uploads/lib";
import {
  authorizeUploadPurpose,
  uploadRoutePermission,
} from "@/api/handlers/uploads/permissions";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import { presignUploadUrl } from "@/api/lib/s3-presign";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { getSearchProvider } from "@/api/lib/search/provider";

const TREE_KEY_MAX_LENGTH = 512;

const treeDirectorySchema = t.Object({
  key: t.String({ minLength: 1, maxLength: TREE_KEY_MAX_LENGTH }),
  parentKey: t.Optional(
    t.Nullable(t.String({ minLength: 1, maxLength: TREE_KEY_MAX_LENGTH })),
  ),
  name: t.String({ minLength: 1, maxLength: 255 }),
});

const treeFileSchema = t.Object({
  key: t.String({ minLength: 1, maxLength: TREE_KEY_MAX_LENGTH }),
  parentKey: t.Optional(
    t.Nullable(t.String({ minLength: 1, maxLength: TREE_KEY_MAX_LENGTH })),
  ),
  name: tDefaultVarchar,
  mimeType: t.String({ minLength: 1, maxLength: 255 }),
  size: t.Integer({
    minimum: 0,
    maximum: FILE_SIZE_LIMIT_BYTES.document,
  }),
  sha256Hex: t.RegExp(/^[0-9a-f]{64}$/u),
});

const bodySchema = t.Object({
  propertyId: t.Optional(t.Nullable(tSafeId("property"))),
  parentId: t.Optional(t.Nullable(tSafeId("entity"))),
  directories: t.Array(treeDirectorySchema, {
    maxItems: LIMITS.entitiesCount,
  }),
  files: t.Array(treeFileSchema, {
    maxItems: LIMITS.entitiesCount,
  }),
});

type BodySchema = Static<typeof bodySchema>;
type TreeDirectoryInput = Static<typeof treeDirectorySchema>;
type TreeFileInput = Static<typeof treeFileSchema>;

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
  expiresAt: Date;
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
  files: NormalizedTreeFile[];
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  expiresAt: Date;
};

const prepareSignedFiles = async ({
  files,
  organizationId,
  workspaceId,
  expiresAt,
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
        }),
      );
    }

    signedFiles.push({
      ...file,
      name: sanitizedName,
      uploadId,
      resolvedMime,
      expiresAt,
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

    await tx.insert(entities).values({
      id: entityId,
      workspaceId,
      kind: "folder",
      parentId,
      name: directory.name,
      createdBy: userId,
    });
    await tx.insert(entityVersions).values({
      id: entityVersionId,
      workspaceId,
      entityId,
      versionNumber: 1,
    });
    await tx
      .update(entities)
      .set({ currentVersionId: entityVersionId })
      .where(eq(entities.id, entityId));

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
      resourceId: entityId,
      changes: {
        created: {
          old: null,
          new: {
            kind: "folder",
            name: directory.name,
            parentId,
          },
        },
      },
    });

    directoryIdsByKey.set(directory.key, entityId);
    createdDirectories.push({ key: directory.key, entityId });
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

    // audit: skip — presigned URL bookkeeping; entity audit lands on finalize.
    await tx.insert(pendingUploads).values({
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
      expiresAt: file.expiresAt,
      createdAt: now,
    });

    createdFiles.push({
      key: file.key,
      uploadId: file.uploadId,
      parentId,
      url: file.url,
      expiresAt: file.expiresAt.toISOString(),
      headers: file.headers,
    });
  }

  return Result.ok(createdFiles);
};

const config = {
  permissions: uploadRoutePermission,
  body: bodySchema,
} satisfies HandlerConfig;

const entityCreateTree = createSafeHandler(
  config,
  async function* ({
    safeDb,
    session,
    workspaceId,
    user,
    memberRole,
    body,
    recordAuditEvent,
  }) {
    const authorization = authorizeUploadPurpose({
      memberRole,
      purpose: "entity_create",
    });
    if (Result.isError(authorization)) {
      return Result.err(authorization.error);
    }

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
    const expiresAt = new Date(
      now.getTime() + PRESIGN_URL_EXPIRY_SECONDS * 1000,
    );
    const signedFiles = await prepareSignedFiles({
      files: normalizedTree.value.files,
      organizationId: session.activeOrganizationId,
      workspaceId,
      expiresAt,
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

        return {
          status: "ok",
          directories: directoryResult.value.createdDirectories,
          files: createdFiles,
          indexedDirectoryIds: directoryResult.value.createdDirectories.map(
            ({ entityId }) => entityId,
          ),
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

    for (const entityId of writeResult.indexedDirectoryIds) {
      getSearchProvider().indexEntity(entityId).catch(captureError);
    }

    return Result.ok({
      directories: writeResult.directories,
      files: writeResult.files,
    });
  },
);

export default entityCreateTree;
