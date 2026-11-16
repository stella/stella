import { TaggedError } from "better-result";
import * as v from "valibot";

import {
  CHAT_LOCAL_RUN_LIMIT_METADATA_KEY,
  chatLocalRunLimitSchema,
} from "@stll/api-contract/chat-run-target";

/**
 * A turn on the member's computer that ended on its harness's usage limit,
 * with when the limit resets. The message stays the failure's kind, so the
 * chat names the failure as it would without the time.
 */
class LocalRunLimitError extends TaggedError("LocalRunLimitError")<{
  message: string;
  resetsAt: string;
  cause: Error;
}> {}

/** When the limit resets, from a run error's metadata; nothing else counts. */
export const localRunLimitResetsAtOf = (metadata: unknown): string | null => {
  const parsed = v.safeParse(
    v.object({ [CHAT_LOCAL_RUN_LIMIT_METADATA_KEY]: chatLocalRunLimitSchema }),
    metadata,
  );
  return parsed.success
    ? parsed.output[CHAT_LOCAL_RUN_LIMIT_METADATA_KEY].resetsAt
    : null;
};

export const localRunLimitResetsAtFromThrown = (
  error: unknown,
): string | null => {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (LocalRunLimitError.is(current)) {
      return current.resetsAt;
    }
    seen.add(current);
    current = current.cause;
  }
  return null;
};

export const withLocalRunLimitResetsAt = (
  error: Error,
  resetsAt: string | null | undefined,
): Error =>
  resetsAt === null ||
  resetsAt === undefined ||
  localRunLimitResetsAtFromThrown(error) !== null
    ? error
    : new LocalRunLimitError({
        message: error.message,
        resetsAt,
        cause: error,
      });
