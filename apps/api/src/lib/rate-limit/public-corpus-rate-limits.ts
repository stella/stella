import { API_RATE_LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import { emitPublicCorpusAdmissionMetric } from "@/api/lib/observability/request-metrics";
import {
  getPublicCorpusClassPolicy,
  type PublicCorpusClass,
  resolvePublicCorpusPolicy,
} from "@/api/public-corpus-policy";

import { scopedRateLimitKey } from "./rate-limit";
import type { RateLimitOptions } from "./rate-limit";
import { createRedisRateLimit } from "./redis-context";

export const createPublicCorpusAddressRateLimitOptions = (
  routeClass: Exclude<PublicCorpusClass, "browse">,
  createRedisBinding = createRedisRateLimit,
) =>
  ({
    ...getPublicCorpusClassPolicy().classes[routeClass].address,
    ...createRedisBinding({
      failurePolicy: "fail_open_local",
      scope: `public-corpus-${routeClass}`,
    }),
    skip: (request: Request) =>
      resolvePublicCorpusPolicy(request)?.class !== routeClass,
  }) as const satisfies RateLimitOptions;

export const createPublicCorpusGlobalRateLimitOptions = (
  routeClass: Exclude<PublicCorpusClass, "browse">,
  createRedisBinding = createRedisRateLimit,
) => {
  const { duration, max, localMax } =
    getPublicCorpusClassPolicy().classes[routeClass].global;
  const scope = `public-corpus-global-${routeClass}`;
  return {
    duration,
    max,
    ...createRedisBinding({
      failurePolicy: "fail_open_local",
      scope,
      counterKeyGenerator: () => scope,
      localMax,
      onLocalFallback: () => {
        logger.warn("api.public_corpus.global_local_fallback", {
          class: routeClass,
          localMax,
        });
      },
    }),
    onLimit: () => {
      emitPublicCorpusAdmissionMetric({
        class: routeClass,
        outcome: "refused",
      });
      logger.warn("api.public_corpus.global_refused", {
        class: routeClass,
        max,
      });
    },
    skip: (request: Request) =>
      resolvePublicCorpusPolicy(request)?.class !== routeClass,
  } as const satisfies RateLimitOptions;
};

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
