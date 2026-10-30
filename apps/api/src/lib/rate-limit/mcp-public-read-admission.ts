import { panic, Result, TaggedError } from "better-result";

import { declareFingerprintFields } from "@stll/errors";
import { sha256Hex } from "@stll/sha256/bun";

import { env } from "@/api/env";
import { detached } from "@/api/lib/analytics/capture";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { coordinationKey } from "@/api/lib/redis-keys";
import type { McpRequestContext } from "@/api/mcp/context";

import {
  ACQUIRE_SCRIPT,
  type AdmissionTiming,
  concurrencyBusyRefusal,
  defaultAdmissionTiming,
  executeAdmissionCommand,
  type LeaseDegradation,
  RELEASE_SCRIPT,
  withAcquiredConcurrencyLease,
} from "./concurrency-lease";

const PUBLIC_READ_LEASE_MS = 30_000;
const PUBLIC_READ_ACQUIRE_CLEANUP_TIMEOUT_MS = 250;

type PublicReadDegradation = {
  phase: "acquire" | LeaseDegradation["phase"];
  reason: LeaseDegradation["reason"];
};

type PublicReadAdmissionOutcome<T> =
  | { status: "leased"; value: T }
  | { status: "degraded"; degradation: PublicReadDegradation; value: T };

class PublicReadAdmissionCoordinationError extends TaggedError(
  "PublicReadAdmissionCoordinationError",
)<{
  message: string;
  phase: PublicReadDegradation["phase"];
  outcome: "degraded" | "lease_lost" | "cleanup_failed";
  reason: PublicReadDegradation["reason"] | "definite_loss";
}> {
  static {
    declareFingerprintFields(this, ["phase", "reason"]);
  }
}

const DEGRADED_FAILURE = failureSink({
  event: "mcp.public_read.admission_degraded",
  expected: [],
});
const LEASE_LOST_FAILURE = failureSink({
  event: "mcp.public_read.lease_lost",
  expected: [],
});

const ACQUIRE_CLEANUP_FAILURE = failureSink({
  event: "mcp.public_read.acquire_cleanup_failed",
  expected: [],
});

type DegradedAcquireCleanupOptions = Pick<
  Parameters<typeof executeAdmissionCommand>[0],
  "keys" | "redis" | "redisReady"
> & { leaseId: string };

const releaseDegradedAcquire = async ({
  keys,
  leaseId,
  redis,
  redisReady,
}: DegradedAcquireCleanupOptions): Promise<void> => {
  const released = await executeAdmissionCommand({
    script: RELEASE_SCRIPT,
    keys,
    args: [leaseId],
    redis,
    redisReady,
    commandTimeoutMs: PUBLIC_READ_ACQUIRE_CLEANUP_TIMEOUT_MS,
  });
  if (Result.isOk(released) && released.value === 1) {
    return;
  }
  const reason = Result.isError(released) ? "unavailable" : "invalid_reply";
  observeFailure(
    new PublicReadAdmissionCoordinationError({
      message: "Public-read admission cleanup failed",
      outcome: "cleanup_failed",
      phase: "release",
      reason,
    }),
    {
      sink: ACQUIRE_CLEANUP_FAILURE,
      ctx: { source: "mcp_public_read", phase: "release", operation: reason },
    },
  );
};

type McpPublicReadAdmissionOptions<T> = {
  caller: Pick<McpRequestContext, "organizationId" | "userId" | "clientId">;
  signal?: AbortSignal | undefined;
  run: (signal: AbortSignal) => Promise<T>;
  limit?: number;
  leaseMs?: number;
  timing?: AdmissionTiming;
  redis?: Parameters<typeof executeAdmissionCommand>[0]["redis"];
  redisReady?: Parameters<typeof executeAdmissionCommand>[0]["redisReady"];
};

export const withMcpPublicReadAdmission = async <T>({
  caller,
  signal,
  run,
  limit = env.MCP_PUBLIC_READ_CALLER_CONCURRENCY,
  leaseMs = PUBLIC_READ_LEASE_MS,
  timing = defaultAdmissionTiming,
  redis,
  redisReady,
}: McpPublicReadAdmissionOptions<T>): Promise<
  Result<PublicReadAdmissionOutcome<T>, unknown>
> => {
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
    await executeAdmissionCommand({ script, keys, args, redis, redisReady });
  const initialAttemptAt = timing.now();
  const acquired = await execute(ACQUIRE_SCRIPT, [
    String(leaseMs),
    String(limit),
    String(limit),
    leaseId,
  ]);
  let admission:
    | { status: "leased" }
    | { status: "lease_lost" }
    | { status: "degraded"; degradation: PublicReadDegradation } = {
    status: "leased",
  };
  const degraded = (event: PublicReadDegradation) => {
    if (admission.status !== "leased") {
      return;
    }
    admission = { status: "degraded", degradation: event };
    // Coordination context is closed and contains no caller or command data.
    observeFailure(
      new PublicReadAdmissionCoordinationError({
        message: "Public-read admission is degraded",
        outcome: "degraded",
        ...event,
      }),
      {
        sink: DEGRADED_FAILURE,
        ctx: {
          source: "mcp_public_read",
          phase: event.phase,
          operation: event.reason,
        },
      },
    );
  };
  const lost = () => {
    if (admission.status !== "leased") {
      return;
    }
    admission = { status: "lease_lost" };
    observeFailure(
      new PublicReadAdmissionCoordinationError({
        message: "Public-read lease was lost",
        outcome: "lease_lost",
        phase: "renewal",
        reason: "definite_loss",
      }),
      {
        sink: LEASE_LOST_FAILURE,
        ctx: {
          source: "mcp_public_read",
          phase: "renewal",
          operation: "definite_loss",
        },
      },
    );
  };
  const runUnleased = async (event: PublicReadDegradation) => {
    degraded(event);
    // The store may complete an uncertain acquire; cleanup must not delay the read.
    detached(
      releaseDegradedAcquire({ keys, leaseId, redis, redisReady }),
      "mcp-public-read.acquire-cleanup",
    );
    const outcome = await Result.tryPromise({
      try: async () => {
        const requestSignal = signal ?? new AbortController().signal;
        requestSignal.throwIfAborted();
        return await run(requestSignal);
      },
      catch: (error: unknown) => error,
    });
    return outcome.map(
      (value) => ({ status: "degraded", degradation: event, value }) as const,
    );
  };
  if (Result.isError(acquired)) {
    return await runUnleased({ phase: "acquire", reason: "unavailable" });
  }
  const busy = concurrencyBusyRefusal(acquired.value);
  if (busy !== null) {
    return Result.err(busy);
  }
  if (acquired.value !== 1) {
    return await runUnleased({ phase: "acquire", reason: "invalid_reply" });
  }
  const outcome = await withAcquiredConcurrencyLease({
    availability: { type: "best_effort", onDegraded: degraded, onLost: lost },
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
  return outcome.map((value) => {
    switch (admission.status) {
      case "leased":
      case "lease_lost":
        return { status: "leased", value } as const;
      case "degraded":
        return {
          status: "degraded",
          degradation: admission.degradation,
          value,
        } as const;
      default:
        admission satisfies never;
        return panic("Unhandled public-read admission outcome");
    }
  });
};
