import { API_RATE_LIMITS } from "@/api/lib/limits";
import { scopedRateLimitKey } from "@/api/lib/rate-limit/rate-limit";
import type { RateLimitOptions } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

const PUBLIC_SANCTIONS_RATE_LIMIT_SCOPE = "public-sanctions-search";

export const createPublicSanctionsRateLimitOptions = () =>
  ({
    duration: API_RATE_LIMITS.publicSanctionsSearch.duration,
    max: API_RATE_LIMITS.publicSanctionsSearch.max,
    ...createRedisRateLimit({
      failurePolicy: "fail_closed",
      scope: PUBLIC_SANCTIONS_RATE_LIMIT_SCOPE,
      counterKeyGenerator: (request, server) =>
        scopedRateLimitKey({
          scope: PUBLIC_SANCTIONS_RATE_LIMIT_SCOPE,
          request,
          server,
        }),
    }),
  }) as const satisfies RateLimitOptions;
