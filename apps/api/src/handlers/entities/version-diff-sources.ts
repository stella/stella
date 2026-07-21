/**
 * Shared resolution step for the entity version diff and AI
 * change-summary endpoints: turn a version ID into plain text for
 * that version's DOCX file and its predecessor's, after validating
 * the version belongs to the workspace. Mirrors the lookup in
 * `compute-version-diff.ts`, but returns the extracted text instead
 * of persisting stats.
 */

import { Result } from "better-result";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { entityVersions, fields } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { extractText } from "@/api/handlers/docx/extract-text";
import { createFileKey } from "@/api/handlers/files/utils";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import { findExtractionFileField } from "@/api/lib/search/types";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

type LoadEntityVersionDiffSourcesOptions = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  entityId: SafeId<"entity">;
  versionId: SafeId<"entityVersion">;
};

const findDocxFile = (
  fieldList: { content: FieldContent }[],
): Extract<FieldContent, { type: "file" }> | null => {
  for (const f of fieldList) {
    if (f.content.type === "file" && f.content.mimeType === DOCX_MIME_TYPE) {
      return f.content;
    }
  }
  return null;
};

export const loadEntityVersionDiffSources = async function* ({
  safeDb,
  workspaceId,
  organizationId,
  entityId,
  versionId,
}: LoadEntityVersionDiffSourcesOptions) {
  const version = yield* Result.await(
    safeDb((tx) =>
      tx.query.entityVersions.findFirst({
        where: {
          id: { eq: versionId },
          entityId: { eq: entityId },
          workspaceId: { eq: workspaceId },
          deletedAt: { isNull: true },
        },
        columns: { versionNumber: true },
      }),
    ),
  );

  if (!version) {
    return yield* Result.err(
      new HandlerError({ status: 404, message: "Version not found" }),
    );
  }

  const previousRows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({ id: entityVersions.id })
        .from(entityVersions)
        .where(
          and(
            eq(entityVersions.entityId, entityId),
            eq(entityVersions.workspaceId, workspaceId),
            lt(entityVersions.versionNumber, version.versionNumber),
            isNull(entityVersions.deletedAt),
          ),
        )
        .orderBy(desc(entityVersions.versionNumber))
        .limit(1),
    ),
  );
  const previousVersionId = previousRows.at(0)?.id ?? null;

  const versionIds = [
    versionId,
    ...(previousVersionId ? [previousVersionId] : []),
  ];
  // Join entity_versions and require a live (non-tombstoned) version in the SAME
  // query as the content read. Reading fields separately (keyed only by
  // entityVersionId) after the `deletedAt IS NULL` check above left a TOCTOU
  // window: a tombstone landing between the two reads would still surface the
  // withdrawn version's DOCX content. If the target version is tombstoned
  // concurrently, its fields drop out here and the caller gets a 400 rather
  // than the withdrawn bytes.
  const fieldRows = yield* Result.await(
    safeDb((tx) =>
      // SAFETY: at most two version ids (current + previous); each version's
      // fields are bounded by LIMITS.propertiesCount via the unique
      // (propertyId, entityVersionId) index.
      tx
        .select({
          entityVersionId: fields.entityVersionId,
          content: fields.content,
        })
        .from(fields)
        .innerJoin(
          entityVersions,
          eq(entityVersions.id, fields.entityVersionId),
        )
        .where(
          and(
            inArray(fields.entityVersionId, versionIds),
            eq(fields.workspaceId, workspaceId),
            isNull(entityVersions.deletedAt),
          ),
        ),
    ),
  );

  const currentFile = findDocxFile(
    fieldRows.filter((f) => f.entityVersionId === versionId),
  );
  if (!currentFile) {
    return yield* Result.err(
      new HandlerError({
        status: 400,
        message: "Version does not contain a DOCX file",
      }),
    );
  }

  // The previous version may predate DOCX uploads (or hold another
  // format); diff against the empty document in that case.
  const previousFile = previousVersionId
    ? findDocxFile(
        fieldRows.filter((f) => f.entityVersionId === previousVersionId),
      )
    : null;

  const texts = yield* Result.await(
    Result.tryPromise({
      try: async () => {
        const toText = async (fileId: string) => {
          const buffer = await getS3()
            .file(
              createFileKey({
                organizationId,
                workspaceId,
                fileId,
                mimeType: DOCX_MIME_TYPE,
              }),
            )
            .arrayBuffer();
          const extracted = await extractText(new Uint8Array(buffer));
          return extracted.paragraphs.map((p) => p.text).join("\n");
        };
        const [currentText, prevText] = await Promise.all([
          toText(currentFile.id),
          previousFile ? toText(previousFile.id) : Promise.resolve(""),
        ]);
        return { currentText, prevText };
      },
      catch: (cause) =>
        new HandlerError({
          status: 500,
          message: "Failed to read version content",
          cause,
        }),
    }),
  );

  return texts;
};

type LoadEntityVersionDocxTextOptions = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  entityId: SafeId<"entity">;
  versionId: SafeId<"entityVersion">;
};

// Extract the plain text of one entity version's DOCX file, after validating
// the version belongs to the workspace and entity. Powers arbitrary two-version
// comparison (the diff-against-predecessor case stays in
// `loadEntityVersionDiffSources`).
export const loadEntityVersionDocxText = async function* ({
  safeDb,
  workspaceId,
  organizationId,
  entityId,
  versionId,
}: LoadEntityVersionDocxTextOptions) {
  // Read the version and its fields in one tombstone-checked query. Fetching
  // the fields separately (keyed only by entityVersionId) after the version's
  // `deletedAt IS NULL` check left a TOCTOU window that could surface a
  // just-withdrawn version's DOCX content.
  const version = yield* Result.await(
    safeDb((tx) =>
      tx.query.entityVersions.findFirst({
        where: {
          id: { eq: versionId },
          entityId: { eq: entityId },
          workspaceId: { eq: workspaceId },
          deletedAt: { isNull: true },
        },
        columns: { id: true },
        with: {
          // SAFETY: one version's fields, bounded by LIMITS.propertiesCount via
          // the unique (propertyId, entityVersionId) index.
          fields: { columns: { content: true } },
        },
      }),
    ),
  );
  if (!version) {
    return Result.err(
      new HandlerError({ status: 404, message: "Version not found" }),
    );
  }

  const file = findDocxFile(version.fields);
  if (!file) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Version does not contain a DOCX file",
      }),
    );
  }

  const text = yield* Result.await(
    Result.tryPromise({
      try: async () => {
        const buffer = await getS3()
          .file(
            createFileKey({
              organizationId,
              workspaceId,
              fileId: file.id,
              mimeType: DOCX_MIME_TYPE,
            }),
          )
          .arrayBuffer();
        const extracted = await extractText(new Uint8Array(buffer));
        return extracted.paragraphs.map((p) => p.text).join("\n");
      },
      catch: (cause) =>
        new HandlerError({
          status: 500,
          message: "Failed to read version content",
          cause,
        }),
    }),
  );

  return Result.ok(text);
};

type LoadEntityVersionDocxBufferOptions = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  entityId: SafeId<"entity">;
};

export type EntityVersionDocxBufferSource = {
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  entityVersionId: SafeId<"entityVersion">;
  buffer: ArrayBuffer;
  fileName: string;
  /** The property id of the DOCX file field, for `cloneFieldsForRevision`. */
  filePropertyId: SafeId<"property">;
  /** Every field of the current version, for `cloneFieldsForRevision`. */
  currentFields: { content: FieldContent; propertyId: SafeId<"property"> }[];
};

/**
 * Resolve the active DOCX file of an entity's CURRENT version to a raw
 * buffer, plus the ids a caller needs to write a new version back
 * (`createEntityVersionFromBuffer`). Unlike `loadEntityVersionDocxText`
 * above (which extracts plain text for an arbitrary version id), this
 * always reads the entity's live `currentVersionId` -- the headless AI
 * edit tool always targets the document actually open in the editor, not
 * an arbitrary historical version -- and returns the undecoded bytes folio
 * needs to parse and re-serialize the package.
 *
 * The file field is picked via `findExtractionFileField` (not a
 * DOCX-mime scan) so an AI edit always targets the SAME field the
 * extraction pipeline reads and indexes -- see that function's own
 * ordering contract, replicated here (`orderBy: { id: "asc" }`).
 *
 * This is a plain `Promise`-returning function (not the `async function*`
 * generator style `loadEntityVersionDiffSources` / `loadEntityVersionDocxText`
 * use above): those generators are meant to be `yield*`'d from an enclosing
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
        // the unique (propertyId, entityVersionId) index. Ordered by id (a
        // Bun.randomUUIDv7() primary key) to match findExtractionFileField's
        // ordering contract.
        fields: {
          columns: { content: true, propertyId: true },
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

  const fileField = findExtractionFileField(version.value.fields);
  if (!fileField || fileField.mimeType !== DOCX_MIME_TYPE) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "The active document is not a DOCX file",
      }),
    );
  }
  const fileFieldRow = version.value.fields.find(
    (f) => f.content.type === "file" && f.content.id === fileField.id,
  );
  if (!fileFieldRow) {
    // Unreachable: `fileField` was itself read out of `version.value.fields`.
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Failed to resolve the active document's file field",
      }),
    );
  }

  const bufferResult = await Result.tryPromise({
    try: async () =>
      await getS3()
        .file(
          createFileKey({
            organizationId,
            workspaceId,
            fileId: fileField.id,
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
    fileName: fileField.fileName,
    filePropertyId: fileFieldRow.propertyId,
    currentFields: version.value.fields,
  });
};
