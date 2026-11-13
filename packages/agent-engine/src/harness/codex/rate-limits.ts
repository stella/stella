import { Result } from "better-result";
import * as v from "valibot";

import type { AppServerClient } from "./app-server-client";
import { mergeRateLimits } from "./errors";
import {
  type CodexRateLimits,
  GetAccountRateLimitsResponseSchema,
} from "./protocol";

/**
 * How long a read of the plan's limits may take. Codex asks its backend, so
 * the read is bounded well inside the request deadline, which would end the
 * process, and never holds up a probe or a failed turn for long.
 */
const RATE_LIMITS_READ_MS = 5000;

/**
 * What a read of the plan's limits found:
 * - `read`: the main allowance's windows.
 * - `none`: Codex answered and reports no main allowance, only others.
 * - `failed`: Codex refused (as for an API key account, which has no plan
 *   limits), exited, did not answer in time, or answered with an unexpected
 *   shape. Nothing is known about the plan's limits.
 */
export type CodexRateLimitsRead =
  | { type: "read"; limits: CodexRateLimits }
  | { type: "none" }
  | {
      type: "failed";
      reason: "rejected" | "closed" | "timed_out" | "malformed";
    };

/**
 * The main allowance as Codex reads it now: `codex` by limit id when Codex
 * keys them, else the single view.
 */
export const readRateLimits = async (
  client: AppServerClient,
  waitMs = RATE_LIMITS_READ_MS,
): Promise<CodexRateLimitsRead> => {
  const late = Promise.withResolvers<null>();
  const timer = setTimeout(() => {
    late.resolve(null);
  }, waitMs);
  // Sent without params: older servers take none.
  const read = await Promise.race([
    client.request("account/rateLimits/read", undefined),
    late.promise,
  ]);
  clearTimeout(timer);
  if (read === null) {
    return { type: "failed", reason: "timed_out" };
  }
  if (Result.isError(read)) {
    return { type: "failed", reason: read.error.reason };
  }
  const parsed = v.safeParse(GetAccountRateLimitsResponseSchema, read.value);
  if (!parsed.success) {
    return { type: "failed", reason: "malformed" };
  }
  const { rateLimits, rateLimitsByLimitId } = parsed.output;
  const limits = mergeRateLimits(
    null,
    rateLimitsByLimitId?.["codex"] ?? rateLimits,
  );
  return limits === null ? { type: "none" } : { type: "read", limits };
};
