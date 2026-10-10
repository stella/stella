import { Temporal } from "@stll/time";

import type { SafeId } from "@/api/lib/branded-types";
import {
  resolveRateLimitClientAddress,
  normalizeRateLimitClientAddress,
} from "@/api/lib/client-ip";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import type {
  RateLimitContext,
  RateLimitGenerator,
} from "@/api/lib/rate-limit/rate-limit";
import {
  createRedisRateLimit,
  createRedisRateLimitRequestKey,
} from "@/api/lib/rate-limit/redis-context";

const SKILL_SOURCE_PATHS = new Set([
  "/skills/discover-url",
  "/skills/import-url",
  "/skills/import-urls",
]);

const SKILL_SOURCE_RATE_LIMIT_SCOPE = "skill-source";

const skillSourceRateLimitCounterKey = ({
  clientIp,
  userId,
}: {
  clientIp: string | null;
  userId?: SafeId<"user"> | undefined;
}): string => {
  if (userId) {
    return `${SKILL_SOURCE_RATE_LIMIT_SCOPE}:user:${userId}`;
  }
  return clientIp
    ? `${SKILL_SOURCE_RATE_LIMIT_SCOPE}:${normalizeRateLimitClientAddress(clientIp)}`
    : SKILL_SOURCE_RATE_LIMIT_SCOPE;
};

export const createSkillSourceRateLimitGenerator =
  (
    readUserId: (request: Request) => Promise<SafeId<"user"> | null> = async (
      request,
    ) => {
      // auth.ts composes the generated capability registry, which imports this owner.
      const { resolveRateLimitSessionUserId } = await import("@/api/lib/auth");
      return await resolveRateLimitSessionUserId(request.headers);
    },
  ): RateLimitGenerator =>
  async (request, server) => {
    const userId = await readUserId(request);
    return skillSourceRateLimitCounterKey({
      clientIp: resolveRateLimitClientAddress({ request, server }),
      ...(userId ? { userId } : {}),
    });
  };

export const skillSourceRateLimitBinding = createRedisRateLimit({
  counterKeyGenerator: createSkillSourceRateLimitGenerator(),
  failurePolicy: "fail_open_local",
  scope: SKILL_SOURCE_RATE_LIMIT_SCOPE,
});

export type SkillSourceRateLimitResult = {
  ok: boolean;
  retryAfterSeconds: number;
};

export const consumeSkillSourceRateLimit = async ({
  clientIp,
  userId,
  context = skillSourceRateLimitBinding.context,
  requestId = Bun.randomUUIDv7(),
}: {
  clientIp: string | null;
  userId?: SafeId<"user"> | undefined;
  context?: Pick<RateLimitContext, "increment" | "complete">;
  requestId?: string;
}): Promise<SkillSourceRateLimitResult> => {
  const counterKey = skillSourceRateLimitCounterKey({ clientIp, userId });
  const key = createRedisRateLimitRequestKey({ counterKey, requestId });
  const counter = await context.increment(
    key,
    API_RATE_LIMITS.skillSource.duration,
  );
  await context.complete(key);
  return {
    ok: counter.count <= API_RATE_LIMITS.skillSource.max,
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

export const isSkillSourceRateLimitedRequest = (
  request: Pick<Request, "method" | "url">,
): boolean => {
  if (request.method !== "POST") {
    return false;
  }
  const { pathname } = new URL(request.url);
  const versionlessPath = pathname.startsWith("/v1/")
    ? pathname.slice("/v1".length)
    : pathname;
  const normalizedPath = versionlessPath.endsWith("/")
    ? versionlessPath.slice(0, -1)
    : versionlessPath;
  return SKILL_SOURCE_PATHS.has(normalizedPath);
};
