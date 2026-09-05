/**
 * Read half of the entity-version file round-trip: resolve the file an
 * entity's CURRENT version holds in a given field, and read its bytes. The
 * write-back half is `createEntityVersionFromBuffer` in the sibling module.
 *
 * Two layers so a caller that only needs the file's identity (to pin a run
 * against it, or to refuse an unsupported type) does not pay for the object
 * read: `resolveEntityVersionFile` answers from the database alone, and
 * `readEntityVersionFile` fetches the bytes for a resolved file.
 *
 * Every function here always reads the entity's live `currentVersionId`:
 * the callers act on the document as it is now, not on a historical
 * version. `loadEntityVersionDocxText` in `version-diff-sources.ts` is the
 * loader for an arbitrary version id.
 *
 * The file field is selected by a server-validated field id rather than by
 * "the first DOCX": an entity can hold several file properties, and picking
 * one by type could act on a different file than the one the user has open.
 */

import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createFileKey } from "@/api/lib/files/utils";
import { LIMITS } from "@/api/lib/limits";
import { readS3ArrayBuffer } from "@/api/lib/s3";
import { brandPersistedUserFileId } from "@/api/lib/safe-id-boundaries";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

type ResolveEntityVersionFileOptions = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  /**
   * Read-only entities are rejected by default because callers write a new
   * version back. A caller that only reads the bytes (to derive a separate
   * document) opts in here.
   */
  allowReadOnly?: boolean | undefined;
  /** When set, a file of any other type is rejected as not editable. */
  expectMimeType?: string | undefined;
};

export type EntityVersionFile = {
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  entityVersionId: SafeId<"entityVersion">;
  fileId: SafeId<"userFile">;
  fileName: string;
  mimeType: string;
  /** The property id of the file field, for `cloneFieldsForRevision`. */
  filePropertyId: SafeId<"property">;
};

export const resolveEntityVersionFile = async ({
  safeDb,
  workspaceId,
  entityId,
  fileFieldId,
  allowReadOnly = false,
  expectMimeType,
}: ResolveEntityVersionFileOptions): Promise<
  Result<EntityVersionFile, HandlerError>
> => {
  const entity = await safeDb((tx) =>
    tx.query.entities.findFirst({
      where: { id: { eq: entityId }, workspaceId: { eq: workspaceId } },
      columns: { currentVersionId: true, readOnly: true },
    }),
  );
  if (Result.isError(entity)) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Failed to look up the document",
        cause: entity.error,
      }),
    );
  }
  if (!entity.value?.currentVersionId) {
    return Result.err(
      new HandlerError({ status: 404, message: "Document not found" }),
    );
  }
  if (entity.value.readOnly && !allowReadOnly) {
    return Result.err(
      new HandlerError({ status: 409, message: "Document is read-only" }),
    );
  }

  const currentVersionId = entity.value.currentVersionId;

  const version = await safeDb((tx) =>
    tx.query.entityVersions.findFirst({
      where: {
        id: { eq: currentVersionId },
        entityId: { eq: entityId },
        workspaceId: { eq: workspaceId },
        deletedAt: { isNull: true },
      },
      columns: { id: true },
      with: {
        // SAFETY: one version's fields, bounded by LIMITS.propertiesCount via
        // the unique (propertyId, entityVersionId) index.
        fields: {
          columns: { content: true, id: true, propertyId: true },
          orderBy: { id: "asc" },
          limit: LIMITS.propertiesCount,
        },
      },
    }),
  );
  if (Result.isError(version)) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Failed to look up the document version",
        cause: version.error,
      }),
    );
  }
  if (!version.value) {
    return Result.err(
      new HandlerError({
        status: 404,
        message: "Current document version not found",
      }),
    );
  }

  const fileField = version.value.fields.find(
    (field) => field.id === fileFieldId,
  );
  if (
    !fileField ||
    fileField.content.type !== "file" ||
    fileField.content.encrypted ||
    (expectMimeType !== undefined &&
      fileField.content.mimeType !== expectMimeType)
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message:
          expectMimeType === DOCX_MIME_TYPE
            ? "The active file field is not an editable DOCX file"
            : "The active file field is not a readable file",
      }),
    );
  }
  const fileContent = fileField.content;

  return Result.ok({
    entityId,
    workspaceId,
    entityVersionId: currentVersionId,
    fileId: brandPersistedUserFileId(fileContent.id),
    fileName: fileContent.fileName,
    mimeType: fileContent.mimeType,
    filePropertyId: fileField.propertyId,
  });
};

export const readEntityVersionFile = async (
  file: EntityVersionFile,
  organizationId: SafeId<"organization">,
): Promise<Result<ArrayBuffer, HandlerError>> =>
  await Result.tryPromise({
    try: async () =>
      await readS3ArrayBuffer(
        createFileKey({
          organizationId,
          workspaceId: file.workspaceId,
          fileId: file.fileId,
          mimeType: file.mimeType,
        }),
      ),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Failed to read the document content",
        cause,
      }),
  });

type LoadEntityVersionFileBufferOptions = ResolveEntityVersionFileOptions & {
  organizationId: SafeId<"organization">;
};

export type EntityVersionFileBuffer = EntityVersionFile & {
  buffer: ArrayBuffer;
};

export const loadEntityVersionFileBuffer = async ({
  organizationId,
  ...options
}: LoadEntityVersionFileBufferOptions): Promise<
  Result<EntityVersionFileBuffer, HandlerError>
> => {
  const file = await resolveEntityVersionFile(options);
  if (Result.isError(file)) {
    return file;
  }
  const buffer = await readEntityVersionFile(file.value, organizationId);
  if (Result.isError(buffer)) {
    return buffer;
  }
  return Result.ok({ ...file.value, buffer: buffer.value });
};

type LoadEntityVersionDocxBufferOptions = Omit<
  LoadEntityVersionFileBufferOptions,
  "expectMimeType"
>;

/**
 * The DOCX case: the undecoded bytes folio parses and re-serialises. A
 * caller that hands the buffer to folio needs this guarantee, not just a
 * file.
 */
export const loadEntityVersionDocxBuffer = async (
  options: LoadEntityVersionDocxBufferOptions,
): Promise<Result<EntityVersionFileBuffer, HandlerError>> =>
  await loadEntityVersionFileBuffer({
    ...options,
    expectMimeType: DOCX_MIME_TYPE,
  });
