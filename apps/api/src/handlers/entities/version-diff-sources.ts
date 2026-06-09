/**
 * Shared resolution step for the entity version diff and AI
 * change-summary endpoints: turn a version ID into plain text for
 * that version's DOCX file and its predecessor's, after validating
 * the version belongs to the workspace. Mirrors the lookup in
 * `compute-version-diff.ts`, but returns the extracted text instead
 * of persisting stats.
 */

import { Result } from "better-result";
import { and, desc, eq, lt } from "drizzle-orm";

import type { SafeDb } from "@/api/db";
import { entityVersions } from "@/api/db/schema";
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
  const fields = yield* Result.await(
    safeDb((tx) =>
      tx.query.fields.findMany({
        where: { entityVersionId: { in: versionIds } },
        columns: { entityVersionId: true, content: true },
      }),
    ),
  );

  const currentFile = findDocxFile(
    fields.filter((f) => f.entityVersionId === versionId),
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
        fields.filter((f) => f.entityVersionId === previousVersionId),
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
