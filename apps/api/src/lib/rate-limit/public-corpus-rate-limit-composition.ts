import { Elysia } from "elysia";

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

type PublicCorpusRateLimitCompositionOptions = {
  skipShared?: RateLimitOptions["skip"];
  createRedisBinding?: typeof createRedisRateLimit;
  concurrency?: Parameters<typeof publicCorpusConcurrencyLimit>[0];
};

// Keep the shared-quota exclusion and the class budgets under one owner:
// installing only either half leaves public corpus work unbudgeted or charged
// twice. Every route the policy table classifies alike shares its buckets.
export const createPublicCorpusRateLimitComposition = ({
  skipShared = () => false,
  createRedisBinding = createRedisRateLimit,
  concurrency,
}: PublicCorpusRateLimitCompositionOptions = {}) =>
  new Elysia()
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
            policy?.class === "search" ||
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
    .use(
      rateLimit(
        createPublicCorpusAddressRateLimitOptions("search", createRedisBinding),
      ),
    )
    .use(publicCorpusConcurrencyLimit(concurrency))
    .use(
      rateLimit(
        createPublicCorpusGlobalRateLimitOptions("search", createRedisBinding),
      ),
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
        createPublicCorpusGlobalRateLimitOptions("sitemap", createRedisBinding),
      ),
    )
    .as("scoped");
