import { Temporal } from "@stll/time";

import type { SafeId } from "@/api/lib/branded-types";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { recordBudgetRejection } from "@/api/lib/rate-limit/budget-observability";
import type {
  RateLimitContext,
  RateLimitGenerator,
} from "@/api/lib/rate-limit/contracts";
import { dedicatedBudget } from "@/api/lib/rate-limit/dedicated-budgets";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import {
  createRedisRateLimit,
  createRedisRateLimitRequestKey,
} from "@/api/lib/rate-limit/redis-context";

const ORGANIZATION_CREATE_RATE_LIMIT_SCOPE = "organization-create";
const counterKey = (identity: string) =>
  `${ORGANIZATION_CREATE_RATE_LIMIT_SCOPE}:user:${identity}`;

const readUserId = async (request: Request) => {
  // Auth composes the generated capability registry, which imports this owner.
  const { resolveRateLimitSessionUserId } = await import("@/api/lib/auth");
  return await resolveRateLimitSessionUserId(request.headers);
};

const generator: RateLimitGenerator = async (request) =>
  counterKey((await readUserId(request)) ?? "unauthenticated");

const binding = createRedisRateLimit({
  counterKeyGenerator: generator,
  failurePolicy: "fail_open_local",
  scope: ORGANIZATION_CREATE_RATE_LIMIT_SCOPE,
});

export const consumeOrganizationCreateRateLimit = async ({
  userId,
  context = binding.context,
  requestId = Bun.randomUUIDv7(),
}: {
  userId: SafeId<"user">;
  context?: Pick<RateLimitContext, "increment" | "complete">;
  requestId?: string;
}) => {
  const key = createRedisRateLimitRequestKey({
    counterKey: counterKey(userId),
    requestId,
  });
  const counter = await context.increment(
    key,
    API_RATE_LIMITS.organizationCreate.duration,
  );
  await context.complete(key);
  const ok = counter.count <= API_RATE_LIMITS.organizationCreate.max;
  if (!ok) {
    recordBudgetRejection({
      name: "organizations.create.user",
      keyKind: "user",
      windowMs: API_RATE_LIMITS.organizationCreate.duration,
    });
  }
  return {
    ok,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil(
        (counter.nextReset.getTime() -
          Temporal.Now.instant().epochMilliseconds) /
          1000,
      ),
    ),
  };
};

export const organizationCreateBudget = dedicatedBudget(
  rateLimit({
    duration: API_RATE_LIMITS.organizationCreate.duration,
    max: API_RATE_LIMITS.organizationCreate.max,
    ...binding,
    skip: async (request) => (await readUserId(request)) === null,
    errorResponse: {
      code: "rate_limited",
      message:
        "Organization creation is limited to ten organizations per hour. Try again later.",
    },
    budget: { name: "organizations.create.user", keyKind: "user" },
  }),
);
