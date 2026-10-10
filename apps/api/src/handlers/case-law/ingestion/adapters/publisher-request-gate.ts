// parser-output-unchanged: request scheduling and scoped fixture dependencies only; parsed response output is unchanged.
// parser-output-unchanged: checked coordination clients and bounded immediate gate checks; response parsing and stored output are unchanged.
// parser-output-unchanged: isolate default test gate state through a lightweight runner signal; production requests and parsed output are unchanged.
import { panic, Result, TaggedError } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import { Temporal } from "@stll/time";

import type * as RedisClientModule from "@/api/lib/admission-redis";
import { withTimeout } from "@/api/lib/with-timeout";
import { isLocalDevOpen, isLocalTestRun } from "@/api/runtime-mode";

import {
  advancePublisherGateFixtureGeneration,
  publisherGateFixtureGeneration,
} from "./publisher-gate-fixture-state";

const PUBLISHER_GATE_COMMAND_TIMEOUT_MS = 5000;

const TRY_RESERVE_SLOT_SCRIPT = `
local clock = redis.call("TIME")
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local reserved = tonumber(redis.call("GET", KEYS[1])) or now
local cooldown = KEYS[2] and tonumber(redis.call("GET", KEYS[2])) or now
if math.max(reserved, cooldown) > now then return 0 end
local interval = tonumber(ARGV[1])
redis.call("PSETEX", KEYS[1], interval * 2, tostring(now + interval))
return 1
`;

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

const fixtureDependencies =
  new AsyncLocalStorage<PublisherRequestGateDependencies>();

/** Invalidate default local gate state without replacing captured singleton slots. */
export const resetPublisherGateFixtures = () => {
  if (!isLocalTestRun()) {
    panic("Publisher gate fixtures require a local test run");
  }
  advancePublisherGateFixtureGeneration();
};

/** Exercise the actual shared and run-scoped gates without opening Redis. */
export const withPublisherGateFixture = async <T>(
  dependencies: PublisherRequestGateDependencies,
  operation: () => Promise<T>,
): Promise<T> => {
  if (!isLocalTestRun()) {
    panic("Publisher gate fixtures require a local test run");
  }
  return await fixtureDependencies.run(dependencies, operation);
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

let redisClientModulePromise: Promise<typeof RedisClientModule> | undefined;
const loadRedisClient = async () => {
  redisClientModulePromise ??= import("@/api/lib/admission-redis");
  return await redisClientModulePromise;
};

let deployedStore:
  | ReturnType<typeof RedisClientModule.createAdmissionRedis>
  | undefined;
const deployedGateClient = async () => {
  const { createAdmissionRedis } = await loadRedisClient();
  deployedStore ??= createAdmissionRedis();
  const connection = await deployedStore.ready();
  if (connection.status === "error") {
    return await Promise.reject(connection.error);
  }
  return {
    send: async (command: string, args: string[]) => {
      const reply = await connection.value.send(command, args);
      if (reply.status === "error") {
        return await Promise.reject(reply.error);
      }
      return reply.value;
    },
  };
};

const defaultDependencies = (
  intervalMs: number,
  cooldown: PublisherRequestGateConfig["cooldown"],
): PublisherRequestGateDependencies => {
  let generation = publisherGateFixtureGeneration();
  let localNextRequestAt = 0;
  let localCooldownUntil = 0;
  const localRedis: PublisherGateClient = {
    send: (_command, args) => {
      if (generation !== publisherGateFixtureGeneration()) {
        generation = publisherGateFixtureGeneration();
        localNextRequestAt = 0;
        localCooldownUntil = 0;
      }
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
      const cooldownUntil = cooldown === "shared" ? localCooldownUntil : 0;
      if (args[0] === TRY_RESERVE_SLOT_SCRIPT) {
        if (Math.max(localNextRequestAt, cooldownUntil) > now) {
          return 0;
        }
        localNextRequestAt = now + intervalMs;
        return 1;
      }
      const slot = Math.max(now, localNextRequestAt, cooldownUntil);
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
  fixtureDependencies.getStore() !== undefined ||
  !(isLocalDevOpen() && isLocalTestRun());

/** Redis answered a gate reservation with something other than a wait. */
class PublisherGateReplyError extends TaggedError("PublisherGateReplyError")<{
  message: string;
}> {}

export class PublisherPacingStopped extends TaggedError(
  "PublisherPacingStopped",
)<{
  message: string;
  status: "pacing-deferred" | "pacing-unavailable";
  cause?: unknown;
}> {}

export const createPublisherRequestSlot = (
  { intervalMs, key: slot, publisher, cooldown }: PublisherRequestGateConfig,
  dependencies = defaultDependencies(intervalMs, cooldown),
) => {
  const { key, cooldownKey } = publisherGateKeys(slot);
  type CommandWaitOptions = {
    signal?: AbortSignal | undefined;
    replies?: readonly number[];
    mode?: "immediate";
  };
  const commandResult = async (
    args: string[],
    { signal, replies, mode }: CommandWaitOptions,
  ) => {
    const response = await Result.tryPromise({
      try: async () =>
        await withTimeout(
          async () => {
            const redis = await (
              fixtureDependencies.getStore() ?? dependencies
            ).redis();
            return await redis.send("EVAL", args);
          },
          {
            label: `${publisher} publisher gate reservation`,
            signal,
            timeoutMs: PUBLISHER_GATE_COMMAND_TIMEOUT_MS,
          },
        ),
      catch: (error) => error,
    });
    if (Result.isError(response)) {
      return Result.err(
        mode === "immediate"
          ? new PublisherPacingStopped({
              message: "Publisher pacing unavailable",
              status: "pacing-unavailable",
              cause: response.error,
            })
          : response.error,
      );
    }
    const waitMs = Number(response.value);
    if (
      !Number.isFinite(waitMs) ||
      waitMs < 0 ||
      (replies !== undefined && !replies.includes(waitMs))
    ) {
      const error = new PublisherGateReplyError({
        message: `${publisher} publisher gate returned an invalid wait`,
      });
      return Result.err(
        mode === "immediate"
          ? new PublisherPacingStopped({
              message: "Publisher pacing unavailable",
              status: "pacing-unavailable",
              cause: error,
            })
          : error,
      );
    }
    if (mode === "immediate" && waitMs === 0) {
      return Result.err(
        new PublisherPacingStopped({
          message: "Publisher pacing deferred",
          status: "pacing-deferred",
        }),
      );
    }
    return Result.ok(waitMs);
  };
  const commandWait = async (
    args: string[],
    options: CommandWaitOptions = {},
  ) => {
    const result = await commandResult(args, options);
    if (Result.isError(result)) {
      throw result.error;
    }
    return result.value;
  };
  const reserve = async (signal?: AbortSignal) => {
    while (true) {
      const keys = cooldown === "shared" ? [key, cooldownKey] : [key];
      const waitMs = await commandWait(
        [RESERVE_SLOT_SCRIPT, String(keys.length), ...keys, String(intervalMs)],
        { signal },
      );
      await (fixtureDependencies.getStore() ?? dependencies).sleep(
        waitMs,
        signal,
      );
      if (cooldown !== "shared") {
        return;
      }
      // Recheck reservations already sleeping when another worker backs off.
      // Re-reserving after the cooldown preserves spacing between those workers.
      const remaining = await commandWait([COOLDOWN_SCRIPT, "1", cooldownKey], {
        signal,
      });
      if (remaining === 0) {
        return;
      }
      await (fixtureDependencies.getStore() ?? dependencies).sleep(
        remaining,
        signal,
      );
    }
  };
  const tryReserve = async ({
    signal,
    mode,
  }: Pick<CommandWaitOptions, "signal" | "mode"> = {}): Promise<boolean> => {
    const keys = cooldown === "shared" ? [key, cooldownKey] : [key];
    const reply = await commandWait(
      [
        TRY_RESERVE_SLOT_SCRIPT,
        String(keys.length),
        ...keys,
        String(intervalMs),
      ],
      { signal, replies: [0, 1], ...(mode === undefined ? {} : { mode }) },
    );
    return reply === 1;
  };
  return Object.assign(reserve, {
    tryReserve: async (signal?: AbortSignal) => await tryReserve({ signal }),
    reserveImmediately: async (signal?: AbortSignal): Promise<void> => {
      await tryReserve({ signal, mode: "immediate" });
    },
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
        { signal },
      ),
  });
};
