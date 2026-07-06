import { Result } from "better-result";
import { type BunRedisRawClient, createBunRedisClient } from "bullmq";
import { type RedisOptions, RedisClient, sleep } from "bun";

import { env } from "@/api/env";
import { connectionErrorFields } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
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

// On a Railway cold start the API container can win the race against its
// own Redis/Valkey service, so the very first connection attempt hits
// ECONNREFUSED/ENOTFOUND before Redis is accepting connections. BullMQ's
// RedisConnection calls `client.connect()` once (see `waitUntilReady` for
// the initial "wait" status) and rejects loudly through `worker.on("error")`
// on the first failure, with no retry of its own for that initial attempt.
// Retry a handful of times with a short capped backoff so that expected,
// self-recovering cold-start blips log at warn instead of paging as an
// error; once retries are exhausted the error is rethrown so BullMQ's own
// (unchanged) error handling still surfaces a persistent outage loudly.
const COLD_START_CONNECT_RETRY_DELAYS_MS = [200, 500, 1000, 2000];

export const connectWithColdStartRetries = async (
  connectOnce: () => Promise<void>,
): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    // catch returns the raw cause unchanged so a final, retries-exhausted
    // rethrow preserves the original error identity (code, syscall, class)
    // for whichever consumer's `worker.on("error")` handler logs it loudly.
    // oxlint-disable-next-line no-await-in-loop -- each retry must observe whether the connection came up before deciding to wait and try again
    const result = await Result.tryPromise({
      try: connectOnce,
      catch: (cause: unknown) => cause,
    });
    if (result.isOk()) {
      return;
    }
    const delayMs = COLD_START_CONNECT_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) {
      throw result.error;
    }
    logger.warn(
      "redis.cold_start_reconnect",
      connectionErrorFields(result.error),
    );
    // oxlint-disable-next-line no-await-in-loop -- retries are intentionally sequential backoff, not parallel work
    await sleep(delayMs);
  }
};

const withColdStartConnectRetries = (
  connection: ReturnType<typeof createBunRedisClient>,
): ReturnType<typeof createBunRedisClient> => {
  const connectOnce = connection.connect.bind(connection);
  connection.connect = () => connectWithColdStartRetries(connectOnce);
  return connection;
};

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
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- bridges BullMQ vs Bun RedisClient structural callback mismatch (see above)
  const connection = createBunRedisClient(raw as unknown as BunRedisRawClient, {
    // Railway's Redis proxy can trigger Bun's eager adapter read path before
    // BullMQ has completed its own readiness flow. Let BullMQ connect lazily.
    lazyConnect: true,
  });
  return withColdStartConnectRetries(connection);
};
