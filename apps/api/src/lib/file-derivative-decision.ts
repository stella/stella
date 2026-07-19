import type { FieldContent } from "@/api/db/schema-validators";
import { shouldGeneratePdfDerivative } from "@/api/handlers/files/gotenberg";

type FileContent = Extract<FieldContent, { type: "file" }>;

/**
 * A PDF-derivative field is still awaiting generation only when its
 * `pdfDerivative` status has not reached a terminal value. Absent status is
 * treated as `pending` (the default state written on upload).
 */
export const isPendingPdfDerivative = (content: FileContent): boolean =>
  content.pdfDerivative?.status !== "not-required" &&
  content.pdfDerivative?.status !== "ready" &&
  content.pdfDerivative?.status !== "failed";

/**
 * What a PDF-derivative worker invocation should do given the current field
 * content:
 *
 * - `generate`: no derivative yet; convert, flip to `ready`, then extract.
 * - `extract-only`: the derivative is already `ready` (PDF preview is durable),
 *   so this is a retry whose previous run threw during text extraction /
 *   search indexing. Extraction is the terminal step of the job, so a retry
 *   reaching a `ready` field means extraction never completed. Re-run it;
 *   `processExtraction` is idempotent (upsert + index replace).
 * - `skip`: nothing to do (missing/foreign field, wrong content type,
 *   already `failed`/`not-required`, or the file is not convertible).
 */
export type PdfDerivativeAction =
  | { type: "skip" }
  | { type: "extract-only" }
  | { type: "generate"; content: FileContent };

export const decidePdfDerivativeAction = (
  content: FieldContent | undefined,
): PdfDerivativeAction => {
  if (!content || content.type !== "file") {
    return { type: "skip" };
  }

  // Derivative already produced: the ready flip set `pdfFileId` and made the
  // PDF preview available. Reaching here again is a retry after extraction /
  // indexing threw, so re-run extraction rather than silently succeeding.
  if (content.pdfFileId !== null && content.pdfDerivative?.status === "ready") {
    return { type: "extract-only" };
  }

  // A pdf already exists (foreign write) or the derivative reached a terminal
  // state (`failed`/`not-required`): do not regenerate.
  if (content.pdfFileId !== null || !isPendingPdfDerivative(content)) {
    return { type: "skip" };
  }

  if (
    !shouldGeneratePdfDerivative({
      encrypted: content.encrypted,
      mimeType: content.mimeType,
    })
  ) {
    return { type: "skip" };
  }

  return { type: "generate", content };
};
