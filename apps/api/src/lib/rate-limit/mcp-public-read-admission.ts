import { Result } from "better-result";

import { sha256Hex } from "@stll/sha256/bun";

import { env } from "@/api/env";
import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import { coordinationKey } from "@/api/lib/redis-keys";
import type { McpRequestContext } from "@/api/mcp/context";

import {
  ACQUIRE_SCRIPT,
  type AdmissionTiming,
  concurrencyBusyRefusal,
  defaultAdmissionTiming,
  executeAdmissionCommand,
  withAcquiredConcurrencyLease,
} from "./concurrency-lease";

const PUBLIC_READ_LEASE_MS = 30_000;

type McpPublicReadAdmissionOptions<T> = {
  caller: Pick<McpRequestContext, "organizationId" | "userId" | "clientId">;
  signal?: AbortSignal | undefined;
  run: (signal: AbortSignal) => Promise<T>;
  limit?: number;
  leaseMs?: number;
  timing?: AdmissionTiming;
  redis?: Parameters<typeof executeAdmissionCommand>[0]["redis"];
};

export const withMcpPublicReadAdmission = async <T>({
  caller,
  signal,
  run,
  limit = env.MCP_PUBLIC_READ_CALLER_CONCURRENCY,
  leaseMs = PUBLIC_READ_LEASE_MS,
  timing = defaultAdmissionTiming,
  redis,
}: McpPublicReadAdmissionOptions<T>): Promise<Result<T, unknown>> => {
  // OAuth client IDs come from verified session claims, never tool arguments.
  // Other authenticated credentials for one user share the same caller pool.
  const callerHash = sha256Hex(
    JSON.stringify([
      caller.organizationId,
      caller.userId,
      caller.clientId ?? null,
    ]),
  );
  const key = coordinationKey({
    scope: "action-admission",
    slot: callerHash,
    suffix: "mcp-public-read",
  });
  // The shared executor admits both pools atomically; a caller has one pool.
  const keys = [key, key];
  const leaseId = Bun.randomUUIDv7();
  const execute = async (script: string, args: string[]) =>
    await executeAdmissionCommand({ script, keys, args, redis });
  const initialAttemptAt = timing.now();
  const acquired = await execute(ACQUIRE_SCRIPT, [
    String(leaseMs),
    String(limit),
    String(limit),
    leaseId,
  ]);
  if (Result.isError(acquired)) {
    return acquired;
  }
  const busy = concurrencyBusyRefusal(acquired.value);
  if (busy !== null) {
    return Result.err(busy);
  }
  if (acquired.value !== 1) {
    return Result.err(
      new ActionAdmissionError({
        message: "Action admission returned an invalid response",
        reason: "unavailable",
      }),
    );
  }
  return await withAcquiredConcurrencyLease({
    leaseMs,
    leaseId,
    initialAttemptAt,
    timing,
    execute,
    run: async (leaseSignal) => {
      const combined =
        signal === undefined
          ? leaseSignal
          : AbortSignal.any([signal, leaseSignal]);
      combined.throwIfAborted();
      return await run(combined);
    },
  });
};
