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
 * The main allowance's windows as Codex reads them now (`codex` by limit id
 * when Codex keys them, else the single view). `null` when the read fails,
 * is malformed or takes too long, as for an API key account, which has no
 * plan limits to read: the reset is then unknown.
 */
export const readRateLimits = async (
  client: AppServerClient,
): Promise<CodexRateLimits | null> => {
  const late = Promise.withResolvers<null>();
  const timer = setTimeout(() => {
    late.resolve(null);
  }, RATE_LIMITS_READ_MS);
  // Sent without params: older servers take none.
  const read = await Promise.race([
    client.request("account/rateLimits/read", undefined),
    late.promise,
  ]);
  clearTimeout(timer);
  const parsed =
    read !== null && Result.isOk(read)
      ? v.safeParse(GetAccountRateLimitsResponseSchema, read.value)
      : null;
  if (parsed === null || !parsed.success) {
    return null;
  }
  const { rateLimits, rateLimitsByLimitId } = parsed.output;
  return mergeRateLimits(null, rateLimitsByLimitId?.["codex"] ?? rateLimits);
};
