import type { RedisOptions } from "ioredis";

/**
 * ioredis does not infer a deployment's certificate policy from `rediss://`.
 * Verification stays on unless the deployment explicitly opts out for a
 * private endpoint whose certificate has no trusted chain.
 */
export const collabRedisConnectionOptions = (
  url: string,
  rejectUnauthorized = true,
): RedisOptions =>
  url.toLowerCase().startsWith("rediss://")
    ? { tls: { rejectUnauthorized } }
    : {};
