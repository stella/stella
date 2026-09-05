import { Result } from "better-result";

import { applyFolioAIEditsToBuffer } from "@stll/folio-core/server";
import type {
  ApplyFolioAIEditsToBufferResult,
  FolioAIEditOperation,
} from "@stll/folio-core/server";

import { DocxAuthoringError } from "@/api/lib/docx-authoring/document";

/** The author every edit applied by stella is attributed to. */
const STELLA_EDIT_AUTHOR = "Stella";

/**
 * Apply AI edit operations to a DOCX and return the edited bytes with the
 * applied and skipped breakdown. Edits are applied directly rather than as
 * tracked changes: the callers publish the result as a new version, and the
 * version history is the review trail.
 */
export const applyAiEditsToDocx = async (
  buffer: ArrayBuffer,
  operations: FolioAIEditOperation[],
): Promise<Result<ApplyFolioAIEditsToBufferResult, DocxAuthoringError>> =>
  await Result.tryPromise({
    try: async () =>
      await applyFolioAIEditsToBuffer(buffer, operations, {
        author: STELLA_EDIT_AUTHOR,
        mode: "direct",
      }),
    catch: (cause) =>
      new DocxAuthoringError({
        message: "The edits could not be applied to the DOCX.",
        cause,
      }),
  });
