import { type BunRedisRawClient, createBunRedisClient } from "bullmq";
import { type RedisOptions, RedisClient } from "bun";

import { env } from "@/api/env";
import { redisConnectionOptions } from "@/api/lib/redis-options";

export const createRedisClient = (overrides?: RedisOptions): RedisClient =>
  new RedisClient(env.REDIS_URL, { ...redisConnectionOptions(), ...overrides });

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
  // (onconnect/onclose typed as non-nullable functions) and Bun's
  // RedisClient (typed as nullable). At runtime Bun's client satisfies
  // the interface — BullMQ's adapter only assigns these callbacks, it
  // never invokes them as non-null functions, so the looser Bun typing
  // is sound.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return createBunRedisClient(raw as unknown as BunRedisRawClient);
};
