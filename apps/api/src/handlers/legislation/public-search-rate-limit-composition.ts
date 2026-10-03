import { type AnyElysia, Elysia } from "elysia";

import { API_RATE_LIMITS } from "@/api/lib/limits";
import { publicCorpusConcurrencyLimit } from "@/api/lib/rate-limit/public-corpus-concurrency";
import {
  createPublicCorpusAddressRateLimitOptions,
  createPublicCorpusGlobalRateLimitOptions,
} from "@/api/lib/rate-limit/public-corpus-rate-limits";
import {
  type RateLimitOptions,
  rateLimit,
} from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";
import { resolvePublicCorpusPolicy } from "@/api/public-corpus-policy";

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
}: PublicStatuteSearchRateLimitCompositionOptions<Routes>) => {
  const concurrency = publicCorpusConcurrencyLimit();
  const searchGlobal = createPublicCorpusGlobalRateLimitOptions(
    "search",
    createRedisBinding,
  );
  return {
    shared: new Elysia()
      .use(
        rateLimit({
          duration: API_RATE_LIMITS.api.duration,
          max: API_RATE_LIMITS.api.max,
          ...createRedisBinding({
            failurePolicy: "fail_open_local",
            scope: "api",
          }),
          skip: async (request) => {
            const policy = resolvePublicCorpusPolicy(request);
            return (
              isPublicStatuteSearchRateLimitedRequest(request) ||
              policy?.class === "aggregate" ||
              policy?.class === "sitemap" ||
              skipShared(request)
            );
          },
        }),
      )
      .use(
        rateLimit(
          createPublicCorpusAddressRateLimitOptions(
            "aggregate",
            createRedisBinding,
          ),
        ),
      )
      .use(
        rateLimit(
          createPublicCorpusAddressRateLimitOptions(
            "sitemap",
            createRedisBinding,
          ),
        ),
      )
      .use(concurrency.shared)
      .use(
        rateLimit({
          ...searchGlobal,
          skip: (request) =>
            searchGlobal.skip(request) ||
            isPublicStatuteSearchRateLimitedRequest(request),
        }),
      )
      .use(
        rateLimit(
          createPublicCorpusGlobalRateLimitOptions(
            "aggregate",
            createRedisBinding,
          ),
        ),
      )
      .use(
        rateLimit(
          createPublicCorpusGlobalRateLimitOptions(
            "sitemap",
            createRedisBinding,
          ),
        ),
      )
      .as("scoped"),
    publicLegislation: new Elysia()
      .use(
        rateLimit(
          createPublicStatuteSearchRateLimitOptions(createRedisBinding),
        ),
      )
      .use(concurrency.statute)
      .use(
        rateLimit({
          ...searchGlobal,
          skip: (request) => !isPublicStatuteSearchRateLimitedRequest(request),
        }),
      )
      .use(routes),
  };
};
