import { Result } from "better-result";

import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import { ActionAdmissionError } from "@/api/lib/rate-limit/action-admission";
import { withCommandTimeout } from "@/api/lib/rate-limit/redis-command-timeout";
import {
  createLazyRedisClient,
  createRedisClient,
} from "@/api/lib/redis-client";
import { coordinationKey } from "@/api/lib/redis-keys";
import type { McpReadClass } from "@/api/mcp/tool-types";

export type McpReadFencePolicy = {
  windowMs: number;
  maxEntries: number;
  tenant: { organizationBytes: number; userBytes: number };
  public: { organizationBytes: number; userBytes: number };
};

const COMMAND_TIMEOUT_MS = 500;
const fenceRedis = createLazyRedisClient(() =>
  createRedisClient({
    connectionTimeout: COMMAND_TIMEOUT_MS,
    enableOfflineQueue: false,
  }),
);
export const closeMcpReadFenceRedis = () => fenceRedis.close();

const unavailable = (cause?: unknown) =>
  new ActionAdmissionError({
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
local window = tonumber(ARGV[1])
local maximum = tonumber(ARGV[2])
local bytes = tonumber(ARGV[3])
local cutoff = now - window
for i, key in ipairs(KEYS) do
  local entries = redis.call("ZRANGEBYSCORE", key, "(" .. cutoff, "+inf", "LIMIT", 0, maximum + 1)
  if #entries >= maximum then return 0 end
  local limit = tonumber(ARGV[4 + i])
  local total = 0
  for _, entry in ipairs(entries) do
    local amount = tonumber(string.match(entry, "^(%d+):"))
    if amount == nil or amount <= 0 or amount > 9007199254740991 then return -1 end
    if amount > limit - total then return 0 end
    total = total + amount
  end
  if bytes > limit - total then return 0 end
end
for _, key in ipairs(KEYS) do
  redis.call("ZREMRANGEBYSCORE", key, "-inf", cutoff)
  redis.call("ZADD", key, now, ARGV[3] .. ":" .. ARGV[4])
  redis.call("PEXPIRE", key, window)
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
  redis?: { send: (command: string, args: string[]) => Promise<unknown> };
};

export const chargeMcpReadBytes = async ({
  organizationId,
  userId,
  readClass,
  bytes,
  enabled = env.FEATURE_MCP_READ_FENCE,
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
  const charged = await Result.tryPromise({
    try: () =>
      withCommandTimeout({
        command: (async () => {
          const client = redis ?? (await fenceRedis.ready());
          return await client.send("EVAL", [
            CHARGE_SCRIPT,
            String(counters.length),
            ...counters.map((counter) => counter.key),
            String(limits.windowMs),
            String(limits.maxEntries),
            String(bytes),
            Bun.randomUUIDv7(),
            ...counters.map((counter) => String(counter.limit)),
          ]);
        })(),
        commandTimeoutMs: COMMAND_TIMEOUT_MS,
        label: "mcp-read-fence",
      }),
    catch: (cause) => unavailable(cause),
  });
  if (Result.isError(charged)) {
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
