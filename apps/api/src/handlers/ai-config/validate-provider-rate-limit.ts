import type { SafeId } from "@/api/lib/branded-types";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";

/**
 * Per-user budget for provider credential probes: 10 per minute, matching the
 * other endpoints whose work is an outbound third-party fetch. The route sits
 * under the general API budget (1000 req/min per IP), which is sized for page
 * loads and does not bound how much vendor traffic one account can drive.
 */
const VALIDATE_PROVIDER_RATE_LIMIT = { duration: 60_000, max: 10 } as const;

const VALIDATE_PROVIDER_RATE_LIMIT_SCOPE = "ai-config:validate-provider";

type RateLimitCounterContext = Pick<RedisRateLimitContext, "increment">;

let defaultContext: RedisRateLimitContext | undefined;

const getDefaultContext = (): RedisRateLimitContext => {
  defaultContext ??= new RedisRateLimitContext({
    failurePolicy: "fail_open_local",
  });
  return defaultContext;
};

export const consumeValidateProviderRateLimit = async ({
  context = getDefaultContext(),
  userId,
}: {
  context?: RateLimitCounterContext;
  userId: SafeId<"user">;
}): Promise<boolean> => {
  const counter = await context.increment(
    `${VALIDATE_PROVIDER_RATE_LIMIT_SCOPE}:${userId}`,
    VALIDATE_PROVIDER_RATE_LIMIT.duration,
  );
  return counter.count <= VALIDATE_PROVIDER_RATE_LIMIT.max;
};
