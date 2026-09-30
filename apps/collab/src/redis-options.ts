import type { RedisOptions } from "ioredis";

import {
  redisConnectionConfig,
  type RedisConnectionSettings,
} from "@stll/redis-config";

type CollabRedisConnectionOptions = {
  redisUrl: string;
  rejectUnauthorized?: boolean;
  settings?: RedisConnectionSettings;
};

export const collabRedisConnectionOptions = ({
  redisUrl,
  rejectUnauthorized = true,
  settings = {},
}: CollabRedisConnectionOptions): Omit<RedisOptions, "replyMapping"> => {
  const config = redisConnectionConfig({
    url: redisUrl,
    settings,
    rejectUnauthorized,
  });
  const url = new URL(config.url);
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
    ...(config.tls === undefined
      ? {}
      : {
          tls: {
            rejectUnauthorized: config.tls.rejectUnauthorized,
            ...(config.mode === "enforced"
              ? { ca: config.tls.ca, servername: config.tls.serverName }
              : {}),
          },
        }),
  };

  return options;
};
