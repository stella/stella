/**
 * Read half of the entity-version DOCX round-trip: resolve an entity's
 * CURRENT version to a raw DOCX buffer, plus the ids a caller needs to
 * write a new version back (`createEntityVersionFromBuffer`, the write-back
 * half, in the sibling `create-entity-version-from-buffer.ts`). Split out
 * of `version-diff-sources.ts` (which still owns the diff/text-extraction
 * loaders `loadEntityVersionDiffSources` / `loadEntityVersionDocxText`):
 * this is genuinely shared write-back infrastructure, not chat-specific, so
 * it lives in `lib/` rather than a handler domain.
 */

import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import { createFileKey } from "@/api/handlers/files/utils";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

type LoadEntityVersionDocxBufferOptions = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
};

export type EntityVersionDocxBufferSource = {
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  entityVersionId: SafeId<"entityVersion">;
  buffer: ArrayBuffer;
  fileName: string;
  /** The property id of the DOCX file field, for `cloneFieldsForRevision`. */
  filePropertyId: SafeId<"property">;
};

/**
 * Resolve the active DOCX file of an entity's CURRENT version to a raw
 * buffer, plus the ids a caller needs to write a new version back
 * (`createEntityVersionFromBuffer`). Unlike `loadEntityVersionDocxText`
 * in `version-diff-sources.ts` (which extracts plain text for an arbitrary
 * version id), this always reads the entity's live `currentVersionId` -- the
 * headless AI edit tool always targets the document actually open in the
 * editor, not an arbitrary historical version -- and returns the undecoded
 * bytes folio needs to parse and re-serialize the package.
 *
 * The file field is selected by the server-validated active field id from
 * the file-chat context. An entity can contain several file properties, so
 * choosing the extraction field (or the first DOCX) could edit a different
 * file than the one the user has open.
 *
 * This is a plain `Promise`-returning function (not the `async function*`
 * generator style `loadEntityVersionDiffSources` / `loadEntityVersionDocxText`
 * use): those generators are meant to be `yield*`'d from an enclosing
 * `Result.gen` HTTP handler. This helper's only caller is a chat tool's
 * `.server()` executor, which is a plain async function with no such
 * enclosing generator -- so it follows the same directly-awaited `safeDb`
 * convention `version-compare-tools.ts` uses for its own chat-tool-consumed
 * loaders.
 */
export const loadEntityVersionDocxBuffer = async ({
  safeDb,
  workspaceId,
  organizationId,
  entityId,
  fileFieldId,
}: LoadEntityVersionDocxBufferOptions): Promise<
  Result<EntityVersionDocxBufferSource, HandlerError>
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
  if (entity.value.readOnly) {
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
    fileField.content.mimeType !== DOCX_MIME_TYPE ||
    fileField.content.encrypted
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "The active file field is not an editable DOCX file",
      }),
    );
  }
  const fileContent = fileField.content;

  const bufferResult = await Result.tryPromise({
    try: async () =>
      await getS3()
        .file(
          createFileKey({
            organizationId,
            workspaceId,
            fileId: fileContent.id,
            mimeType: DOCX_MIME_TYPE,
          }),
        )
        .arrayBuffer(),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Failed to read the document content",
        cause,
      }),
  });
  if (Result.isError(bufferResult)) {
    return Result.err(bufferResult.error);
  }

  return Result.ok({
    entityId,
    workspaceId,
    entityVersionId: currentVersionId,
    buffer: bufferResult.value,
    fileName: fileContent.fileName,
    filePropertyId: fileField.propertyId,
  });
};
