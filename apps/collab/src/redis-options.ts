import type { RedisOptions } from "ioredis";

/**
 * ioredis does not infer a deployment's certificate policy from `rediss://`.
 * Verification stays on unless the deployment explicitly opts out for a
 * private endpoint whose certificate has no trusted chain.
 */
export const collabRedisConnectionOptions = (
  redisUrl: string,
  rejectUnauthorized = true,
): Omit<RedisOptions, "replyMapping"> => {
  const url = new URL(redisUrl);
  const options: Omit<RedisOptions, "replyMapping"> = {
    host: url.hostname.replace(/^\[|\]$/gu, ""),
    ...(url.port === "" ? {} : { port: Number(url.port) }),
    ...(url.username === ""
      ? {}
      : { username: decodeURIComponent(url.username) }),
    ...(url.password === ""
      ? {}
      : { password: decodeURIComponent(url.password) }),
    ...(url.pathname === "" || url.pathname === "/"
      ? {}
      : { db: Number(url.pathname.slice(1)) }),
    ...(url.searchParams.get("db") === null
      ? {}
      : { db: Number(url.searchParams.get("db")) }),
    ...(url.protocol === "rediss:" ? { tls: { rejectUnauthorized } } : {}),
  };

  return options;
};
