import type { Context, Generator, Options } from "elysia-rate-limit";

import { redis } from "@/api/lib/redis";

const KEY_PREFIX = "rl:";

const INCREMENT_LUA = await Bun.file(
  new URL("increment.lua", import.meta.url),
).text();

/**
 * Key generator that prefixes the client IP with a scope name,
 * so separate rateLimit instances get independent counters.
 */
export const scopedGenerator =
  (scope: string): Generator =>
  (request, server) => {
    const address = server?.requestIP(request)?.address;
    if (!address) {
      return scope;
    }
    return `${scope}:${address}`;
  };

export class RedisRateLimitContext implements Context {
  private durationMs = 60_000;

  init(options: Omit<Options, "context">) {
    this.durationMs = options.duration;
  }

  async increment(key: string) {
    const redisKey = KEY_PREFIX + key;
    const ttlSeconds = Math.ceil(this.durationMs / 1000);

    const [count, ttl] = (await redis.send("EVAL", [
      INCREMENT_LUA,
      "1",
      redisKey,
      String(ttlSeconds),
    ])) as [number, number];

    const nextReset = new Date(
      Date.now() + (ttl > 0 ? ttl * 1000 : this.durationMs),
    );

    return { count, nextReset };
  }

  async decrement(key: string) {
    await redis.decrby(KEY_PREFIX + key, 1);
  }

  async reset(key?: string) {
    if (key) {
      await redis.del(KEY_PREFIX + key);
    }
    // Without a key: all rate limit keys have a TTL from
    // increment(), so they expire automatically. A SCAN
    // over the full keyspace would be O(N) and isn't worth
    // the cost for a process-level reset.
  }

  kill() {
    // Redis client is a shared singleton; Bun closes
    // the socket on process exit, no cleanup needed.
  }
}
