import { Panic, UnhandledException } from "better-result";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

/** How far a typed status is followed through transport wrappers. */
export const MAX_TRANSPORT_WRAPPER_DEPTH = 3;

/**
 * The wrappers a typed status is followed through: a throw inside
 * `Result.tryPromise` arrives as `UnhandledException`, one inside a
 * `Result.gen` body as `Panic`, both carrying the original as `cause`.
 */
export const TRANSPORT_WRAPPERS = [UnhandledException, Panic] as const;

const isTransportWrapper = (
  value: unknown,
): value is Panic | UnhandledException =>
  TRANSPORT_WRAPPERS.some((wrapper) => wrapper.is(value));

/**
 * The typed `HandlerError` an error carries, or null.
 *
 * A handler that throws a status rarely throws it here directly; it arrives
 * inside one of the transport wrappers above. Grading the wrapper spends the
 * status the thrower chose, so a refusal the caller could act on (an upstream
 * 503, a misconfiguration) is reported as a generic 500.
 *
 * Env-free, so the failure grader reads a status exactly as the request
 * pipeline answers it.
 */
export const resolveHandlerError = (error: unknown): HandlerError | null => {
  let candidate = error;
  for (let depth = 0; depth <= MAX_TRANSPORT_WRAPPER_DEPTH; depth++) {
    if (HandlerError.is(candidate)) {
      return candidate;
    }
    if (!isTransportWrapper(candidate)) {
      return null;
    }
    candidate = candidate.cause;
  }

  return null;
};
