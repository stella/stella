import { env } from "@/api/env";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import type { RateLimitOptions } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

export const createMemoriesRateLimitOptions = () =>
  ({
    duration: API_RATE_LIMITS.api.duration,
    max: API_RATE_LIMITS.api.max,
    ...createRedisRateLimit({
      failurePolicy: "fail_open_local",
      scope: "api",
    }),
    skip: () => env.E2E_DISABLE_AUTH_RATE_LIMIT,
  }) as const satisfies RateLimitOptions;
