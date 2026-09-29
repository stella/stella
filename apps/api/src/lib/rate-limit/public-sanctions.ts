import { Result } from "better-result";

import { Temporal } from "@stll/time";

import { resolveRateLimitClientAddress } from "@/api/lib/client-ip";
import type { RateLimitClientAddressOptions } from "@/api/lib/client-ip";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import type { RateLimitOptions } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";

const PUBLIC_SANCTIONS_RATE_LIMIT_SCOPE = "public-sanctions-search";
const ADDRESS_UNAVAILABLE = "PUBLIC_SANCTIONS_ADDRESS_UNAVAILABLE";
// This local decision is never a Redis key or a counter shared by requests.
const DENIED_ADDRESS_DECISION = "public-sanctions-address-denied";

type PublicSanctionsRateLimitOptions = {
  clientAddressOptions?: RateLimitClientAddressOptions["clientAddressOptions"];
};

export const createPublicSanctionsRateLimitOptions = ({
  clientAddressOptions,
}: PublicSanctionsRateLimitOptions = {}) =>
  ({
    duration: API_RATE_LIMITS.publicSanctionsSearch.duration,
    max: API_RATE_LIMITS.publicSanctionsSearch.max,
    ...createRedisRateLimit({
      failurePolicy: "fail_closed",
      scope: PUBLIC_SANCTIONS_RATE_LIMIT_SCOPE,
      counterKeyGenerator: (request, server) => {
        const address = resolveRateLimitClientAddress({
          request,
          server,
          ...(clientAddressOptions !== undefined && { clientAddressOptions }),
        });
        if (address === null) {
          return Promise.reject(
            new HandlerError({
              status: 429,
              code: ADDRESS_UNAVAILABLE,
              message: "Search is temporarily unavailable",
            }),
          );
        }
        return `${PUBLIC_SANCTIONS_RATE_LIMIT_SCOPE}:${address}`;
      },
    }),
  }) as const satisfies RateLimitOptions;

/** Address denial uses the limiter's early-error path without allocating a counter. */
export const createPublicSanctionsRateLimit = (
  options: RateLimitOptions = createPublicSanctionsRateLimitOptions(),
) =>
  rateLimit({
    ...options,
    errorResponse: { error: "Search is temporarily unavailable" },
    generator: async (request, server) => {
      const result = await Result.tryPromise({
        try: async () => await options.generator(request, server),
        catch: (error: unknown) => error,
      });
      if (result.isOk()) {
        return result.value;
      }
      if (
        HandlerError.is(result.error) &&
        result.error.code === ADDRESS_UNAVAILABLE
      ) {
        return DENIED_ADDRESS_DECISION;
      }
      throw result.error;
    },
    context: {
      init: (config) => options.context.init(config),
      kill: async () => await options.context.kill(),
      decrement: async (key) => {
        if (key === DENIED_ADDRESS_DECISION) {
          return;
        }
        await options.context.decrement(key);
      },
      increment: async (
        key,
        duration = options.duration,
        requestTime = Temporal.Now.instant().epochMilliseconds,
      ) => {
        if (key === DENIED_ADDRESS_DECISION) {
          return {
            count: options.max + 1,
            start: requestTime,
            nextReset: new Date(requestTime + duration),
          };
        }
        return await options.context.increment(key, duration, requestTime);
      },
    },
  });
