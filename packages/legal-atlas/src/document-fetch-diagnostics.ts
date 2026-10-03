// parser-output-unchanged: pure diagnostics classify fetch failures without changing parsed decisions.
export const DOCUMENT_FETCH_ERROR_KIND = {
  rateLimited: "rate-limited",
  publisherRefused: "publisher-refused",
  publisherServerError: "publisher-server-error",
  publisherStatus: "publisher-status",
  nonPdf: "non-pdf",
  timeout: "timeout",
  network: "network",
  aborted: "aborted",
  tls: "tls",
  bodyShape: "body-shape",
  unknown: "unknown",
} as const;

export type DocumentFetchErrorKind =
  (typeof DOCUMENT_FETCH_ERROR_KIND)[keyof typeof DOCUMENT_FETCH_ERROR_KIND];

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
    return DOCUMENT_FETCH_ERROR_KIND.rateLimited;
  }
  if (status === 401 || status === 403) {
    return DOCUMENT_FETCH_ERROR_KIND.publisherRefused;
  }
  if (status >= 500) {
    return DOCUMENT_FETCH_ERROR_KIND.publisherServerError;
  }
  return DOCUMENT_FETCH_ERROR_KIND.publisherStatus;
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

export const documentResponseDiagnostics = (response: Response) => {
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
    failureKind: response.ok
      ? ("none" as const)
      : httpErrorKind(response.status),
  };
};

export const documentErrorDiagnostics = (error: unknown) => {
  if (
    error instanceof Error &&
    "documentFetchFailureKind" in error &&
    (error.documentFetchFailureKind === DOCUMENT_FETCH_ERROR_KIND.nonPdf ||
      error.documentFetchFailureKind === DOCUMENT_FETCH_ERROR_KIND.bodyShape)
  ) {
    return { kind: error.documentFetchFailureKind };
  }
  if (
    error instanceof Error &&
    "httpStatus" in error &&
    typeof error.httpStatus === "number"
  ) {
    return {
      kind: httpErrorKind(error.httpStatus),
      httpStatus: error.httpStatus,
      httpStatusClass: httpStatusClass(error.httpStatus),
    };
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError") {
      return { kind: DOCUMENT_FETCH_ERROR_KIND.timeout };
    }
    if (error.name === "AbortError") {
      return { kind: DOCUMENT_FETCH_ERROR_KIND.aborted };
    }
    if ("code" in error) {
      if (
        typeof error.code === "string" &&
        (error.code.startsWith("ERR_TLS_") ||
          error.code.startsWith("CERT_") ||
          error.code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
          error.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
          error.code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY")
      ) {
        return { kind: DOCUMENT_FETCH_ERROR_KIND.tls };
      }
      if (
        error.code === "ETIMEDOUT" ||
        error.code === "UND_ERR_CONNECT_TIMEOUT" ||
        error.code === "UND_ERR_HEADERS_TIMEOUT" ||
        error.code === "UND_ERR_BODY_TIMEOUT"
      ) {
        return { kind: DOCUMENT_FETCH_ERROR_KIND.timeout };
      }
      if (
        error.code === "ECONNRESET" ||
        error.code === "ECONNREFUSED" ||
        error.code === "ENOTFOUND" ||
        error.code === "EAI_AGAIN" ||
        error.code === "ConnectionClosed"
      ) {
        return { kind: DOCUMENT_FETCH_ERROR_KIND.network };
      }
    }
  }
  return { kind: DOCUMENT_FETCH_ERROR_KIND.unknown };
};

export type DocumentFetchErrorDiagnostic = ReturnType<
  typeof documentErrorDiagnostics
>;

export const DOCUMENT_FETCH_OUTCOME = {
  ok: "ok",
  http4xx: "http_4xx",
  http5xx: "http_5xx",
  rateLimited: "rate_limited",
  timeout: "timeout",
  connection: "connection",
  tls: "tls",
  bodyShape: "body_shape",
  publisherRefusal: "publisher_refusal",
  unknown: "unknown",
} as const;

export type DocumentFetchOutcome =
  (typeof DOCUMENT_FETCH_OUTCOME)[keyof typeof DOCUMENT_FETCH_OUTCOME];

export const DOCUMENT_FETCH_EVENT = {
  window: "case_law.documents.window",
  fetchOutcome: "case_law.documents.fetch_outcome",
  observerFailed: "case_law.documents.telemetry_observer_failed",
} as const;

export const DOCUMENT_OBSERVER_TIMEOUT_MS = 2000;

export type DocumentTelemetryObserverFailure = {
  readonly event: typeof DOCUMENT_FETCH_EVENT.observerFailed;
  readonly source: string;
  readonly observer: "callback" | "builtin";
  readonly reason: "exception" | "timeout" | "circuit_open";
};

export type DocumentFetchObservation = {
  readonly event: typeof DOCUMENT_FETCH_EVENT.fetchOutcome;
  readonly source: string;
  readonly outcome: DocumentFetchOutcome;
  readonly http_status?: number;
};

export type DocumentWindowObservation = {
  readonly event: typeof DOCUMENT_FETCH_EVENT.window;
  readonly aggregation: "page" | "five_minute";
  readonly source: string;
  /** Outstanding work observed in this window; not a corpus-wide census. */
  readonly backlog: number;
  readonly attempted: number;
  readonly filled: number;
  readonly failed: number;
  readonly window_seconds: number;
};

export type DocumentStageObservation =
  | DocumentFetchObservation
  | DocumentWindowObservation;
export type DocumentStageObserver = (
  observation: DocumentStageObservation,
) => void | Promise<void>;
export type DocumentFetchStage = "listing" | "document";
export type DocumentStage = "inline" | "deferred";

const OUTCOME_BY_ERROR_KIND = {
  "rate-limited": DOCUMENT_FETCH_OUTCOME.rateLimited,
  "publisher-refused": DOCUMENT_FETCH_OUTCOME.publisherRefusal,
  "publisher-server-error": DOCUMENT_FETCH_OUTCOME.http5xx,
  "publisher-status": DOCUMENT_FETCH_OUTCOME.http4xx,
  "non-pdf": DOCUMENT_FETCH_OUTCOME.bodyShape,
  "body-shape": DOCUMENT_FETCH_OUTCOME.bodyShape,
  timeout: DOCUMENT_FETCH_OUTCOME.timeout,
  network: DOCUMENT_FETCH_OUTCOME.connection,
  tls: DOCUMENT_FETCH_OUTCOME.tls,
  aborted: DOCUMENT_FETCH_OUTCOME.unknown,
  unknown: DOCUMENT_FETCH_OUTCOME.unknown,
} as const satisfies Record<DocumentFetchErrorKind, DocumentFetchOutcome>;

/** Structured causes only: never classify or emit publisher content or messages. */
export const documentFetchErrorOutcome = (
  source: string,
  error: unknown,
): DocumentFetchObservation => {
  let cause = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && !seen.has(cause); depth++) {
    seen.add(cause);
    const diagnostic = documentErrorDiagnostics(cause);
    if (diagnostic.kind !== DOCUMENT_FETCH_ERROR_KIND.unknown) {
      return {
        event: DOCUMENT_FETCH_EVENT.fetchOutcome,
        source,
        outcome:
          diagnostic.kind === DOCUMENT_FETCH_ERROR_KIND.publisherStatus &&
          (!("httpStatus" in diagnostic) ||
            diagnostic.httpStatus < 400 ||
            diagnostic.httpStatus >= 500)
            ? DOCUMENT_FETCH_OUTCOME.unknown
            : OUTCOME_BY_ERROR_KIND[diagnostic.kind],
        ...("httpStatus" in diagnostic &&
        typeof diagnostic.httpStatus === "number"
          ? { http_status: diagnostic.httpStatus }
          : {}),
      };
    }
    if (!(cause instanceof Error) || cause.cause === undefined) {
      break;
    }
    cause = cause.cause;
  }
  return {
    event: DOCUMENT_FETCH_EVENT.fetchOutcome,
    source,
    outcome: DOCUMENT_FETCH_OUTCOME.unknown,
  };
};

export const documentFetchResponseOutcome = (
  source: string,
  response: Response,
): DocumentFetchObservation => {
  const diagnostic = documentResponseDiagnostics(response);
  let outcome: DocumentFetchOutcome = DOCUMENT_FETCH_OUTCOME.unknown;
  if (diagnostic.failureKind === "none") {
    outcome = DOCUMENT_FETCH_OUTCOME.ok;
  } else if (response.status >= 400) {
    outcome = OUTCOME_BY_ERROR_KIND[diagnostic.failureKind];
  }
  return {
    event: DOCUMENT_FETCH_EVENT.fetchOutcome,
    source,
    outcome,
    http_status: response.status,
  };
};
