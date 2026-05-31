import { type BunRedisRawClient, createBunRedisClient } from "bullmq";
import { type RedisOptions, RedisClient } from "bun";

import { env } from "@/api/env";
import { redisConnectionOptions } from "@/api/lib/redis-options";

type StellaRedisClient = RedisClient & {
  readonly url: string;
};

class ConfiguredRedisClient extends RedisClient {
  readonly url: string;

  constructor(url = env.REDIS_URL, overrides?: RedisOptions) {
    super(url, { ...redisConnectionOptions(url), ...overrides });
    this.url = url;
  }
}

export const createRedisClient = (
  overrides?: RedisOptions,
): StellaRedisClient => new ConfiguredRedisClient(env.REDIS_URL, overrides);

/**
 * Build a BullMQ connection wrapped around a freshly-constructed Bun
 * RedisClient. BullMQ's adapter assigns onconnect/onclose on the raw
 * client, so a wrapped connection must own its raw client — never share
 * one with code that uses the client directly.
 */
export const createBullMqConnection = (): ReturnType<
  typeof createBunRedisClient
> => {
  const raw = createRedisClient();
  // SAFETY: structural mismatch between BullMQ's BunRedisRawClient
  // (callback properties are optional functions) and Bun's RedisClient
  // (callback properties may be null). ConfiguredRedisClient also
  // exposes `url`, which BullMQ's Bun adapter uses when duplicating or
  // reconnecting raw clients, so TLS/options from redisConnectionOptions
  // are preserved by the subclass constructor.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return createBunRedisClient(raw as unknown as BunRedisRawClient);
};
