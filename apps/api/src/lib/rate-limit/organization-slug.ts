import { getAuth } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { dedicatedBudget } from "@/api/lib/rate-limit/dedicated-budgets";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import {
  createRedisRateLimit,
  RedisRateLimitContext,
} from "@/api/lib/rate-limit/redis-context";

export const ORGANIZATION_SLUG_RATE_LIMIT = {
  max: 5,
  windowMs: 60_000,
} as const;

let counter: RedisRateLimitContext | undefined;
const getCounter = () =>
  (counter ??= new RedisRateLimitContext({ failurePolicy: "fail_open_local" }));

/** Shared across transports and actors: changing credentials cannot reset the budget. */
export const consumeOrganizationSlugRateLimit = async (
  organizationId: SafeId<"organization">,
) => {
  const { count } = await getCounter().increment(
    `organization:slug:update:${organizationId}`,
    ORGANIZATION_SLUG_RATE_LIMIT.windowMs,
  );
  return count <= ORGANIZATION_SLUG_RATE_LIMIT.max;
};

export const organizationSlugBudget = dedicatedBudget(
  rateLimit({
    max: ORGANIZATION_SLUG_RATE_LIMIT.max,
    duration: ORGANIZATION_SLUG_RATE_LIMIT.windowMs,
    ...createRedisRateLimit({
      scope: "organization-slug",
      failurePolicy: "fail_open_local",
    }),
    generator: async (request) => {
      const caller = await getAuth().api.getSession({
        headers: request.headers,
      });
      return caller?.session.activeOrganizationId ?? "unauthenticated";
    },
  }),
);
