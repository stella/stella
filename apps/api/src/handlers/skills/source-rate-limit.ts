import type { Context, Generator } from "elysia-rate-limit";

import { resolveClientIp } from "@/api/lib/client-ip";
import { API_RATE_LIMITS } from "@/api/lib/limits";
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

const skillSourceRateLimitCounterKey = (clientIp: string | null): string =>
  clientIp
    ? `${SKILL_SOURCE_RATE_LIMIT_SCOPE}:${clientIp}`
    : SKILL_SOURCE_RATE_LIMIT_SCOPE;

const skillSourceCounterKeyGenerator: Generator = (request, server) =>
  skillSourceRateLimitCounterKey(resolveClientIp(request, server ?? null));

export const skillSourceRateLimitBinding = createRedisRateLimit({
  counterKeyGenerator: skillSourceCounterKeyGenerator,
  failurePolicy: "fail_open_local",
  scope: SKILL_SOURCE_RATE_LIMIT_SCOPE,
});

export type SkillSourceRateLimitResult = {
  ok: boolean;
  retryAfterSeconds: number;
};

export const consumeSkillSourceRateLimit = async ({
  clientIp,
  context = skillSourceRateLimitBinding.context,
  requestId = Bun.randomUUIDv7(),
}: {
  clientIp: string | null;
  context?: Pick<Context, "increment">;
  requestId?: string;
}): Promise<SkillSourceRateLimitResult> => {
  const counterKey = skillSourceRateLimitCounterKey(clientIp);
  const counter = await context.increment(
    createRedisRateLimitRequestKey({ counterKey, requestId }),
    API_RATE_LIMITS.skillSource.duration,
  );
  return {
    ok: counter.count <= API_RATE_LIMITS.skillSource.max,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((counter.nextReset.getTime() - Date.now()) / 1000),
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
