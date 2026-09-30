import type { RedisOptions } from "bun";

import {
  redisConnectionConfig,
  type RedisConnectionSettings,
} from "@stll/redis-config";

import { envBase } from "@/api/env-base";

type RedisConnectionOptions = {
  url: string;
  rejectUnauthorized?: boolean;
  settings?: RedisConnectionSettings;
};

export const redisConnectionOptions = ({
  url,
  rejectUnauthorized = envBase.REDIS_TLS_REJECT_UNAUTHORIZED,
  settings = envBase,
}: RedisConnectionOptions): RedisOptions => {
  const { tls } = redisConnectionConfig({
    url,
    settings,
    rejectUnauthorized,
  }).unwrap("Redis connection configuration must be valid.");
  return tls === undefined ? {} : { tls };
};
