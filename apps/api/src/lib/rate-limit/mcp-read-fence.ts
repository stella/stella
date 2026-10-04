import { Result } from "better-result";

import { Temporal } from "@stll/time";

import { env } from "@/api/env";
import {
  createAdmissionRedis,
  resolveAdmissionRedisClient,
  sendAdmissionRedisCommand,
  type AdmissionRedisClient,
} from "@/api/lib/admission-redis";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { ActionAdmissionError } from "@/api/lib/rate-limit/action-admission";
import { MCP_READ_MAX_ENTRIES } from "@/api/lib/rate-limit/mcp-read-fence-policy";
import { withCommandTimeout } from "@/api/lib/rate-limit/redis-command-timeout";
import { coordinationKey } from "@/api/lib/redis-keys";
import type { McpReadClass } from "@/api/mcp/tool-types";

export type McpReadFencePolicy = {
  windowMs: number;
  maxEntries: number;
  tenant: { organizationBytes: number; userBytes: number };
  public: { organizationBytes: number; userBytes: number };
};

const COMMAND_TIMEOUT_MS = 500;
// Require API/Valkey clocks to agree within the 100 ms margin. The earlier
// server deadline prevents delayed commands from charging a refused output.
const CHARGE_DEADLINE_MS = 400;
const CANCELLATION_MARGIN_MS = 500;
const fenceRedis = createAdmissionRedis();
export const closeMcpReadFenceRedis = () => fenceRedis.close();
export const startMcpReadFenceRedis = async () => {
  const connection = await fenceRedis.ready();
  if (Result.isError(connection)) {
    await Promise.reject(connection.error);
  }
};

const unavailable = (cause?: unknown) =>
  ActionAdmissionError.is(cause)
    ? cause
    : new ActionAdmissionError({
        message: "Read coordination is unavailable",
        reason: "unavailable",
        cause,
      });

export const resolveMcpReadFencePolicy = (): Result<
  McpReadFencePolicy,
  ActionAdmissionError
> => {
  const policy = {
    windowMs: env.MCP_READ_WINDOW_MS,
    maxEntries: env.MCP_READ_WINDOW_MAX_ENTRIES,
    tenant: {
      organizationBytes: env.MCP_READ_TENANT_ORG_BYTES,
      userBytes: env.MCP_READ_TENANT_USER_BYTES,
    },
    public: {
      organizationBytes: env.MCP_READ_PUBLIC_ORG_BYTES,
      userBytes: env.MCP_READ_PUBLIC_USER_BYTES,
    },
  };
  if (
    policy.windowMs === undefined ||
    policy.maxEntries === undefined ||
    policy.tenant.organizationBytes === undefined ||
    policy.tenant.userBytes === undefined ||
    policy.public.organizationBytes === undefined ||
    policy.public.userBytes === undefined
  ) {
    return Result.err(unavailable());
  }
  return Result.ok({
    windowMs: policy.windowMs,
    maxEntries: policy.maxEntries,
    tenant: {
      organizationBytes: policy.tenant.organizationBytes,
      userBytes: policy.tenant.userBytes,
    },
    public: {
      organizationBytes: policy.public.organizationBytes,
      userBytes: policy.public.userBytes,
    },
  });
};

// Every log is bounded by maxEntries. All keys share the organization slot;
// check all classes and both identities before appending to any of them.
// Flag-on requires a non-evicting coordination store, as admission does.
const CHARGE_SCRIPT = `
local clock = redis.call("TIME")
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
if now >= tonumber(ARGV[5]) then return -1 end
if redis.call("EXISTS", KEYS[#KEYS]) == 1 then return -1 end
local window = tonumber(ARGV[1])
local maximum = tonumber(ARGV[2])
local bytes = tonumber(ARGV[3])
local cutoff = now - window
for i = 1, #KEYS - 1 do
  local key = KEYS[i]
  local entries = redis.call("ZRANGEBYSCORE", key, "(" .. cutoff, "+inf", "LIMIT", 0, maximum + 1)
  if #entries >= maximum then return 0 end
  local limit = tonumber(ARGV[5 + i])
  local total = 0
  for _, entry in ipairs(entries) do
    local amount = tonumber(string.match(entry, "^(%d+):"))
    if amount == nil or amount <= 0 or amount > 9007199254740991 then return -1 end
    if amount > limit - total then return 0 end
    total = total + amount
  end
  if bytes > limit - total then return 0 end
end
for i = 1, #KEYS - 1 do
  local key = KEYS[i]
  redis.call("ZREMRANGEBYSCORE", key, "-inf", cutoff)
  redis.call("ZADD", key, now, ARGV[3] .. ":" .. ARGV[4])
  redis.call("PEXPIRE", key, window)
end
return 1
`;

const CANCEL_SCRIPT = `
local clock = redis.call("TIME")
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
local ttl = math.max(1, tonumber(ARGV[2]) - now + tonumber(ARGV[3]))
redis.call("SET", KEYS[#KEYS], "1", "PX", ttl)
for i = 1, #KEYS - 1 do
  redis.call("ZREM", KEYS[i], ARGV[1])
end
return 1
`;

type ChargeMcpReadBytesOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  readClass: McpReadClass;
  bytes: number;
  enabled?: boolean;
  policy?: McpReadFencePolicy;
  redis?: AdmissionRedisClient;
};

export const chargeMcpReadBytes = async ({
  organizationId,
  userId,
  readClass,
  bytes,
  enabled = isDeploymentFeatureEnabled("FEATURE_MCP_READ_FENCE"),
  policy,
  redis,
}: ChargeMcpReadBytesOptions): Promise<Result<void, ActionAdmissionError>> => {
  if (!enabled || bytes === 0) {
    return Result.ok(undefined);
  }
  const resolved =
    policy === undefined ? resolveMcpReadFencePolicy() : Result.ok(policy);
  if (Result.isError(resolved)) {
    return resolved;
  }
  const limits = resolved.value;
  if (
    limits.maxEntries > MCP_READ_MAX_ENTRIES ||
    ![
      bytes,
      limits.windowMs,
      limits.maxEntries,
      limits.tenant.organizationBytes,
      limits.tenant.userBytes,
      limits.public.organizationBytes,
      limits.public.userBytes,
    ].every((value) => Number.isSafeInteger(value) && value > 0)
  ) {
    return Result.err(unavailable());
  }
  const classes =
    readClass === "both" ? (["tenant", "public"] as const) : [readClass];
  const counters = classes.flatMap((kind) => [
    {
      key: coordinationKey({
        scope: "mcp-read-fence",
        slot: organizationId,
        suffix: `${kind}:organization`,
      }),
      limit: limits[kind].organizationBytes,
    },
    {
      key: coordinationKey({
        scope: "mcp-read-fence",
        slot: organizationId,
        suffix: `${kind}:user:${userId}`,
      }),
      limit: limits[kind].userBytes,
    },
  ]);
  const operationId = Bun.randomUUIDv7();
  const member = `${bytes}:${operationId}`;
  const deadline =
    Temporal.Now.instant().epochMilliseconds + CHARGE_DEADLINE_MS;
  const keys = [
    ...counters.map((counter) => counter.key),
    coordinationKey({
      scope: "mcp-read-fence",
      slot: organizationId,
      suffix: `cancel:${operationId}`,
    }),
  ];
  const client =
    redis === undefined
      ? resolveAdmissionRedisClient(fenceRedis.ready)
      : Promise.resolve(Result.ok(redis));
  const chargeAttempt = await Result.tryPromise({
    try: async () =>
      await withCommandTimeout({
        command: (async () => {
          const connection = await client;
          if (Result.isError(connection)) {
            return connection;
          }
          const reply = await sendAdmissionRedisCommand(connection.value, [
            CHARGE_SCRIPT,
            String(keys.length),
            ...keys,
            String(limits.windowMs),
            String(limits.maxEntries),
            String(bytes),
            operationId,
            String(deadline),
            ...counters.map((counter) => String(counter.limit)),
          ]);
          return reply;
        })(),
        commandTimeoutMs: COMMAND_TIMEOUT_MS,
        label: "mcp-read-fence",
      }),
    catch: (cause) => unavailable(cause),
  });
  const charged = Result.isError(chargeAttempt)
    ? chargeAttempt
    : chargeAttempt.value.mapError(unavailable);
  if (Result.isError(charged)) {
    if (!(charged.error.cause instanceof TimeoutError)) {
      return charged;
    }
    const cancelAttempt = await Result.tryPromise({
      try: async () =>
        await withCommandTimeout({
          command: (async () => {
            const connection = await client;
            if (Result.isError(connection)) {
              return connection;
            }
            const reply = await sendAdmissionRedisCommand(connection.value, [
              CANCEL_SCRIPT,
              String(keys.length),
              ...keys,
              member,
              String(deadline),
              String(CANCELLATION_MARGIN_MS),
            ]);
            return reply;
          })(),
          commandTimeoutMs: COMMAND_TIMEOUT_MS,
          label: "mcp-read-fence-cancel",
        }),
      catch: (cause) => unavailable(cause),
    });
    const cancelled = Result.isError(cancelAttempt)
      ? cancelAttempt
      : cancelAttempt.value.mapError(unavailable);
    // Disconnected clients can reject cancellation. Keep the conservative
    // overcount, refuse delivery, and propagate through the existing
    // read-fence unavailable telemetry at the MCP boundary.
    if (Result.isError(cancelled)) {
      return Result.err(
        unavailable({ charge: charged.error, cancellation: cancelled.error }),
      );
    }
    if (cancelled.value !== 1) {
      return Result.err(unavailable(cancelled.value));
    }
    return charged;
  }
  if (charged.value === 1) {
    return Result.ok(undefined);
  }
  if (charged.value === 0) {
    return Result.err(
      new ActionAdmissionError({
        message: "Read window is exhausted",
        reason: "period_exhausted",
      }),
    );
  }
  return Result.err(unavailable());
};
