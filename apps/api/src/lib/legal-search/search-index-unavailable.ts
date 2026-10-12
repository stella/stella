import { ElysiaCustomStatusResponse, status } from "elysia";

import { resolveHandlerError } from "@/api/lib/errors/handler-error-resolution";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { isRecord } from "@/api/lib/type-guards";

/**
 * The refusal every public-law search answers with while the search index
 * cannot be reached or does not exist on the cluster
 * (`isCorpusIndexUnavailable`). One code, one message and
 * one hint for the REST routes and the MCP tools alike, so an agent and a
 * client branch on the same value and read the same next step: wait and
 * resend, because nothing in the request caused it.
 */
export const SEARCH_INDEX_UNAVAILABLE_CODE = "search_index_unavailable";

export const SEARCH_INDEX_UNAVAILABLE_MESSAGE =
  "The case-law and legislation search index is temporarily unavailable; retry shortly.";

export const SEARCH_INDEX_UNAVAILABLE_HINT =
  "Retry the same request shortly; changing the arguments will not help.";

/** The typed 503 a search answers when the index did not. */
export const searchIndexUnavailableError = (cause: unknown): HandlerError =>
  new HandlerError({
    status: 503,
    code: SEARCH_INDEX_UNAVAILABLE_CODE,
    message: SEARCH_INDEX_UNAVAILABLE_MESSAGE,
    hint: SEARCH_INDEX_UNAVAILABLE_HINT,
    retryable: true,
    cause,
  });

/**
 * Whether a failure is the search index being unavailable: a thrown refusal,
 * read through the transport wrappers (`Result.tryPromise`, `Result.gen`) it
 * arrives in, or the 503 envelope a search handler returns.
 */
export const isSearchIndexUnavailable = (error: unknown): boolean =>
  resolveHandlerError(error)?.code === SEARCH_INDEX_UNAVAILABLE_CODE ||
  (error instanceof ElysiaCustomStatusResponse &&
    isRecord(error.response) &&
    error.response["code"] === SEARCH_INDEX_UNAVAILABLE_CODE);

const SEARCH_INDEX_UNAVAILABLE_REFUSAL_SINK = failureSink({
  event: "legal_search.index_unavailable",
  expected: [],
});

/**
 * The 503 a search handler returns when no index can serve it. The body is
 * the one the route error mapping renders for `searchIndexUnavailableError`,
 * so REST clients and MCP tools read the same answer whether the refusal was
 * returned here or thrown by a scan. The cause is observed, since a returned
 * envelope never reaches the route's error capture.
 */
export const searchIndexUnavailableResponse = (cause: unknown) => {
  observeFailure(cause, { sink: SEARCH_INDEX_UNAVAILABLE_REFUSAL_SINK });
  return status(503, {
    code: SEARCH_INDEX_UNAVAILABLE_CODE,
    message: SEARCH_INDEX_UNAVAILABLE_MESSAGE,
    hint: SEARCH_INDEX_UNAVAILABLE_HINT,
    retryable: true,
  });
};
