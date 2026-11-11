import { Result } from "better-result";

import { classifyFailure } from "@stll/errors";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

const REQUEST_ABORTED_CODE = "request_aborted";
const MAX_REQUEST_ABORT_CAUSE_DEPTH = 8;

/**
 * The refusal for a request its caller cancelled: a client outcome, graded as
 * the client having gone, never a server fault.
 */
export const callerAbortRefusal = (cause: unknown) =>
  classifyFailure(
    new HandlerError({
      status: 400,
      code: REQUEST_ABORTED_CODE,
      message: "Request aborted",
      cause,
    }),
    "client_disconnected",
  );

/**
 * The refusal for a failure the request's own cancellation caused: its signal
 * aborted and the failure's cause chain holds that signal's reason, by
 * identity. Shared work such as a coalesced search rejects a caller that left
 * with exactly that reason. Any other abort (a timeout of the request's own,
 * a dependency's) keeps its grade, so null.
 */
export const requestAbortRefusal = (
  signal: AbortSignal,
  error: unknown,
): ReturnType<typeof callerAbortRefusal> | null => {
  if (!signal.aborted) {
    return null;
  }
  // The DOM types the reason as any; read it as unknown.
  const reason: unknown = signal.reason;
  const visited = new Set<unknown>();
  let current: unknown = error;
  for (
    let depth = 0;
    depth <= MAX_REQUEST_ABORT_CAUSE_DEPTH && !visited.has(current);
    depth++
  ) {
    if (current === reason) {
      return callerAbortRefusal(error);
    }
    if (!(current instanceof Error)) {
      return null;
    }
    visited.add(current);
    const wrapper = current;
    // A cause getter that throws ends the walk: no cancellation is readable.
    const cause = Result.try(() => wrapper.cause);
    if (Result.isError(cause)) {
      return null;
    }
    current = cause.value;
  }
  return null;
};
