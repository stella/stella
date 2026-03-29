import { isTaggedError } from "better-result";

import { env } from "@/api/env";

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
    return error.constructor.name;
  }
  return "UnknownError";
};

export const logDevError = (error: unknown) => {
  if (env.isDev) {
    // eslint-disable-next-line no-console
    console.error(error);
  }
};
