import { type AnyElysia, Elysia } from "elysia";

import { API_RATE_LIMITS } from "@/api/lib/limits";
import {
  type RateLimitOptions,
  rateLimit,
} from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

import {
  createPublicStatuteSearchRateLimitOptions,
  isPublicStatuteSearchRateLimitedRequest,
} from "./public-search-rate-limit";

type PublicStatuteSearchRateLimitCompositionOptions<Routes extends AnyElysia> =
  {
    routes: Routes;
    skipShared?: RateLimitOptions["skip"];
    createRedisBinding?: typeof createRedisRateLimit;
  };

// Keep the shared exclusion and dedicated limiter under one owner: installing
// only either half leaves searches unbudgeted or charges searches twice.
export const createPublicStatuteSearchRateLimitComposition = <
  const Routes extends AnyElysia,
>({
  routes,
  skipShared = () => false,
  createRedisBinding = createRedisRateLimit,
}: PublicStatuteSearchRateLimitCompositionOptions<Routes>) => ({
  shared: rateLimit({
    duration: API_RATE_LIMITS.api.duration,
    max: API_RATE_LIMITS.api.max,
    ...createRedisBinding({ failurePolicy: "fail_open_local", scope: "api" }),
    skip: (request) =>
      isPublicStatuteSearchRateLimitedRequest(request) || skipShared(request),
  }),
  publicLegislation: new Elysia()
    .use(
      rateLimit(createPublicStatuteSearchRateLimitOptions(createRedisBinding)),
    )
    .use(routes),
});
