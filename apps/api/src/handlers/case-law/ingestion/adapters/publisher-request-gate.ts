import { DEPLOYED_NODE_ENVS } from "@/api/env-base-schema";
import { createRedisClient } from "@/api/lib/redis-client";

const RESERVE_SLOT_SCRIPT = `
local clock = redis.call("TIME")
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local reserved = tonumber(redis.call("GET", KEYS[1])) or now
local slot = math.max(now, reserved)
local next = slot + tonumber(ARGV[1])
redis.call("PSETEX", KEYS[1], next - now + tonumber(ARGV[1]), tostring(next))
return slot - now
`;

export type PublisherGateClient = {
  send: (command: string, args: string[]) => Promise<unknown>;
};

type PublisherRequestGateConfig = {
  intervalMs: number;
  key: string;
  publisher: string;
};

export type PublisherRequestGateDependencies = {
  redis: () => PublisherGateClient;
  sleep: (durationMs: number, signal?: AbortSignal) => Promise<void>;
};

const abortableSleep = async (
  durationMs: number,
  signal?: AbortSignal,
): Promise<void> => {
  if (durationMs <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  await new Promise<void>((resolve, reject) => {
    const sleep = Bun.sleep(durationMs);
    const onAbort = () => {
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    void sleep.then(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

const defaultDependencies = (
  intervalMs: number,
): PublisherRequestGateDependencies => {
  let redis: PublisherGateClient | undefined;
  let localNextRequestAt = 0;
  const localRedis: PublisherGateClient = {
    send: async () => {
      const now = Date.now();
      const slot = Math.max(now, localNextRequestAt);
      localNextRequestAt = slot + intervalMs;
      return slot - now;
    },
  };
  return {
    redis: () => {
      if (!DEPLOYED_NODE_ENVS.has(process.env.NODE_ENV ?? "")) {
        return localRedis;
      }
      redis ??= createRedisClient({ enableOfflineQueue: false });
      return redis;
    },
    sleep: abortableSleep,
  };
};

export const createPublisherRequestSlot =
  (
    { intervalMs, key, publisher }: PublisherRequestGateConfig,
    dependencies = defaultDependencies(intervalMs),
  ): ((signal?: AbortSignal) => Promise<void>) =>
  async (signal) => {
    const rawWait = await dependencies
      .redis()
      .send("EVAL", [RESERVE_SLOT_SCRIPT, "1", key, String(intervalMs)]);
    const waitMs = Number(rawWait);
    if (!Number.isFinite(waitMs) || waitMs < 0) {
      throw new TypeError(
        `${publisher} publisher gate returned an invalid wait`,
      );
    }
    await dependencies.sleep(waitMs, signal);
  };
