// parser-output-unchanged: publisher scheduling only; response parsing is unchanged.
import { TaggedError } from "better-result";

import { Temporal } from "@stll/time";

import type * as RedisClientModule from "@/api/lib/redis-client";
import { withTimeout } from "@/api/lib/with-timeout";
import { isLocalDevOpen, isLocalTestRun } from "@/api/runtime-mode";

const PUBLISHER_GATE_COMMAND_TIMEOUT_MS = 5000;

const RESERVE_SLOT_SCRIPT = `
local clock = redis.call("TIME")
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local reserved = tonumber(redis.call("GET", KEYS[1])) or now
local cooldown = KEYS[2] and tonumber(redis.call("GET", KEYS[2])) or now
local slot = math.max(now, reserved, cooldown or now)
local next = slot + tonumber(ARGV[1])
redis.call("PSETEX", KEYS[1], next - now + tonumber(ARGV[1]), tostring(next))
return slot - now
`;

// Redis time makes cooldowns comparable across workers with different clocks.
const COOLDOWN_SCRIPT = `
local clock = redis.call("TIME")
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local untilAt = tonumber(redis.call("GET", KEYS[1])) or now
if ARGV[1] then
  untilAt = math.max(untilAt, now + tonumber(ARGV[1]))
  if untilAt > now then
    redis.call("PSETEX", KEYS[1], untilAt - now, tostring(untilAt))
  end
end
return ARGV[1] and untilAt or math.max(0, untilAt - now)
`;

// Deadline and expiry are evaluated on the same Redis TIME clock as reservations.
const READ_COOLDOWN_SCRIPT = `
local clock = redis.call("TIME")
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local untilAt = tonumber(redis.call("GET", KEYS[1])) or now
return untilAt > now and untilAt or 0
`;

export const publisherGateKeys = (slot: string) => {
  const key = `case-law:publisher-gate:${slot}`;
  // Preserve deployed gate keys so rolling workers share pacing. Redis hashes
  // an unbraced key in full; bracing that full key colocates the cooldown.
  // coordinationKey prefixes its hash tag, so it cannot preserve this format.
  return { key, cooldownKey: `{${key}}:cooldown` };
};

export type PublisherGateClient = {
  send: (command: string, args: string[]) => unknown;
};

type PublisherRequestGateConfig = {
  intervalMs: number;
  key: string;
  publisher: string;
  cooldown?: "shared";
};

export type PublisherRequestGateDependencies = {
  redis: () => PublisherGateClient | Promise<PublisherGateClient>;
  sleep: (durationMs: number, signal?: AbortSignal) => Promise<void>;
};

export const abortableSleep = async (
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

/** The deployed client, which the gate connects itself. */
type ConnectableGateClient = PublisherGateClient & {
  connect: () => Promise<unknown>;
};

/**
 * The deployed gate client, connected before it is handed out.
 *
 * The offline queue is off, so Bun rejects a command issued before the first
 * connection completes — and the first reservation after every process start
 * is exactly that command. Connect once; a failed connect is forgotten so the
 * next reservation retries it instead of inheriting a rejected promise
 * forever. `createClient` is the seam: the connect-then-send order is what a
 * test asserts, without a Redis.
 *
 * Every adapter runs its own loop, so the reservations that race this are
 * concurrent. Memoise the client's *promise*, not the client: awaiting the
 * construction before storing it lets a second caller start a second client
 * and install it over the first, while `connected` still tracks the first
 * one's handshake — so that caller awaits a connection its own client never
 * opened and its command is rejected, and each racing caller leaves another
 * connection behind. One promise is one client, and the connection it awaits
 * is that client's.
 */
export const connectedGateClient = (
  createClient: () => Promise<ConnectableGateClient>,
): (() => Promise<PublisherGateClient>) => {
  let clientPromise: Promise<ConnectableGateClient> | undefined;
  let connected: Promise<unknown> | undefined;
  return async () => {
    clientPromise ??= createClient().catch((error: unknown) => {
      clientPromise = undefined;
      throw error;
    });
    const redis = await clientPromise;
    connected ??= redis.connect().catch((error: unknown) => {
      connected = undefined;
      throw error;
    });
    await connected;
    return redis;
  };
};

let redisClientModulePromise: Promise<typeof RedisClientModule> | undefined;
const loadRedisClient = async () => {
  redisClientModulePromise ??= import("@/api/lib/redis-client");
  return await redisClientModulePromise;
};

const deployedGateClient = connectedGateClient(async () => {
  const { createRedisClient } = await loadRedisClient();
  return createRedisClient({ enableOfflineQueue: false });
});

const defaultDependencies = (
  intervalMs: number,
): PublisherRequestGateDependencies => {
  let localNextRequestAt = 0;
  let localCooldownUntil = 0;
  const localRedis: PublisherGateClient = {
    send: (_command, args) => {
      const now = Temporal.Now.instant().epochMilliseconds;
      if (args[0] === READ_COOLDOWN_SCRIPT) {
        return localCooldownUntil > now ? localCooldownUntil : 0;
      }
      if (args[0] === COOLDOWN_SCRIPT) {
        const duration = args.at(3);
        if (duration !== undefined) {
          localCooldownUntil = Math.max(
            localCooldownUntil,
            now + Number(duration),
          );
        }
        return duration === undefined
          ? Math.max(0, localCooldownUntil - now)
          : Math.max(now, localCooldownUntil);
      }
      const slot = Math.max(now, localNextRequestAt, localCooldownUntil);
      localNextRequestAt = slot + intervalMs;
      return slot - now;
    },
  };
  return {
    redis: async () => {
      // Process-local pacing holds for one process only; every other process
      // shares the Redis limiter.
      if (isLocalDevOpen()) {
        return localRedis;
      }
      return await deployedGateClient();
    },
    sleep: abortableSleep,
  };
};

/**
 * Whether a reservation is worth making at all.
 *
 * In a local test run every request is a stub, so a slot only buys wall clock —
 * and in local development the gate paces off the process clock, which suites
 * move (`setSystemTime`): one set backwards parks a stubbed request until the
 * reservation it already made comes round, which is weeks. What a reservation
 * does is asserted through this module's injected dependencies instead.
 * Every strict process reserves, whatever its NODE_ENV.
 */
export const publisherGateReserves = (): boolean =>
  !(isLocalDevOpen() && isLocalTestRun());

/** Redis answered a gate reservation with something other than a wait. */
class PublisherGateReplyError extends TaggedError("PublisherGateReplyError")<{
  message: string;
}> {}

export const createPublisherRequestSlot = (
  { intervalMs, key: slot, publisher, cooldown }: PublisherRequestGateConfig,
  dependencies = defaultDependencies(intervalMs),
) => {
  const { key, cooldownKey } = publisherGateKeys(slot);
  const commandWait = async (args: string[], signal?: AbortSignal) => {
    const redis = await dependencies.redis();
    const rawWait = await withTimeout(
      async () => await redis.send("EVAL", args),
      {
        label: `${publisher} publisher gate reservation`,
        signal,
        timeoutMs: PUBLISHER_GATE_COMMAND_TIMEOUT_MS,
      },
    );
    const waitMs = Number(rawWait);
    if (!Number.isFinite(waitMs) || waitMs < 0) {
      throw new PublisherGateReplyError({
        message: `${publisher} publisher gate returned an invalid wait`,
      });
    }
    return waitMs;
  };
  const reserve = async (signal?: AbortSignal) => {
    while (true) {
      const keys = cooldown === "shared" ? [key, cooldownKey] : [key];
      const waitMs = await commandWait(
        [RESERVE_SLOT_SCRIPT, String(keys.length), ...keys, String(intervalMs)],
        signal,
      );
      await dependencies.sleep(waitMs, signal);
      if (cooldown !== "shared") {
        return;
      }
      // Recheck reservations already sleeping when another worker backs off.
      // Re-reserving after the cooldown preserves spacing between those workers.
      const remaining = await commandWait(
        [COOLDOWN_SCRIPT, "1", cooldownKey],
        signal,
      );
      if (remaining === 0) {
        return;
      }
      await dependencies.sleep(remaining, signal);
    }
  };
  return Object.assign(reserve, {
    readCooldown: async (): Promise<number | null> => {
      const deadline = await commandWait([
        READ_COOLDOWN_SCRIPT,
        "1",
        cooldownKey,
      ]);
      return deadline === 0 ? null : deadline;
    },
    defer: async (durationMs: number, signal?: AbortSignal) =>
      await commandWait(
        [COOLDOWN_SCRIPT, "1", cooldownKey, String(durationMs)],
        signal,
      ),
  });
};
