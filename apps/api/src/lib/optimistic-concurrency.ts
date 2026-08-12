import { t } from "elysia";

import { API_VERSION_CONFLICT_ERROR_CODE } from "@stll/api-contract";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

/**
 * Machine-readable code on the 409 a stale editor round-trip earns. Clients
 * branch on this (refetch the detail, reseed their token, offer a reload)
 * instead of pattern-matching the prose message. Defined in the shared
 * contract so emitter and consumer cannot drift.
 */
export const VERSION_CONFLICT_ERROR_CODE = API_VERSION_CONFLICT_ERROR_CODE;

/**
 * The `updatedAt` an editor read with the record it is about to write back.
 * Send the value verbatim as the server rendered it; the comparison is on the
 * millisecond instant, not on the string.
 */
export const expectedUpdatedAtSchema = t.String({ format: "date-time" });

type AssertUnchangedSinceArgs = {
  /** `updatedAt` of the row, read under the same lock as the write. */
  storedUpdatedAt: Date;
  /**
   * What the caller expects that `updatedAt` to be. `undefined` opts out of
   * the check entirely, for endpoints whose non-editor callers (MCP, CLI)
   * have no token to send.
   */
  expectedUpdatedAt: string | undefined;
  /** Capitalized resource noun for the message, e.g. `"Playbook"`. */
  resource: string;
};

/**
 * Optimistic-concurrency guard for editor round-trips: returns the 409 to
 * fail with when the row moved under the caller, `null` when the write may
 * proceed. Call it inside the transaction that performs the write, after the
 * row is locked — otherwise the check races the very update it guards.
 */
export const assertUnchangedSince = ({
  storedUpdatedAt,
  expectedUpdatedAt,
  resource,
}: AssertUnchangedSinceArgs): HandlerError<409> | null => {
  if (
    expectedUpdatedAt === undefined ||
    storedUpdatedAt.getTime() === new Date(expectedUpdatedAt).getTime()
  ) {
    return null;
  }
  return new HandlerError({
    code: VERSION_CONFLICT_ERROR_CODE,
    status: 409,
    message: `${resource} changed while it was being edited; reload and try again`,
  });
};
