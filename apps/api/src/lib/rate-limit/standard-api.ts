import { env } from "@/api/env";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import type { RateLimitOptions } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

/**
 * The standard `/v1` API limiter, as a standalone plugin.
 *
 * Some routes are mounted at the root with their own `/v1/...` prefix rather
 * than inside the `/v1` group, because folding another `.use()` into that
 * group tips Elysia's inferred type past TypeScript's complexity threshold.
 * Those routes must still land in the same limiter scope, so callers cannot
 * bypass or double the budget by choosing one path over the other — hence one
 * shared factory instead of a copy per route.
 */
export const createStandardApiRateLimitOptions = () =>
  ({
    duration: API_RATE_LIMITS.api.duration,
    max: API_RATE_LIMITS.api.max,
    ...createRedisRateLimit({
      failurePolicy: "fail_open_local",
      scope: "api",
    }),
    skip: () => env.E2E_DISABLE_AUTH_RATE_LIMIT,
  }) as const satisfies RateLimitOptions;
