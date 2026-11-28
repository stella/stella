// parser-output-unchanged: AdapterFetchError extracted unchanged into @stll/case-law-ingestion-core; stop kinds and parsed records are identical.
import { panic, TaggedError } from "better-result";

import { TimeoutError } from "@stll/concurrency/with-timeout";
import {
  declareFailureClass,
  type FailureReason,
  FetchBoundaryError,
} from "@stll/errors";
import { isConnectionFailure } from "@stll/fetch";
import {
  INGESTION_STOP_KIND,
  type IngestionStopKind,
} from "@stll/legal-atlas/ingestion-cycle";

type AdapterFetchErrorOptions = {
  message: string;
  adapterKey: string;
  cursor: string | null;
  httpStatus?: number;
  retryAfter?: string;
  cause?: unknown;
  stopKind?: IngestionStopKind;
};

type IngestionFailure =
  | { type: "classified"; stopKind: IngestionStopKind }
  | { type: "publisher-response"; httpStatus: number }
  | { type: "connection" }
  | { type: "deadline" }
  | { type: "adapter" }
  | { type: "internal" };

const ingestionFailureStopKind = (
  failure: IngestionFailure,
): IngestionStopKind => {
  switch (failure.type) {
    case "classified":
      return failure.stopKind;
    case "publisher-response": {
      const { httpStatus } = failure;
      // A successful HTTP response rejected at the fetch boundary supplied no data.
      if (httpStatus >= 500 || httpStatus === 408 || httpStatus < 300) {
        return INGESTION_STOP_KIND.SOURCE_UNREACHABLE;
      }
      if (httpStatus === 401 || httpStatus === 403 || httpStatus === 429) {
        return INGESTION_STOP_KIND.PUBLISHER_REFUSAL;
      }
      return INGESTION_STOP_KIND.ADAPTER_ERROR;
    }
    case "connection":
      return INGESTION_STOP_KIND.SOURCE_UNREACHABLE;
    case "deadline":
      return INGESTION_STOP_KIND.DEADLINE;
    case "adapter":
      return INGESTION_STOP_KIND.ADAPTER_ERROR;
    case "internal":
      return INGESTION_STOP_KIND.INTERNAL_ERROR;
    default:
      failure satisfies never;
      return panic("Unhandled ingestion failure kind");
  }
};

const INGESTION_FAILURE_REASON = {
  source_unreachable: "upstream_unavailable",
  publisher_refusal: "publisher_refused",
  adapter_error: "tagged_failure",
  deadline: "timeout_unbounded",
  internal_error: "tagged_failure",
} as const satisfies Record<IngestionStopKind, FailureReason>;

/** Case-law adapter page-fetch failure; wrappers retain its operational kind. */
export class AdapterFetchError extends TaggedError(
  "AdapterFetchError",
)<AdapterFetchErrorOptions> {
  static {
    declareFailureClass(
      this,
      ({ stopKind }) => INGESTION_FAILURE_REASON[stopKind],
    );
  }

  override readonly stopKind: IngestionStopKind;

  constructor(options: AdapterFetchErrorOptions) {
    super(options);
    this.stopKind = options.stopKind ?? adapterFetchStopKind(options);
  }
}

const ingestionFailureOf = (
  cause: unknown,
  fallback: "adapter" | "internal",
): IngestionFailure => {
  const visited = new Set<unknown>();
  let fetchBoundary = false;
  let current = cause;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (current instanceof AdapterFetchError) {
      return { type: "classified", stopKind: current.stopKind };
    }
    if (current instanceof TimeoutError) {
      return { type: "internal" };
    }
    if (current.name === "TimeoutError") {
      return { type: "connection" };
    }
    if (current.name === "AbortError") {
      return { type: "deadline" };
    }
    if (fallback === "adapter") {
      if (current instanceof FetchBoundaryError) {
        if (current.status !== undefined) {
          return { type: "publisher-response", httpStatus: current.status };
        }
        fetchBoundary = true;
      }
      if (isConnectionFailure(current)) {
        return { type: "connection" };
      }
    }
    current = current.cause;
  }
  return { type: fetchBoundary ? "connection" : fallback };
};

/** Ingestion entry points classify operational exceptions without changing their identity. */
export const ingestionStopKindOf = (
  cause: unknown,
  origin: "adapter" | "internal" = "internal",
): IngestionStopKind =>
  ingestionFailureStopKind(ingestionFailureOf(cause, origin));

const adapterFetchStopKind = ({
  httpStatus,
  cause,
}: AdapterFetchErrorOptions): IngestionStopKind =>
  ingestionFailureStopKind(
    httpStatus === undefined
      ? ingestionFailureOf(cause, "adapter")
      : { type: "publisher-response", httpStatus },
  );
