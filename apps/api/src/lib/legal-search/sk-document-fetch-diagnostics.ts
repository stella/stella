import { SK_DOCUMENT_FETCH_ERROR_KIND } from "@stll/legal-atlas/sk-document-fetch-diagnostics";

import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";

/** A byte-level PDF mismatch, independent of the rendered error message. */
export class SkDocumentNonPdfError extends AdapterFetchError {
  override name = "SkDocumentNonPdfError";
  readonly documentFetchFailureKind = SK_DOCUMENT_FETCH_ERROR_KIND.nonPdf;
}
