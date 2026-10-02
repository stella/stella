import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { API_RATE_LIMITS } from "@/api/lib/limits";
import {
  type RateLimitOptions,
  scopedGenerator,
} from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

export const PUBLIC_STATUTE_SEARCH_PATH = "/law/statutes/search";
const VERSIONED_PUBLIC_STATUTE_SEARCH_PATH = `${STELLA_API_VERSION_PREFIX}${PUBLIC_STATUTE_SEARCH_PATH}`;
const PUBLIC_STATUTE_SEARCH_RATE_LIMIT_SCOPE = "public-statute-search";

export const isPublicStatuteSearchRateLimitedRequest = (
  request: Pick<Request, "method" | "url">,
): boolean => {
  // Elysia serves HEAD through the GET handler, so it performs the same search.
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }
  const { pathname } = new URL(request.url);
  // Elysia accepts a trailing slash for the same route; it carries the same budget.
  return (
    pathname === VERSIONED_PUBLIC_STATUTE_SEARCH_PATH ||
    pathname === `${VERSIONED_PUBLIC_STATUTE_SEARCH_PATH}/`
  );
};

export const PUBLIC_STATUTE_SEARCH_RATE_LIMIT_POLICY = {
  duration: API_RATE_LIMITS.publicStatuteSearch.duration,
  max: API_RATE_LIMITS.publicStatuteSearch.max,
  skip: (request: Request) => !isPublicStatuteSearchRateLimitedRequest(request),
} as const satisfies Omit<RateLimitOptions, "context" | "generator">;

export const publicStatuteSearchRateLimitKey = scopedGenerator(
  PUBLIC_STATUTE_SEARCH_RATE_LIMIT_SCOPE,
);

export const createPublicStatuteSearchRateLimitOptions = () =>
  ({
    ...PUBLIC_STATUTE_SEARCH_RATE_LIMIT_POLICY,
    ...createRedisRateLimit({
      counterKeyGenerator: publicStatuteSearchRateLimitKey,
      failurePolicy: "fail_open_local",
      scope: PUBLIC_STATUTE_SEARCH_RATE_LIMIT_SCOPE,
    }),
  }) as const satisfies RateLimitOptions;
