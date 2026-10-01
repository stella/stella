import { and, inArray } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { fields } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import type { ReviewFile } from "@/api/lib/document-review/prepare-review-files";
import { readReferencePassageTexts } from "@/api/lib/document-review/reference-passages";
import type { DocumentReviewRunErrorCode } from "@/api/lib/document-review/run-contract";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

/** A pinned document, as recorded on the run. */
export type PinnedDocument = {
  workspaceId: SafeId<"workspace">;
  fileFieldId: SafeId<"field">;
  entityVersionId: SafeId<"entityVersion">;
  contentSha256: string;
};

type ResolveRunInputsResult =
  | {
      type: "resolved";
      files: ReviewFile[];
      passageTextById: ReadonlyMap<string, string>;
    }
  | { type: "failed"; errorCode: DocumentReviewRunErrorCode };

type ResolveRunInputsArgs = {
  pins: readonly PinnedDocument[];
  passageIds: readonly SafeId<"documentReviewReferencePassage">[];
};

/** Resolve the complete input set in one caller-scoped transaction. */
export const resolveDocumentReviewRunInputs = async (
  scopedDb: ScopedDb,
  { pins, passageIds }: ResolveRunInputsArgs,
): Promise<ResolveRunInputsResult> =>
  scopedDb(async (tx) => {
    const pinnedWorkspaceIds = [...new Set(pins.map((pin) => pin.workspaceId))];
    const rows = await tx
      .select({
        id: fields.id,
        workspaceId: fields.workspaceId,
        entityVersionId: fields.entityVersionId,
        content: fields.content,
      })
      .from(fields)
      .where(
        and(
          inArray(fields.workspaceId, pinnedWorkspaceIds),
          inArray(
            fields.id,
            pins.map((pin) => pin.fileFieldId),
          ),
          inArray(
            fields.entityVersionId,
            pins.map((pin) => pin.entityVersionId),
          ),
        ),
      );

    const contentByPin = new Map<string, FieldContent>();
    for (const row of rows) {
      contentByPin.set(
        `${row.workspaceId}:${row.id}:${row.entityVersionId}`,
        row.content,
      );
    }

    const files: ReviewFile[] = [];
    for (const pin of pins) {
      const content = contentByPin.get(
        `${pin.workspaceId}:${pin.fileFieldId}:${pin.entityVersionId}`,
      );
      if (content?.type !== "file") {
        return { type: "failed", errorCode: "pin_unresolved" };
      }
      if (content.sha256Hex !== pin.contentSha256) {
        return { type: "failed", errorCode: "pin_content_changed" };
      }
      if (content.mimeType !== DOCX_MIME_TYPE) {
        return { type: "failed", errorCode: "unsupported_format" };
      }
      files.push({
        workspaceId: pin.workspaceId,
        fileFieldId: pin.fileFieldId,
        fileId: content.id,
        mimeType: content.mimeType,
        sha256Hex: content.sha256Hex,
        encrypted: content.encrypted,
        pdfFileId: null,
      });
    }
    const passageTextById = await readReferencePassageTexts(tx, passageIds);
    if (passageIds.some((id) => !passageTextById.has(id))) {
      return { type: "failed", errorCode: "pin_unresolved" };
    }
    return { type: "resolved", files, passageTextById };
  });
