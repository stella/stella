import { Result } from "better-result";

import type {
  ContinuationStore,
  ContinuationStoreError,
} from "@/api/lib/legal-search/public-read-continuation";
import { withCommandTimeout } from "@/api/lib/rate-limit/redis-command-timeout";
import {
  createLazyRedisClient,
  createRedisClient,
} from "@/api/lib/redis-client";
import {
  type CoordinationKey,
  coordinationKey,
  coordinationSetArguments,
} from "@/api/lib/redis-keys";

/**
 * The Valkey half of the public-read continuation.
 *
 * Everything here can be rebuilt from the request that produced it: a lost
 * key means a read runs again, never a wrong answer. An outage trips a short
 * breaker, so a search pays for one failed command rather than one per step,
 * and the continuation then runs each read on its own task.
 */
const COMMAND_TIMEOUT_MS = 500;
const OUTAGE_BREAK_MS = 5000;

const RENEW_IF_OWNER = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_IF_OWNER = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const COUNT_ATTEMPT = `
local attempts = redis.call("INCR", KEYS[1])
redis.call("PEXPIRE", KEYS[1], ARGV[1])
return attempts
`;

type RedisSender = {
  send: (command: string, args: string[]) => Promise<unknown>;
};

type CreateContinuationStoreOptions = {
  ready?: () => Promise<RedisSender>;
  now?: () => number;
  commandTimeoutMs?: number;
};

const continuationKey = (workId: string, suffix: string): CoordinationKey =>
  coordinationKey({ scope: "public-read-continuation", slot: workId, suffix });

export const createContinuationStore = ({
  ready,
  now = () => performance.now(),
  commandTimeoutMs = COMMAND_TIMEOUT_MS,
}: CreateContinuationStoreOptions = {}): ContinuationStore => {
  const connection: () => Promise<RedisSender> =
    ready ??
    (() => {
      const lazy = createLazyRedisClient(() =>
        createRedisClient({
          storeClass: "cache",
          overrides: {
            connectionTimeout: commandTimeoutMs,
            enableOfflineQueue: false,
          },
        }),
      );
      return async () => await lazy.ready();
    })();
  let brokenUntil = 0;

  const send = async (
    command: string,
    args: string[],
  ): Promise<Result<unknown, ContinuationStoreError>> => {
    if (now() < brokenUntil) {
      return Result.err({ type: "unavailable", cause: "breaker_open" });
    }
    const replied = await Result.tryPromise({
      try: async () =>
        await withCommandTimeout({
          command: connection().then(
            async (client) => await client.send(command, args),
          ),
          commandTimeoutMs,
          label: "public-read-continuation-store",
        }),
      catch: (cause): ContinuationStoreError => ({
        type: "unavailable",
        cause,
      }),
    });
    if (Result.isError(replied)) {
      brokenUntil = now() + OUTAGE_BREAK_MS;
    }
    return replied;
  };

  const readString = async (key: CoordinationKey) =>
    (await send("GET", [key])).map((reply) =>
      typeof reply === "string" ? reply : null,
    );

  const write = async (key: CoordinationKey, value: string, ttlMs: number) =>
    (
      await send(
        "SET",
        coordinationSetArguments({
          key,
          value,
          ttl: { unit: "milliseconds", value: ttlMs },
        }),
      )
    ).map(() => undefined);

  return {
    readSpec: async (id) => await readString(continuationKey(id, "spec")),
    writeSpec: async (id, spec, ttl) =>
      await write(continuationKey(id, "spec"), spec, ttl),
    readFinished: async (id) =>
      await readString(continuationKey(id, "finished")),
    writeFinished: async (id, finished, ttl) =>
      await write(continuationKey(id, "finished"), finished, ttl),
    readProgress: async (id) =>
      await readString(continuationKey(id, "progress")),
    writeProgress: async (id, progress, ttl) =>
      await write(continuationKey(id, "progress"), progress, ttl),
    acquireLease: async (id, owner, ttl) =>
      (
        await send(
          "SET",
          coordinationSetArguments({
            key: continuationKey(id, "lease"),
            value: owner,
            ttl: { unit: "milliseconds", value: ttl },
            onlyIfAbsent: true,
          }),
        )
      ).map((reply) => reply === "OK"),
    renewLease: async (id, owner, ttl) =>
      (
        await send("EVAL", [
          RENEW_IF_OWNER,
          "1",
          continuationKey(id, "lease"),
          owner,
          String(ttl),
        ])
      ).map((reply) => reply === 1),
    releaseLease: async (id, owner) =>
      (
        await send("EVAL", [
          RELEASE_IF_OWNER,
          "1",
          continuationKey(id, "lease"),
          owner,
        ])
      ).map(() => undefined),
    countAttempt: async (id, ttl) =>
      (
        await send("EVAL", [
          COUNT_ATTEMPT,
          "1",
          continuationKey(id, "attempts"),
          String(ttl),
        ])
      ).map((reply) => (typeof reply === "number" ? reply : 0)),
    clearAttempts: async (id) =>
      (await send("DEL", [continuationKey(id, "attempts")])).map(
        () => undefined,
      ),
  };
};
