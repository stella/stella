import { panic, Result } from "better-result";

import { sha256Hex } from "@stll/sha256/bun";

import type { LinkIconTarget } from "@/api/handlers/chat/link-icons/origin";
import type { SafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";
import { withCommandTimeout } from "@/api/lib/rate-limit/redis-command-timeout";
import { createRedisClient } from "@/api/lib/redis-client";
import { coordinationKey } from "@/api/lib/redis-keys";

import type { CacheableLinkIconOutcome, LinkIconOutcome } from "./outcome";

type RedisLike = {
  connect: () => Promise<unknown>;
  send: (command: string, args: string[]) => Promise<unknown>;
  close: () => void;
};
type ConnectionAttempt = { client: RedisLike; ready: Promise<unknown> };
type ReadResult = LinkIconOutcome | { type: "lease"; token: string };
type CacheOptions = {
  createRedis?: () => RedisLike;
  onRedisError?: (error: unknown) => void;
  slot?: string;
};

const POSITIVE_TTL = 604_800;
const NEGATIVE_TTL = 3600;
const LEASE_TTL = 10;
const BYTE_BUDGET = 32 * 1024 * 1024;
const MAX_ENTRIES = 16_384;
const COMMAND_TIMEOUT_MS = 500;

// Every field, including admission records and leases, participates in the same
// atomic budget. The allowance covers hash/zset nodes and their duplicated keys;
// encoded image bytes are charged at their full base64 envelope length.
const COMMON = `
local now = tonumber(redis.call('TIME')[1])
local accounting = redis.call('HGET', KEYS[1], '__bytes')
-- Eviction may remove one key independently. Accounting lives with payloads;
-- discard either orphan so unreachable expiry records cannot strand budget.
if accounting and redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('DEL', KEYS[1])
  accounting = nil
end
if not accounting then redis.call('DEL', KEYS[2]) end
local used = tonumber(accounting or '1024')
local function remove(field)
  local value = redis.call('HGET', KEYS[1], field)
  if value then used = used - string.len(field) - string.len(value) - 512 end
  redis.call('HDEL', KEYS[1], field)
  redis.call('ZREM', KEYS[2], field)
end
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now, 'LIMIT', 0, 64)
for _, field in ipairs(expired) do remove(field) end
local function get(field)
  local encoded = redis.call('HGET', KEYS[1], field)
  if not encoded then return nil end
  local boundary = string.find(encoded, ':')
  if tonumber(string.sub(encoded, 1, boundary - 1)) <= now then remove(field); return nil end
  return string.sub(encoded, boundary + 1)
end
local function put(field, value, ttl)
  remove(field)
  local encoded = tostring(now + ttl) .. ':' .. value
  used = used + string.len(field) + string.len(encoded) + 512
  redis.call('HSET', KEYS[1], field, encoded)
  redis.call('ZADD', KEYS[2], now + ttl, field)
end
local function finish(value)
  redis.call('HSET', KEYS[1], '__bytes', tostring(used))
  redis.call('EXPIRE', KEYS[1], 604800)
  redis.call('EXPIRE', KEYS[2], 604800)
  return value
end
`;
const READ = `${COMMON}
local host = 'h:' .. ARGV[1]
local value = get(host)
if value then return finish(value) end
local window = tostring(math.floor(now / 3600))
local user = 'u:' .. ARGV[2] .. ':' .. window
local ip = 'i:' .. ARGV[3] .. ':' .. window
local um = user .. ':' .. ARGV[1]
local im = ip .. ':' .. ARGV[1]
local uc = tonumber(get(user) or '0')
local ic = tonumber(get(ip) or '0')
local unew = not get(um)
local inew = not get(im)
if (unew and uc >= 60) or (inew and ic >= 120) then return finish('T') end
-- Five small records need at most 4096 bytes, including their overhead.
if used + 4096 > tonumber(ARGV[5]) or redis.call('HLEN', KEYS[1]) + 5 > tonumber(ARGV[6]) then return finish('T') end
if unew then put(user, tostring(uc + 1), 3600); put(um, '1', 3600) end
if inew then put(ip, tostring(ic + 1), 3600); put(im, '1', 3600) end
put(host, 'L' .. ARGV[4], ${LEASE_TTL})
return finish('A' .. ARGV[4])
`;
const FILL = `${COMMON}
local host = 'h:' .. ARGV[1]
if get(host) ~= 'L' .. ARGV[2] then return finish('N') end
remove(host)
local cost = string.len(host) + string.len(ARGV[3]) + string.len(tostring(now + tonumber(ARGV[4]))) + 1 + 512
if used + cost > tonumber(ARGV[5]) then return finish('N') end
put(host, ARGV[3], tonumber(ARGV[4]))
return finish('S')
`;

export const createLinkIconCache = ({
  createRedis = () =>
    createRedisClient({
      storeClass: "cache",
      overrides: {
        connectionTimeout: COMMAND_TIMEOUT_MS,
        enableOfflineQueue: false,
      },
    }),
  onRedisError = () =>
    logger.warn("chat.link_icons.cache_unavailable", {
      reason: "redis_failure",
    }),
  slot = "global",
}: CacheOptions = {}) => {
  const keys = ["entries", "expiry"].map((suffix) =>
    coordinationKey({ scope: "link-icons", slot, suffix }),
  );
  let connection: ConnectionAttempt | null = null;
  const getConnection = () => {
    if (connection !== null) {
      return connection;
    }
    const client = createRedis();
    connection = {
      client,
      ready: Promise.resolve().then(async () => await client.connect()),
    };
    return connection;
  };
  const command = async (script: string, args: string[]) => {
    const attempt: { connection: ConnectionAttempt | null } = {
      connection: null,
    };
    const outcome = await Result.tryPromise({
      try: async () => {
        const active = getConnection();
        attempt.connection = active;
        return await withCommandTimeout({
          command: active.ready.then(async () => {
            if (connection !== active) {
              return null;
            }
            return await active.client.send("EVAL", [
              script,
              String(keys.length),
              ...keys,
              ...args,
            ]);
          }),
          commandTimeoutMs: COMMAND_TIMEOUT_MS,
          label: "link-icons",
        });
      },
      catch: (error: unknown) => error,
    });
    if (Result.isOk(outcome)) {
      return outcome.value;
    }
    onRedisError(outcome.error);
    if (connection === attempt.connection) {
      connection?.client.close();
      connection = null;
    }
    return null;
  };
  return {
    readOrLease: async ({
      hostname,
      userId,
      ip,
    }: {
      hostname: LinkIconTarget;
      userId: SafeId<"user">;
      ip: string;
    }): Promise<ReadResult> => {
      const token = Bun.randomUUIDv7();
      const value = await command(READ, [
        sha256Hex(hostname.value),
        sha256Hex(userId),
        sha256Hex(ip),
        token,
        String(BYTE_BUDGET),
        String(MAX_ENTRIES),
      ]);
      if (value === `A${token}`) {
        return { type: "lease", token };
      }
      if (typeof value !== "string") {
        return { type: "temporary" };
      }
      switch (value.charAt(0)) {
        case "P":
          return {
            type: "icon",
            icon: {
              bytes: Buffer.from(value.slice(1), "base64"),
              mime: "image/png",
            },
          };
        case "I":
          return {
            type: "icon",
            icon: {
              bytes: Buffer.from(value.slice(1), "base64"),
              mime: "image/x-icon",
            },
          };
        case "N":
          return { type: "no-icon" };
        default:
          return { type: "temporary" };
      }
    },
    store: async ({
      hostname,
      token,
      outcome,
    }: {
      hostname: LinkIconTarget;
      token: string;
      outcome: CacheableLinkIconOutcome;
    }): Promise<boolean> => {
      let value: string;
      let ttl: number;
      switch (outcome.type) {
        case "icon": {
          const { icon } = outcome;
          if (icon.bytes.byteLength > 65_536) {
            return false;
          }
          value = `${icon.mime === "image/png" ? "P" : "I"}${Buffer.from(icon.bytes).toString("base64")}`;
          ttl = POSITIVE_TTL;
          break;
        }
        case "no-icon":
          value = "N";
          ttl = NEGATIVE_TTL;
          break;
        default:
          outcome satisfies never;
          return panic("Unhandled cacheable link icon outcome");
      }
      return (
        (await command(FILL, [
          sha256Hex(hostname.value),
          token,
          value,
          String(ttl),
          String(BYTE_BUDGET),
        ])) === "S"
      );
    },
    close: () => {
      const closing = connection;
      connection = null;
      closing?.client.close();
    },
  };
};

let shared: ReturnType<typeof createLinkIconCache> | undefined;
export const getLinkIconCache = () => {
  shared ??= createLinkIconCache();
  return shared;
};
