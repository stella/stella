import { DEPLOYED_NODE_ENVS } from "@/api/env-base-schema";
import { withTimeout } from "@/api/lib/with-timeout";

const PUBLISHER_GATE_COMMAND_TIMEOUT_MS = 5000;

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
  send: (command: string, args: string[]) => unknown;
};

type PublisherRequestGateConfig = {
  intervalMs: number;
  key: string;
  publisher: string;
};

export type PublisherRequestGateDependencies = {
  redis: () => PublisherGateClient | Promise<PublisherGateClient>;
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
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Aborted", "AbortError");
  }
  if (signal === undefined) {
    await Bun.sleep(durationMs);
    return;
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([Bun.sleep(durationMs), aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
};

const defaultDependencies = (
  intervalMs: number,
): PublisherRequestGateDependencies => {
  let redis: PublisherGateClient | undefined;
  let localNextRequestAt = 0;
  const localRedis: PublisherGateClient = {
    send: () => {
      const now = Date.now();
      const slot = Math.max(now, localNextRequestAt);
      localNextRequestAt = slot + intervalMs;
      return slot - now;
    },
  };
  return {
    redis: async () => {
      if (!DEPLOYED_NODE_ENVS.has(process.env.NODE_ENV ?? "")) {
        return localRedis;
      }
      const { createRedisClient } = await import("@/api/lib/redis-client");
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
    const redis = await dependencies.redis();
    const rawWait = await withTimeout(
      async () =>
        await redis.send("EVAL", [
          RESERVE_SLOT_SCRIPT,
          "1",
          key,
          String(intervalMs),
        ]),
      {
        label: `${publisher} publisher gate reservation`,
        signal,
        timeoutMs: PUBLISHER_GATE_COMMAND_TIMEOUT_MS,
      },
    );
    const waitMs = Number(rawWait);
    if (!Number.isFinite(waitMs) || waitMs < 0) {
      throw new TypeError(
        `${publisher} publisher gate returned an invalid wait`,
      );
    }
    await dependencies.sleep(waitMs, signal);
  };
