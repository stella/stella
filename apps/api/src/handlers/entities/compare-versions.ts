import { Result } from "better-result";
import { diffArrays } from "diff";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { user } from "@/api/db/auth-schema";
import { desktopEditSessions, entityVersions, fields } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { diffParagraphs } from "@/api/handlers/docx/diff-paragraphs";
import { editWithTracking } from "@/api/handlers/docx/edit-with-tracking";
import { extractText } from "@/api/handlers/docx/extract-text";
import type {
  DocxEditSet,
  ExtractedDocument,
  ParagraphRewrite,
} from "@/api/handlers/docx/types";
import { convertToPdf } from "@/api/handlers/files/gotenberg";
import { createFileKey } from "@/api/handlers/files/utils";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Align paragraphs between two document versions using diff, then
 * produce rewrites only for paragraphs that actually changed.
 * Unlike naive index matching, this handles inserted/deleted paragraphs.
 */
const alignParagraphs = (
  base: ExtractedDocument,
  target: ExtractedDocument,
): ParagraphRewrite[] => {
  const baseTexts = base.paragraphs.map((p) => p.text);
  const targetTexts = target.paragraphs.map((p) => p.text);

  const diffs = diffArrays(baseTexts, targetTexts);
  const rewrites: ParagraphRewrite[] = [];
  let baseIdx = 0;

  for (const change of diffs) {
    if (!change.added && !change.removed) {
      // Equal — skip, no rewrite needed
      baseIdx += change.value.length;
    } else if (change.removed && !change.added) {
      // Deleted paragraphs — rewrite each to empty (tracked delete)
      for (const _ of change.value) {
        const para = base.paragraphs[baseIdx];
        if (para) {
          rewrites.push({ paragraphIndex: para.index, newText: "" });
        }
        baseIdx++;
      }
    } else if (change.added && !change.removed) {
      // Inserted paragraphs — rewrite the previous base paragraph
      // to include the new text (limitation: DOCX tracked changes
      // can't insert new paragraphs, only modify existing ones).
      // For now, append inserted text to the last base paragraph.
      const anchorIdx = Math.max(0, baseIdx - 1);
      const anchor = base.paragraphs[anchorIdx];
      if (anchor) {
        const insertedText = change.value.join("\n");
        const existing = rewrites.find(
          (r) => r.paragraphIndex === anchor.index,
        );
        if (existing) {
          existing.newText += `\n${insertedText}`;
        } else {
          rewrites.push({
            paragraphIndex: anchor.index,
            newText: `${anchor.text}\n${insertedText}`,
          });
        }
      }
    }
  }

  return rewrites;
};

const config = {
  permissions: { workspace: ["read"] },
  body: t.Object({
    baseVersionId: t.String(),
    targetVersionId: t.String(),
    entityId: t.String(),
  }),
} satisfies HandlerConfig;

export default createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    body: { baseVersionId, targetVersionId, entityId },
    session,
  }) {
    const organizationId = session.activeOrganizationId;

    // Fetch fields for both versions to get file content
    const [baseFieldsResult, targetFieldsResult] = await Promise.all([
      safeDb((tx) =>
        tx
          .select({ content: fields.content })
          .from(fields)
          .innerJoin(
            entityVersions,
            and(
              eq(fields.entityVersionId, entityVersions.id),
              eq(entityVersions.entityId, entityId),
            ),
          )
          .where(eq(fields.entityVersionId, baseVersionId)),
      ),
      safeDb((tx) =>
        tx
          .select({ content: fields.content })
          .from(fields)
          .innerJoin(
            entityVersions,
            and(
              eq(fields.entityVersionId, entityVersions.id),
              eq(entityVersions.entityId, entityId),
            ),
          )
          .where(eq(fields.entityVersionId, targetVersionId)),
      ),
    ]);

    const baseFields = yield* baseFieldsResult;
    const targetFields = yield* targetFieldsResult;

    // Find the DOCX file field in each version
    const findDocxContent = (
      fieldList: { content: FieldContent }[],
    ): Extract<FieldContent, { type: "file" }> | null => {
      for (const f of fieldList) {
        if (f.content.type === "file" && f.content.mimeType === DOCX_MIME) {
          return f.content;
        }
      }
      return null;
    };

    const baseFile = findDocxContent(baseFields);
    const targetFile = findDocxContent(targetFields);

    if (!baseFile || !targetFile) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Both versions must contain a DOCX file",
        }),
      );
    }

    // Download both DOCX files from S3
    const [baseBuffer, targetBuffer] = await Promise.all([
      getS3()
        .file(
          createFileKey({
            organizationId,
            workspaceId,
            fileId: baseFile.id,
            mimeType: DOCX_MIME,
          }),
        )
        .arrayBuffer(),
      getS3()
        .file(
          createFileKey({
            organizationId,
            workspaceId,
            fileId: targetFile.id,
            mimeType: DOCX_MIME,
          }),
        )
        .arrayBuffer(),
    ]);

    // Extract text from both versions
    const [baseExtracted, targetExtracted] = await Promise.all([
      extractText(new Uint8Array(baseBuffer)),
      extractText(new Uint8Array(targetBuffer)),
    ]);

    // Align paragraphs using diff (handles insertions/deletions
    // correctly instead of naive index matching which breaks when
    // paragraph counts differ between versions).
    const rewrites = alignParagraphs(baseExtracted, targetExtracted);

    // Look up the target version's author
    const targetAuthorResult = await safeDb((tx) =>
      tx
        .select({ userName: user.name })
        .from(desktopEditSessions)
        .innerJoin(user, eq(desktopEditSessions.createdBy, user.id))
        .where(
          and(
            eq(desktopEditSessions.finalizedVersionId, targetVersionId),
            eq(desktopEditSessions.workspaceId, workspaceId),
          ),
        )
        .limit(1),
    );
    const targetAuthorRows = yield* targetAuthorResult;
    const authorName = targetAuthorRows.at(0)?.userName ?? "Unknown";

    // Diff the paragraphs to get edit operations
    const diffResult = diffParagraphs(baseExtracted, rewrites);

    // Apply edits as tracked changes to the base DOCX
    const editSet: DocxEditSet = {
      edits: diffResult.edits,
      comments: [],
      author: {
        name: authorName,
        date: new Date().toISOString(),
      },
    };

    const editResult = await editWithTracking(Buffer.from(baseBuffer), editSet);

    if (Result.isError(editResult)) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: `Failed to apply tracked changes: ${editResult.error.message}`,
        }),
      );
    }

    // Convert the redline DOCX to PDF via Gotenberg
    const redlineBytes = new Uint8Array(editResult.value.buffer);
    const pdfResult = await convertToPdf(
      redlineBytes.buffer,
      "comparison.docx",
      DOCX_MIME,
    );

    if (Result.isError(pdfResult)) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to convert redline to PDF",
        }),
      );
    }

    // Return both the redline DOCX and PDF as base64
    const docxBase64 = Buffer.from(redlineBytes).toString("base64");
    const pdfBytes = new Uint8Array(pdfResult.value.buffer);
    const pdfBase64 = Buffer.from(pdfBytes).toString("base64");

    return Result.ok({
      pdfBase64,
      docxBase64,
      editsApplied: diffResult.edits.length,
      wordsAdded: diffResult.stats.wordsAdded,
      wordsRemoved: diffResult.stats.wordsRemoved,
    });
  },
);
