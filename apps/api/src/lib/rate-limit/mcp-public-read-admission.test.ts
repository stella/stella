import { panic, Result } from "better-result";
import { expect, jest, test } from "bun:test";
import { setImmediate } from "node:timers/promises";

import { toSafeId } from "@/api/lib/branded-types";
import {
  getPublicReadStatementTimeoutMs,
  runWithPublicReadScope,
} from "@/api/lib/legal-search/public-read-timeout-context";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

import {
  ACQUIRE_SCRIPT,
  RELEASE_SCRIPT,
  RENEW_SCRIPT,
} from "./concurrency-lease";
import { withMcpPublicReadAdmission } from "./mcp-public-read-admission";

const caller = {
  organizationId: toSafeId<"organization">("private_org"),
  userId: toSafeId<"user">("private_user"),
  clientId: "private_client",
};
const privateFailure = () =>
  new TypeError("private command SELECT secret FROM private_user");

for (const scenario of [
  "connection",
  "command",
  "timeout",
  "invalid_reply",
] as const) {
  test(`public reads proceed with one sanitized degradation capture after ${scenario}`, async () => {
    const analytics = installRecordingAnalytics();
    const cleanupObserved = Promise.withResolvers<undefined>();
    const logs = installRecordingLogger(({ message }) => {
      if (message === "mcp.public_read.acquire_cleanup_failed") {
        cleanupObserved.resolve(undefined);
      }
    });
    let reads = 0;
    let releases = 0;
    let readyCalls = 0;
    const cleanupStarted = Promise.withResolvers<undefined>();
    const commands: string[] = [];
    const redis = {
      send: async (_command: string, args: string[]) => {
        const script = args.at(0) ?? panic("Missing admission script");
        commands.push(script);
        if (script === RELEASE_SCRIPT) {
          releases += 1;
          cleanupStarted.resolve(undefined);
          return 1;
        }
        if (scenario === "timeout") {
          return await Promise.withResolvers<unknown>().promise;
        }
        if (scenario === "invalid_reply") {
          return { private_data: "private_user" };
        }
        return await Promise.reject(privateFailure());
      },
    };
    try {
      const result = await withMcpPublicReadAdmission({
        caller,
        ...(scenario === "connection"
          ? {
              redisReady: async () => {
                readyCalls += 1;
                if (readyCalls === 2) {
                  cleanupStarted.resolve(undefined);
                }
                return await Promise.reject(privateFailure());
              },
            }
          : { redis }),
        run: async (signal) =>
          await runWithPublicReadScope(
            { budgetMs: 30_000, signal },
            async () => {
              reads += 1;
              expect(getPublicReadStatementTimeoutMs()).toBe(30_000);
              expect(signal.aborted).toBe(false);
              return "read";
            },
          ),
      });
      await cleanupStarted.promise;
      if (scenario === "connection") {
        await cleanupObserved.promise;
      }
      expect(result).toMatchObject(
        Result.ok({
          status: "degraded",
          degradation: {
            phase: "acquire",
            reason:
              scenario === "invalid_reply" ? "invalid_reply" : "unavailable",
          },
          value: Result.ok("read"),
        }),
      );
      expect(reads).toBe(1);
      expect(readyCalls).toBe(scenario === "connection" ? 2 : 0);
      expect(releases).toBe(scenario === "connection" ? 0 : 1);
      expect(
        commands.filter((script) => script === RELEASE_SCRIPT),
      ).toHaveLength(scenario === "connection" ? 0 : 1);
      expect(commands.filter((script) => script === RENEW_SCRIPT)).toHaveLength(
        0,
      );
      const events = logs.records.filter(
        ({ message }) => message === "mcp.public_read.admission_degraded",
      );
      expect(events).toHaveLength(1);
      const cleanupFailures = logs.records.filter(
        ({ message }) => message === "mcp.public_read.acquire_cleanup_failed",
      );
      expect(cleanupFailures).toHaveLength(scenario === "connection" ? 1 : 0);
      expect(events.at(0)?.attributes).toMatchObject({
        phase: "acquire",
        operation:
          scenario === "invalid_reply" ? "invalid_reply" : "unavailable",
        "failure.reason": "tagged_failure",
      });
      expect(analytics.exceptions()).toHaveLength(
        scenario === "connection" ? 2 : 1,
      );
      const emitted = JSON.stringify({
        logs: logs.records,
        captures: analytics.exceptions(),
      });
      for (const secret of [
        "private_org",
        "private_user",
        "private_client",
        "SELECT secret",
      ]) {
        expect(emitted).not.toContain(secret);
      }
    } finally {
      analytics.restore();
      logs.restore();
    }
  });
}

for (const cleanupFailure of ["invalid_reply", "command_rejection"] as const) {
  test(`degraded acquire reports one sanitized cleanup ${cleanupFailure}`, async () => {
    const analytics = installRecordingAnalytics();
    const cleanupObserved = Promise.withResolvers<undefined>();
    const logs = installRecordingLogger(({ message }) => {
      if (message === "mcp.public_read.acquire_cleanup_failed") {
        cleanupObserved.resolve(undefined);
      }
    });
    let releaseAttempts = 0;

    try {
      const result = await withMcpPublicReadAdmission({
        caller,
        redis: {
          send: async (_command, args) => {
            const script = args.at(0);
            if (script === ACQUIRE_SCRIPT) {
              return null;
            }
            if (script === RELEASE_SCRIPT) {
              releaseAttempts += 1;
              if (cleanupFailure === "command_rejection") {
                return await Promise.reject(privateFailure());
              }
              return { private_data: "private_user" };
            }
            return panic("Unexpected public-read admission command");
          },
        },
        run: async () => "read",
      });
      await cleanupObserved.promise;

      expect(result).toMatchObject(
        Result.ok({
          status: "degraded",
          degradation: { phase: "acquire", reason: "invalid_reply" },
          value: "read",
        }),
      );
      expect(releaseAttempts).toBe(1);
      const cleanupFailures = logs.records.filter(
        ({ message }) => message === "mcp.public_read.acquire_cleanup_failed",
      );
      expect(cleanupFailures).toHaveLength(1);
      expect(cleanupFailures.at(0)?.attributes).toMatchObject({
        phase: "release",
        operation:
          cleanupFailure === "invalid_reply" ? "invalid_reply" : "unavailable",
        "failure.reason": "tagged_failure",
      });
      expect(
        logs.records.filter(
          ({ message }) => message === "mcp.public_read.admission_degraded",
        ),
      ).toHaveLength(1);
      expect(analytics.exceptions()).toHaveLength(2);
      const emitted = JSON.stringify({
        logs: logs.records,
        captures: analytics.exceptions(),
      });
      for (const secret of [
        "private_org",
        "private_user",
        "private_client",
        "SELECT secret",
      ]) {
        expect(emitted).not.toContain(secret);
      }
    } finally {
      analytics.restore();
      logs.restore();
    }
  });
}

test("acquire cleanup timeout is observed without delaying the read or leaking a rejection", async () => {
  const analytics = installRecordingAnalytics();
  const cleanupObserved = Promise.withResolvers<undefined>();
  const logs = installRecordingLogger(({ message }) => {
    if (message === "mcp.public_read.acquire_cleanup_failed") {
      cleanupObserved.resolve(undefined);
    }
  });
  const cleanupStarted = Promise.withResolvers<undefined>();
  const cleanupCommand = Promise.withResolvers<unknown>();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  jest.useFakeTimers();
  try {
    const result = await withMcpPublicReadAdmission({
      caller,
      redis: {
        send: async (_command, args) => {
          if (args.at(0) === ACQUIRE_SCRIPT) {
            return null;
          }
          if (args.at(0) === RELEASE_SCRIPT) {
            cleanupStarted.resolve(undefined);
            return await cleanupCommand.promise;
          }
          return panic("Unexpected public-read admission command");
        },
      },
      run: async () => "read",
    });
    await cleanupStarted.promise;
    expect(result).toMatchObject(
      Result.ok({
        status: "degraded",
        degradation: { phase: "acquire", reason: "invalid_reply" },
        value: "read",
      }),
    );
    expect(
      logs.records.filter(
        ({ message }) => message === "mcp.public_read.acquire_cleanup_failed",
      ),
    ).toHaveLength(0);

    jest.advanceTimersByTime(249);
    expect(
      logs.records.filter(
        ({ message }) => message === "mcp.public_read.acquire_cleanup_failed",
      ),
    ).toHaveLength(0);
    jest.advanceTimersByTime(1);
    await cleanupObserved.promise;
    expect(
      logs.records.filter(
        ({ message }) => message === "mcp.public_read.acquire_cleanup_failed",
      ),
    ).toHaveLength(1);
    expect(logs.records.at(-1)?.attributes).toMatchObject({
      phase: "release",
      operation: "unavailable",
      "failure.reason": "tagged_failure",
    });
    expect(analytics.exceptions()).toHaveLength(2);

    cleanupCommand.reject(privateFailure());
    jest.useRealTimers();
    await setImmediate();
    expect(unhandled).toEqual([]);
    const emitted = JSON.stringify({
      logs: logs.records,
      captures: analytics.exceptions(),
    });
    for (const secret of [
      "private_org",
      "private_user",
      "private_client",
      "SELECT secret",
    ]) {
      expect(emitted).not.toContain(secret);
    }
  } finally {
    jest.useRealTimers();
    process.off("unhandledRejection", onUnhandled);
    analytics.restore();
    logs.restore();
  }
});

test("reachable caller caps refuse busy reads without degradation", async () => {
  const analytics = installRecordingAnalytics();
  const logs = installRecordingLogger();
  let ran = false;
  try {
    const result = await withMcpPublicReadAdmission({
      caller,
      redis: { send: async () => [0, 1250] },
      run: async () => {
        ran = true;
      },
    });
    expect(result).toMatchObject({
      status: "error",
      error: {
        reason: "busy",
        code: "action_concurrency_busy",
        retryAfterMs: 1250,
      },
    });
    expect(ran).toBe(false);
    expect(logs.records).toEqual([]);
    expect(analytics.exceptions()).toEqual([]);
  } finally {
    analytics.restore();
    logs.restore();
  }
});

for (const scenario of [
  "unavailable",
  "invalid_reply",
  "lease_uncertain",
  "definite_loss",
] as const) {
  test(`renewal ${scenario} has one typed observation and deliberate cancellation`, async () => {
    const analytics = installRecordingAnalytics();
    const logs = installRecordingLogger();
    const scheduled = Promise.withResolvers<() => void>();
    const entered = Promise.withResolvers<AbortSignal>();
    const finish = Promise.withResolvers<undefined>();
    let now = 0;
    let schedules = 0;
    const owner = withMcpPublicReadAdmission({
      caller,
      redis: {
        send: async (_command, args) => {
          const script = args.at(0);
          if (script === ACQUIRE_SCRIPT) {
            return 1;
          }
          if (script === RELEASE_SCRIPT) {
            return scenario === "definite_loss"
              ? 1
              : await Promise.reject(privateFailure());
          }
          if (scenario === "unavailable") {
            return await Promise.reject(privateFailure());
          }
          return scenario === "definite_loss" ? 0 : "private_user";
        },
      },
      timing: {
        now: () => now,
        schedule: (callback) => {
          schedules += 1;
          scheduled.resolve(callback);
          return () => undefined;
        },
      },
      run: async (signal) => {
        entered.resolve(signal);
        await finish.promise;
        signal.throwIfAborted();
        return "complete";
      },
    });
    try {
      const signal = await entered.promise;
      if (scenario === "lease_uncertain") {
        now = 30_000;
      }
      const renew = await scheduled.promise;
      renew();
      // Yield the turn so command settlement and its observation complete.
      await setImmediate();
      expect(signal.aborted).toBe(scenario === "definite_loss");
      expect(schedules).toBe(1);
      finish.resolve(undefined);
      const result = await owner;
      if (scenario === "definite_loss") {
        expect(result).toMatchObject({
          status: "error",
          error: { reason: "lease_lost" },
        });
      } else {
        expect(result).toMatchObject(
          Result.ok({
            status: "degraded",
            degradation: { phase: "renewal", reason: scenario },
            value: "complete",
          }),
        );
      }
      const event =
        scenario === "definite_loss"
          ? "mcp.public_read.lease_lost"
          : "mcp.public_read.admission_degraded";
      expect(
        logs.records.filter(({ message }) => message === event),
      ).toHaveLength(1);
      expect(analytics.exceptions()).toHaveLength(1);
      expect(JSON.stringify(logs.records)).not.toContain("private_user");
    } finally {
      finish.resolve(undefined);
      await owner;
      analytics.restore();
      logs.restore();
    }
  });
}

for (const reason of ["unavailable", "invalid_reply"] as const) {
  test(`release ${reason} preserves completed reads and captures once`, async () => {
    const analytics = installRecordingAnalytics();
    const logs = installRecordingLogger();
    try {
      const result = await withMcpPublicReadAdmission({
        caller,
        redis: {
          send: async (_command, args) => {
            if (args.at(0) !== RELEASE_SCRIPT) {
              return 1;
            }
            return reason === "invalid_reply"
              ? null
              : await Promise.reject(privateFailure());
          },
        },
        run: async () => "complete",
      });
      expect(result).toMatchObject(
        Result.ok({
          status: "degraded",
          degradation: { phase: "release", reason },
          value: "complete",
        }),
      );
      expect(
        logs.records.filter(
          ({ message }) => message === "mcp.public_read.admission_degraded",
        ),
      ).toHaveLength(1);
      expect(analytics.exceptions()).toHaveLength(1);
    } finally {
      analytics.restore();
      logs.restore();
    }
  });
}

test("degraded admission still honors caller cancellation", async () => {
  const analytics = installRecordingAnalytics();
  const logs = installRecordingLogger();
  const controller = new AbortController();
  const reason = new DOMException("Read cancelled", "AbortError");
  controller.abort(reason);
  let ran = false;
  try {
    const result = await withMcpPublicReadAdmission({
      caller,
      signal: controller.signal,
      redis: { send: async () => null },
      run: async () => {
        ran = true;
      },
    });
    expect(result).toEqual(Result.err(reason));
    expect(ran).toBe(false);
    expect(analytics.exceptions()).toHaveLength(1);
  } finally {
    analytics.restore();
    logs.restore();
  }
});

for (const reason of ["unavailable", "definite_loss"] as const) {
  test(`late renewal ${reason} is captured after completed work`, async () => {
    const analytics = installRecordingAnalytics();
    const logs = installRecordingLogger();
    const scheduled = Promise.withResolvers<() => void>();
    const entered = Promise.withResolvers<undefined>();
    const renewing = Promise.withResolvers<undefined>();
    const finishWork = Promise.withResolvers<undefined>();
    const finishRenewal = Promise.withResolvers<unknown>();
    const owner = withMcpPublicReadAdmission({
      caller,
      timing: {
        now: () => 0,
        schedule: (callback) => {
          scheduled.resolve(callback);
          return () => undefined;
        },
      },
      redis: {
        send: async (_command, args) => {
          if (args.at(0) !== RENEW_SCRIPT) {
            return 1;
          }
          renewing.resolve(undefined);
          return await finishRenewal.promise;
        },
      },
      run: async () => {
        entered.resolve(undefined);
        await finishWork.promise;
        return "complete";
      },
    });
    try {
      await entered.promise;
      const renew = await scheduled.promise;
      renew();
      await renewing.promise;
      finishWork.resolve(undefined);
      await setImmediate();
      if (reason === "unavailable") {
        finishRenewal.reject(privateFailure());
      } else {
        finishRenewal.resolve(0);
      }
      const result = await owner;
      expect(result).toMatchObject(
        Result.ok({
          status: reason === "unavailable" ? "degraded" : "leased",
          value: "complete",
        }),
      );
      expect(analytics.exceptions()).toHaveLength(1);
      const event =
        reason === "unavailable"
          ? "mcp.public_read.admission_degraded"
          : "mcp.public_read.lease_lost";
      expect(
        logs.records.filter(({ message }) => message === event),
      ).toHaveLength(1);
    } finally {
      finishWork.resolve(undefined);
      finishRenewal.resolve(1);
      await owner;
      analytics.restore();
      logs.restore();
    }
  });
}
