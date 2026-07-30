import type { Options } from "elysia-rate-limit";

import { env } from "@/api/env";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

export const createMemoriesRateLimitOptions = () =>
  ({
    scoping: "scoped",
    duration: API_RATE_LIMITS.api.duration,
    max: API_RATE_LIMITS.api.max,
    ...createRedisRateLimit({
      failurePolicy: "fail_open_local",
      scope: "api",
    }),
    skip: () => env.E2E_DISABLE_AUTH_RATE_LIMIT,
  }) as const satisfies Partial<Options>;
