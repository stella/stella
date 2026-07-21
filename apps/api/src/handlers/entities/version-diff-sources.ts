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
import { getS3 } from "@/api/lib/s3";
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
