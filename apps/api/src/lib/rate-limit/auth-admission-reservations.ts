import { Result } from "better-result";

import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import type { AuthRateLimitRedisClient } from "@/api/lib/rate-limit/auth-storage";
import {
  withCommandTimeout,
  type ScheduleTimeout,
} from "@/api/lib/rate-limit/redis-command-timeout";
import { coordinationKey } from "@/api/lib/redis-keys";

const FALLBACK_CLEANUP_INTERVAL_MS = 60_000;

const RESERVE_SCRIPT = `
-- admission-reserve
local windowMs, max = string.match(ARGV[1], "^(%d+):(%d+)$")
local window = redis.call("HGET", KEYS[1], "window")
if not window then
  window = ARGV[2]
  redis.call("HSET", KEYS[1], "window", window, "count", 0)
  redis.call("PEXPIRE", KEYS[1], windowMs)
end
local count = tonumber(redis.call("HGET", KEYS[1], "count"))
if count >= tonumber(max) then
  return {0, math.max(1, math.ceil(redis.call("PTTL", KEYS[1]) / 1000))}
end
redis.call("HINCRBY", KEYS[1], "count", 1)
redis.call("HSET", KEYS[1], "request:" .. ARGV[2], window)
return {1, 0}
`;
const SETTLE_SCRIPT = `
-- admission-settle
local field = "request:" .. ARGV[1]
local reservedWindow = redis.call("HGET", KEYS[1], field)
if not reservedWindow then return 0 end
redis.call("HDEL", KEYS[1], field)
if ARGV[2] == "accepted" and reservedWindow == redis.call("HGET", KEYS[1], "window") then
  redis.call("HINCRBY", KEYS[1], "count", -1)
end
return 1
`;

export type AuthRateLimitReservation = {
  key: string;
  requestId: string;
  localWindow: string;
};
export type AuthReservationDecision =
  | { type: "reserved"; reservation: AuthRateLimitReservation }
  | { type: "limited"; retryAfter: number };

type AuthAdmissionStorageOptions = {
  redis: AuthRateLimitRedisClient;
  scheduleTimeout: ScheduleTimeout;
  commandTimeoutMs: number;
  now: () => number;
};

/** Reservations own a separate counter; framework consumption remains unchanged. */
export const createAuthAdmissionStorage = ({
  redis,
  scheduleTimeout,
  commandTimeoutMs,
  now,
}: AuthAdmissionStorageOptions) => {
  const fallback = new Map<
    string,
    { count: number; expiresAt: number; window: string; requests: Set<string> }
  >();
  const cleanup = setInterval(() => {
    const current = now();
    for (const [key, entry] of fallback) {
      if (entry.expiresAt <= current) {
        fallback.delete(key);
      }
    }
  }, FALLBACK_CLEANUP_INTERVAL_MS);
  cleanup.unref();
  type AdmissionCommandOptions = {
    key: string;
    script: string;
    parameters: [string, string];
  };
  const command = async ({
    key,
    script,
    parameters,
  }: AdmissionCommandOptions) => {
    const outcome = await Result.tryPromise({
      try: async () =>
        await withCommandTimeout({
          command: redis.send("EVAL", [
            script,
            "1",
            coordinationKey({
              scope: "auth-ratelimit",
              slot: key,
              suffix: "admission",
            }),
            ...parameters,
          ]),
          commandTimeoutMs,
          label: "auth-admission-redis-command",
          scheduleTimeout,
        }),
      catch: (error: unknown) => error,
    });
    if (outcome.isErr()) {
      logger.warn("auth.rate_limit.redis_admission_failed", {
        "error.type": errorTag(outcome.error),
      });
    }
    return outcome;
  };
  return {
    reserve: async (
      key: string,
      rule: { max: number; window: number },
    ): Promise<AuthReservationDecision> => {
      const current = now();
      const requestId = Bun.randomUUIDv7();
      const existing = fallback.get(key);
      const local =
        existing && existing.expiresAt > current
          ? existing
          : {
              count: 0,
              expiresAt: current + rule.window * 1000,
              window: requestId,
              requests: new Set<string>(),
            };
      fallback.set(key, local);
      const localAllowed = local.count < rule.max;
      if (localAllowed) {
        local.count += 1;
        local.requests.add(requestId);
      }
      const reservation = { key, requestId, localWindow: local.window };
      const outcome = await command({
        key,
        script: RESERVE_SCRIPT,
        parameters: [
          `${String(rule.window * 1000)}:${String(rule.max)}`,
          requestId,
        ],
      });
      if (outcome.isOk()) {
        const reply = outcome.value;
        if (
          Array.isArray(reply) &&
          reply.length === 2 &&
          (reply.at(0) === 0 || reply.at(0) === 1) &&
          Number.isSafeInteger(reply.at(1)) &&
          Number(reply.at(1)) >= 0
        ) {
          if (reply.at(0) === 0 && localAllowed) {
            local.requests.delete(requestId);
            local.count -= 1;
          }
          return reply.at(0) === 1
            ? { type: "reserved", reservation }
            : { type: "limited", retryAfter: Math.max(1, Number(reply.at(1))) };
        }
        logger.warn("auth.rate_limit.redis_admission_invalid_response");
      }
      return localAllowed
        ? { type: "reserved", reservation }
        : {
            type: "limited",
            retryAfter: Math.max(
              1,
              Math.ceil((local.expiresAt - current) / 1000),
            ),
          };
    },
    settle: async (
      reservation: AuthRateLimitReservation,
      outcome: "accepted" | "rejected",
    ): Promise<void> => {
      const local = fallback.get(reservation.key);
      if (
        local &&
        local.expiresAt > now() &&
        local.window === reservation.localWindow &&
        local.requests.delete(reservation.requestId) &&
        outcome === "accepted"
      ) {
        local.count -= 1;
      }
      await command({
        key: reservation.key,
        script: SETTLE_SCRIPT,
        parameters: [reservation.requestId, outcome],
      });
    },
  };
};
