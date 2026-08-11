/**
 * The structural error identifier, split out from `errors/utils`.
 *
 * `errors/utils` initializes the dev error logger at import time and reads
 * `envBase` to do it, so importing it validates the whole API environment.
 * Modules that only need to name an error — the runner's env-free sweep
 * modules among them — import this instead and stay independent of that.
 * `errors/utils` re-exports these, so existing callers are unaffected.
 */

import { isTaggedError } from "better-result";

export const errorClassName = (error: Error): string => {
  try {
    const constructorValue: unknown = Reflect.get(error, "constructor");
    if (typeof constructorValue !== "function") {
      return "Error";
    }
    const name: unknown = Reflect.get(constructorValue, "name");
    if (typeof name === "string" && name) {
      return name;
    }
  } catch {
    return "Error";
  }
  return "Error";
};

/**
 * Extract a safe, structural error identifier for observability.
 *
 * Returns the TaggedError `_tag`, the Error constructor name, or
 * "UnknownError". Never includes messages, causes, or stack
 * traces; those may contain privileged document content, file
 * names, or client data that must not reach analytics dashboards.
 */
export const errorTag = (error: unknown): string => {
  if (isTaggedError(error)) {
    return error._tag;
  }
  if (error instanceof Error) {
    return errorClassName(error);
  }
  return "UnknownError";
};
