/**
 * The text lines a PDF states, read with the PDF library directly.
 *
 * Written for retention projections, so it shares nothing with the parsers'
 * PDF readers: those classify page furniture and assemble paragraphs, and a
 * check that reused that reading would inherit whatever text it drops. This
 * keeps every line the library extracts, in page order, which is what a
 * reader of the file sees.
 *
 * A word the typesetter broke at a line end ("rozpo-" then "znaniu") is left
 * as the file prints it. A parser may faithfully rejoin it or keep the
 * break, so the projection asks the oracle to read the source either way
 * (`hyphenatedLineBreaks`) rather than inventing the joined word itself.
 */
import { Result } from "better-result";

import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { readPdfTextLines } from "@/api/lib/files/pdf-text-lines";
import { PDF_WORKER_PARSE_ERROR_EXIT_CODE } from "@/api/lib/files/pdf-worker-protocol";

/**
 * The largest PDF a projection reads. Loading and extracting a PDF is
 * synchronous work of about 2 ms per KiB (the 383 KiB, 29-page ÚOHS fixture
 * takes 0.76 s on a loaded developer machine), so this bounds one check to a
 * few seconds. The largest court PDF among the recorded fixtures is 383 KiB,
 * a fifth of the budget; a larger file is stored unchecked and logged.
 */
export const PDF_PROJECTION_MAX_BYTES = 2 * 1024 * 1024;
const PDF_PROJECTION_TIMEOUT_MS = 30_000;

/**
 * The PDF's text as a projection: every line of every page. Bytes no PDF
 * opens from are an unreadable document and a file over the budget is left
 * unchecked, both outcomes the projection states rather than errors, since
 * the check is telemetry.
 */
export const projectPdfText = async (
  bytes: Uint8Array,
): Promise<RetentionProjection> => {
  if (bytes.byteLength > PDF_PROJECTION_MAX_BYTES) {
    return {
      type: "no-text",
      reason: RETENTION_TEXT_ABSENCE.OVER_CHECK_BUDGET,
    };
  }
  const read = await readPdfTextLines(bytes, PDF_PROJECTION_TIMEOUT_MS);
  return Result.isOk(read)
    ? {
        type: "source",
        source: { type: "paragraphs", paragraphs: read.value },
        options: { hyphenatedLineBreaks: true },
      }
    : {
        type: "unreadable",
        reason:
          read.error.exitCode === PDF_WORKER_PARSE_ERROR_EXIT_CODE
            ? RETENTION_PROJECTION_FAILURE.UNREADABLE_DOCUMENT
            : RETENTION_PROJECTION_FAILURE.WORKER_FAILED,
      };
};
