import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";

/** A byte-level PDF mismatch, independent of the rendered error message. */
export class SkDocumentNonPdfError extends AdapterFetchError {
  override name = "SkDocumentNonPdfError";
}

export const SK_DOCUMENT_FETCH_ERROR_KIND = {
  rateLimited: "rate-limited",
  publisherRefused: "publisher-refused",
  publisherServerError: "publisher-server-error",
  publisherStatus: "publisher-status",
  nonPdf: "non-pdf",
  timeout: "timeout",
  network: "network",
  aborted: "aborted",
  unknown: "unknown",
} as const;

export type SkDocumentFetchErrorKind =
  (typeof SK_DOCUMENT_FETCH_ERROR_KIND)[keyof typeof SK_DOCUMENT_FETCH_ERROR_KIND];

const httpStatusClass = (status: number) => {
  if (status >= 500) {
    return "5xx";
  }
  if (status >= 400) {
    return "4xx";
  }
  if (status >= 300) {
    return "3xx";
  }
  if (status >= 200) {
    return "2xx";
  }
  return "other";
};

const httpErrorKind = (status: number) => {
  if (status === 429) {
    return SK_DOCUMENT_FETCH_ERROR_KIND.rateLimited;
  }
  if (status === 401 || status === 403) {
    return SK_DOCUMENT_FETCH_ERROR_KIND.publisherRefused;
  }
  if (status >= 500) {
    return SK_DOCUMENT_FETCH_ERROR_KIND.publisherServerError;
  }
  return SK_DOCUMENT_FETCH_ERROR_KIND.publisherStatus;
};

const contentTypeClass = (mime: string | undefined) => {
  if (mime === undefined || mime === "") {
    return "missing";
  }
  if (mime === "application/pdf") {
    return "pdf";
  }
  if (mime === "application/octet-stream") {
    return "binary";
  }
  if (mime === "text/html") {
    return "html";
  }
  if (mime === "application/json" || mime.endsWith("+json")) {
    return "json";
  }
  return "other";
};

export const skDocumentResponseDiagnostics = (response: Response) => {
  const mime = response.headers
    .get("content-type")
    ?.split(";")
    .at(0)
    ?.trim()
    .toLowerCase();
  return {
    httpStatus: response.status,
    httpStatusClass: httpStatusClass(response.status),
    contentTypeClass: contentTypeClass(mime),
    failureKind: response.ok ? undefined : httpErrorKind(response.status),
  };
};

export const skDocumentErrorDiagnostics = (error: unknown) => {
  if (error instanceof SkDocumentNonPdfError) {
    return { kind: SK_DOCUMENT_FETCH_ERROR_KIND.nonPdf };
  }
  if (error instanceof AdapterFetchError && error.httpStatus !== undefined) {
    return {
      kind: httpErrorKind(error.httpStatus),
      httpStatus: error.httpStatus,
      httpStatusClass: httpStatusClass(error.httpStatus),
    };
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError") {
      return { kind: SK_DOCUMENT_FETCH_ERROR_KIND.timeout };
    }
    if (error.name === "AbortError") {
      return { kind: SK_DOCUMENT_FETCH_ERROR_KIND.aborted };
    }
    if ("code" in error) {
      if (error.code === "ETIMEDOUT") {
        return { kind: SK_DOCUMENT_FETCH_ERROR_KIND.timeout };
      }
      if (
        error.code === "ECONNRESET" ||
        error.code === "ECONNREFUSED" ||
        error.code === "ENOTFOUND" ||
        error.code === "EAI_AGAIN" ||
        error.code === "ConnectionClosed"
      ) {
        return { kind: SK_DOCUMENT_FETCH_ERROR_KIND.network };
      }
    }
  }
  return { kind: SK_DOCUMENT_FETCH_ERROR_KIND.unknown };
};

export type SkDocumentFetchErrorDiagnostic = ReturnType<
  typeof skDocumentErrorDiagnostics
>;
