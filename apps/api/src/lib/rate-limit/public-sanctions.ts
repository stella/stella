import { API_RATE_LIMITS } from "@/api/lib/limits";
import type { RateLimitOptions } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

export const createPublicSanctionsRateLimitOptions = () =>
  ({
    duration: API_RATE_LIMITS.publicSanctionsSearch.duration,
    max: API_RATE_LIMITS.publicSanctionsSearch.max,
    ...createRedisRateLimit({
      failurePolicy: "fail_closed",
      scope: "public-sanctions-search",
    }),
  }) as const satisfies RateLimitOptions;
