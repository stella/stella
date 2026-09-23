import { Result } from "better-result";

import type {
  ApplyFolioAIEditsToBufferResult,
  FolioAIEditOperation,
} from "@stll/folio-core/server";

import { DocxAuthoringError } from "@/api/lib/docx-authoring/document";
import { applyFolioAIEditsToScannedDocx } from "@/api/lib/file-scan/document-parsers";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";

/** The author every edit applied by stella is attributed to. */
const STELLA_EDIT_AUTHOR = "Stella";

/**
 * Apply AI edit operations to a DOCX and return the edited bytes with the
 * applied and skipped breakdown. Edits are applied directly rather than as
 * tracked changes: the callers publish the result as a new version, and the
 * version history is the review trail.
 */
export const applyAiEditsToDocx = async (
  file: ScannedFile,
  operations: FolioAIEditOperation[],
): Promise<Result<ApplyFolioAIEditsToBufferResult, DocxAuthoringError>> =>
  await Result.tryPromise({
    try: async () =>
      await applyFolioAIEditsToScannedDocx(file, operations, {
        author: STELLA_EDIT_AUTHOR,
        mode: "direct",
      }),
    catch: (cause) =>
      new DocxAuthoringError({
        message: "The edits could not be applied to the DOCX.",
        cause,
      }),
  });
