import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";

import { compareDocxVersions } from "@stll/folio-core/server";

import type { ScopedDb } from "@/api/db/safe-db";
import { entityVersions, fields } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { countVersionDiffWords } from "@/api/handlers/entities/version-diff-word-counts";
import { createFileKey } from "@/api/handlers/files/utils";
import type { SafeId } from "@/api/lib/branded-types";
import { getS3 } from "@/api/lib/s3";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const VERSION_DIFF_STATS_SCOPES = ["text"] as const;

/**
 * Compute word-level diff stats between a version and its
 * predecessor, then store the result on the version row.
 *
 * Runs as fire-and-forget after finalization; failure is
 * captured but does not block the user.
 */
export const computeVersionDiffStats = async ({
  versionId,
  entityId,
  scopedDb,
  workspaceId,
  organizationId,
}: {
  versionId: SafeId<"entityVersion">;
  entityId: SafeId<"entity">;
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
}): Promise<void> => {
  // Get the new version's number
  const newVersion = await scopedDb((tx) =>
    tx.query.entityVersions.findFirst({
      where: {
        id: { eq: versionId },
        workspaceId: { eq: workspaceId },
        deletedAt: { isNull: true },
      },
      columns: { versionNumber: true },
    }),
  );

  if (!newVersion || newVersion.versionNumber <= 1) {
    return; // First version, nothing to diff
  }

  // Get the previous version
  const prevVersion = await scopedDb((tx) =>
    tx
      .select({ id: entityVersions.id })
      .from(entityVersions)
      .where(
        and(
          eq(entityVersions.entityId, entityId),
          eq(entityVersions.workspaceId, workspaceId),
          lt(entityVersions.versionNumber, newVersion.versionNumber),
          isNull(entityVersions.deletedAt),
        ),
      )
      .orderBy(desc(entityVersions.versionNumber))
      .limit(1),
  );

  const prevVersionId = prevVersion.at(0)?.id;
  if (!prevVersionId) {
    return;
  }

  // Fetch DOCX fields for both versions in one query that joins entity_versions
  // and requires deletedAt IS NULL, so a version tombstoned between the lookups
  // above and this read cannot feed withdrawn content into the diff stats.
  const fieldRows = await scopedDb((tx) =>
    // SAFETY: two versions' fields, each bounded by LIMITS.propertiesCount via the unique (propertyId, entityVersionId) index
    tx
      .select({
        entityVersionId: fields.entityVersionId,
        content: fields.content,
      })
      .from(fields)
      .innerJoin(entityVersions, eq(entityVersions.id, fields.entityVersionId))
      .where(
        and(
          inArray(fields.entityVersionId, [versionId, prevVersionId]),
          eq(fields.workspaceId, workspaceId),
          isNull(entityVersions.deletedAt),
        ),
      ),
  );

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

  const newFile = findDocxFile(
    fieldRows.filter((f) => f.entityVersionId === versionId),
  );
  const prevFile = findDocxFile(
    fieldRows.filter((f) => f.entityVersionId === prevVersionId),
  );

  if (!newFile || !prevFile) {
    return; // Non-DOCX versions
  }

  // Download both DOCX files
  const [newBuffer, prevBuffer] = await Promise.all([
    getS3()
      .file(
        createFileKey({
          organizationId,
          workspaceId,
          fileId: newFile.id,
          mimeType: DOCX_MIME_TYPE,
        }),
      )
      .arrayBuffer(),
    getS3()
      .file(
        createFileKey({
          organizationId,
          workspaceId,
          fileId: prevFile.id,
          mimeType: DOCX_MIME_TYPE,
        }),
      )
      .arrayBuffer(),
  ]);

  const diff = await compareDocxVersions(prevBuffer, newBuffer, {
    include: VERSION_DIFF_STATS_SCOPES,
  });
  const { wordsAdded, wordsRemoved } = countVersionDiffWords(diff);

  await scopedDb(async (tx) => {
    // audit: skip — derived diff stats cache, not a user-facing state
    // change; runs fire-and-forget after the audited version write
    await tx
      .update(entityVersions)
      .set({ diffWordsAdded: wordsAdded, diffWordsRemoved: wordsRemoved })
      .where(eq(entityVersions.id, versionId));
  });
};
