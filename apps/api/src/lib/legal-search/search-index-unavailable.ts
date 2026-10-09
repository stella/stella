import { resolveHandlerError } from "@/api/lib/errors/handler-error-resolution";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/**
 * The refusal every public-law search answers with while the search index
 * cannot be reached (`isCorpusIndexUnreachable`). One code, one message and
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
 * Whether a failure is the search index being unavailable, read through the
 * transport wrappers (`Result.tryPromise`, `Result.gen`) a thrown refusal
 * arrives in.
 */
export const isSearchIndexUnavailable = (error: unknown): boolean =>
  resolveHandlerError(error)?.code === SEARCH_INDEX_UNAVAILABLE_CODE;
