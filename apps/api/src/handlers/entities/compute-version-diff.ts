import { diffArrays } from "diff";
import { and, desc, eq, lt } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { entityVersions } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { tokenize } from "@/api/handlers/docx/diff-paragraphs";
import { extractText } from "@/api/handlers/docx/extract-text";
import { createFileKey } from "@/api/handlers/files/utils";
import type { SafeId } from "@/api/lib/branded-types";
import { getS3 } from "@/api/lib/s3";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const WORD_RE = /[\p{L}\p{N}_]+/u;

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
        ),
      )
      .orderBy(desc(entityVersions.versionNumber))
      .limit(1),
  );

  const prevVersionId = prevVersion.at(0)?.id;
  if (!prevVersionId) {
    return;
  }

  // Get DOCX file fields for both versions
  const [newFields, prevFields] = await Promise.all([
    scopedDb((tx) =>
      tx.query.fields.findMany({
        where: { entityVersionId: { eq: versionId } },
        columns: { content: true },
      }),
    ),
    scopedDb((tx) =>
      tx.query.fields.findMany({
        where: { entityVersionId: { eq: prevVersionId } },
        columns: { content: true },
      }),
    ),
  ]);

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

  const newFile = findDocxFile(newFields);
  const prevFile = findDocxFile(prevFields);

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

  // Extract text from both
  const [newExtracted, prevExtracted] = await Promise.all([
    extractText(new Uint8Array(newBuffer)),
    extractText(new Uint8Array(prevBuffer)),
  ]);

  const newText = newExtracted.paragraphs.map((p) => p.text).join("\n");
  const prevText = prevExtracted.paragraphs.map((p) => p.text).join("\n");

  // Word-level diff using the same tokenizer as the redline engine
  const newTokens = tokenize(newText);
  const prevTokens = tokenize(prevText);
  const diffs = diffArrays(prevTokens, newTokens);

  let wordsAdded = 0;
  let wordsRemoved = 0;

  for (const change of diffs) {
    const wordCount = change.value.filter((w) => WORD_RE.test(w)).length;
    if (change.added) {
      wordsAdded += wordCount;
    } else if (change.removed) {
      wordsRemoved += wordCount;
    }
  }

  // Store on the version row
  await scopedDb((tx) =>
    tx
      .update(entityVersions)
      .set({ diffWordsAdded: wordsAdded, diffWordsRemoved: wordsRemoved })
      .where(eq(entityVersions.id, versionId)),
  );
};
