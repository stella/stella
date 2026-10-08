import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  ActionAdmissionError,
  withActionAdmission,
} from "@/api/lib/rate-limit/action-admission";
import type { ActionCostObservation } from "@/api/lib/usage/action-costs/context";

test("pending action admission retains its organization and execution callback", async () => {
  const entered = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  const observedOrganizations: string[] = [];
  const acquisitionKeys: string[] = [];
  const options = {
    enabled: true,
    organizationId,
    userId: firstUser,
    policy: { ...policy },
    periodIdentity: {
      actionKind: "chat.send",
      logicalPhaseId: "original-phase",
    },
    costRecorder: {
      enqueue: (observation: ActionCostObservation) => {
        observedOrganizations.push(observation.record.organizationId);
      },
      estimate: () => 0,
      callRate: () => 0,
    },
    redis: {
      send: async (_command: string, args: string[]) => {
        if (args.at(0)?.includes("ZREMRANGEBYSCORE")) {
          acquisitionKeys.push(args.at(2) ?? "missing");
          entered.resolve(undefined);
          await proceed.promise;
        }
        return 1;
      },
    },
    run: async () => await Promise.resolve("original"),
  } satisfies Parameters<typeof withActionAdmission>[0];
  const admitted = withActionAdmission(options);
  await entered.promise;
  options.organizationId = toSafeId<"organization">("org_changed");
  options.periodIdentity.logicalPhaseId = "changed-phase";
  options.run = async () => await Promise.resolve("changed");
  proceed.resolve(undefined);
  expect(await admitted).toEqual(Result.ok("original"));
  expect(acquisitionKeys).toHaveLength(1);
  expect(acquisitionKeys.at(0)).toContain("org_a");
  expect(observedOrganizations).toEqual([organizationId, organizationId]);
});

test("period exhaustion has its own non-transient code before execution", async () => {
  let calls = 0;
  const refusal = await failureOf(
    withActionAdmission({
      enabled: true,
      organizationId,
      userId: firstUser,
      policy,
      periodPolicy: { periodMs: 86_400_000, limit: 3 },
      periodIdentity: {
        actionKind: "chat.improve-prompt",
        logicalPhaseId: "exhausted-phase",
      },
      redis: { send: async () => -1 },
      run: async () => {
        calls += 1;
      },
    }),
  );
  expect(refusal).toMatchObject({
    reason: "period_exhausted",
    code: "action_period_exhausted",
  });
  expect(calls).toBe(0);
});

const policy = {
  organizationConcurrency: 2,
  userConcurrency: 1,
  leaseMs: 120_000,
};

const organizationId = toSafeId<"organization">("org_a");
const firstUser = toSafeId<"user">("user_a");
const secondUser = toSafeId<"user">("user_b");

const deferred = () => {
  let finish: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
};

const failureOf = async (operation: Promise<Result<unknown, unknown>>) => {
  const result = await operation;
  if (Result.isError(result)) {
    return result.error;
  }
  throw new Error("Expected admission to fail");
};

const valueOf = async <T>(operation: Promise<Result<T, unknown>>) => {
  const result = await operation;
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

// Separate caller instances share this one command boundary, as separate API
// processes do when they connect to the same coordination service.
const sharedRedis = ({
  onRenew,
}: {
  onRenew?: () => Promise<0 | 1 | undefined>;
} = {}) => {
  const leases = new Map<string, Map<string, number>>();
  let currentTime = 0;
  const members = (key: string) => {
    let entry = leases.get(key);
    if (entry === undefined) {
      entry = new Map();
      leases.set(key, entry);
    }
    return entry;
  };
  return {
    setTime: (time: number) => {
      currentTime = time;
    },
    send: async (command: string, args: string[]) => {
      expect(command).toBe("EVAL");
      const [script, , organizationKey, userKey, ...values] = args;
      if (!script || !organizationKey || !userKey) {
        throw new Error("Incomplete admission command");
      }
      const organization = members(organizationKey);
      const user = members(userKey);
      if (script.includes("ZREMRANGEBYSCORE")) {
        const [leaseMs, orgMax, userMax, leaseId] = values;
        if (!leaseId) {
          throw new Error("Missing lease identity");
        }
        for (const pool of [organization, user]) {
          for (const [id, expiry] of pool) {
            if (expiry <= currentTime) {
              pool.delete(id);
            }
          }
        }
        if (
          organization.size >= Number(orgMax) ||
          user.size >= Number(userMax)
        ) {
          return 0;
        }
        organization.set(leaseId, currentTime + Number(leaseMs));
        user.set(leaseId, currentTime + Number(leaseMs));
        return 1;
      }
      if (script.includes("ZSCORE")) {
        const response = await onRenew?.();
        if (response === 0) {
          return 0;
        }
        const [leaseId, leaseMs] = values;
        if (!leaseId || !organization.has(leaseId) || !user.has(leaseId)) {
          return 0;
        }
        organization.set(leaseId, currentTime + Number(leaseMs));
        user.set(leaseId, currentTime + Number(leaseMs));
        return 1;
      }
      const [leaseId] = values;
      if (leaseId) {
        organization.delete(leaseId);
        user.delete(leaseId);
      }
      return 1;
    },
  };
};

const manualTiming = (redis: ReturnType<typeof sharedRedis>) => {
  let currentTime = 0;
  let next: { at: number; callback: () => void } | null = null;
  return {
    now: () => currentTime,
    schedule: (callback: () => void, delayMs: number) => {
      const scheduled = { at: currentTime + delayMs, callback };
      next = scheduled;
      return () => {
        if (next === scheduled) {
          next = null;
        }
      };
    },
    fireNext: async () => {
      const scheduled = next;
      if (scheduled === null) {
        throw new Error("No renewal scheduled");
      }
      next = null;
      currentTime = scheduled.at;
      redis.setTime(currentTime);
      scheduled.callback();
      await Bun.sleep(0);
    },
    setTime: (time: number) => {
      currentTime = time;
      redis.setTime(time);
    },
  };
};

describe("shared action admission", () => {
  test("nested calls for the same caller share one lease and signal", async () => {
    const redis = sharedRedis();
    let acquisitions = 0;
    let releases = 0;
    const countedRedis = {
      send: async (command: string, args: string[]) => {
        if (args.at(0)?.includes("ZREMRANGEBYSCORE")) {
          acquisitions += 1;
        }
        if (args.at(0)?.includes('redis.call("ZREM",')) {
          releases += 1;
        }
        return await redis.send(command, args);
      },
    };
    const result = await valueOf(
      withActionAdmission({
        enabled: true,
        organizationId,
        userId: firstUser,
        policy,
        redis: countedRedis,
        run: async (outerSignal) =>
          await valueOf(
            withActionAdmission({
              enabled: true,
              organizationId,
              userId: firstUser,
              redisReady: async () => {
                throw new Error("Nested call opened coordination");
              },
              run: async (signal) => {
                expect(signal).toBe(outerSignal);
                return "served";
              },
            }),
          ),
      }),
    );
    expect(result).toBe("served");
    expect(acquisitions).toBe(1);
    expect(releases).toBe(1);
  });

  test("nested calls with a different user or organization acquire their own lease", async () => {
    const redis = sharedRedis();
    const otherOrg = toSafeId<"organization">("org_b");
    const common = { enabled: true, policy, redis };
    const outcome = await valueOf(
      withActionAdmission({
        ...common,
        organizationId,
        userId: firstUser,
        run: async (outerSignal) => {
          for (const identity of [
            { organizationId, userId: secondUser },
            { organizationId: otherOrg, userId: firstUser },
          ]) {
            expect(
              await valueOf(
                withActionAdmission({
                  ...common,
                  ...identity,
                  run: async (signal) => {
                    expect(signal).not.toBe(outerSignal);
                    return await failureOf(
                      withActionAdmission({
                        ...common,
                        ...identity,
                        userId: firstUser,
                        organizationId,
                        run: async () => "unexpected",
                      }),
                    );
                  },
                }),
              ),
            ).toMatchObject({ reason: "busy" });
          }
          return "served";
        },
      }),
    );
    expect(outcome).toBe("served");
  });

  test("disabled nested admission ignores coordination and the inherited signal", async () => {
    const redis = sharedRedis();
    await valueOf(
      withActionAdmission({
        enabled: true,
        organizationId,
        userId: firstUser,
        policy,
        redis,
        run: async (outerSignal) =>
          await valueOf(
            withActionAdmission({
              enabled: false,
              organizationId,
              userId: firstUser,
              redisReady: async () => {
                throw new Error("Disabled call opened coordination");
              },
              run: async (signal) => {
                expect(signal).not.toBe(outerSignal);
                return "served";
              },
            }),
          ),
      }),
    );
  });

  test("lease loss aborts the inherited signal without replacing a settled and charged result", async () => {
    const redis = sharedRedis({ onRenew: async () => 0 });
    const timing = manualTiming(redis);
    const started = deferred();
    const pending = deferred();
    let charges = 0;
    const admitted = withActionAdmission({
      enabled: true,
      organizationId,
      userId: firstUser,
      policy: { ...policy, leaseMs: 100 },
      redis,
      timing,
      run: async (outerSignal) =>
        await valueOf(
          withActionAdmission({
            enabled: true,
            organizationId,
            userId: firstUser,
            run: async (signal) => {
              expect(signal).toBe(outerSignal);
              charges += 1;
              started.finish();
              await pending.promise;
              expect(signal.aborted).toBe(true);
              return "completed";
            },
          }),
        ),
    });
    await started.promise;
    await timing.fireNext();
    pending.finish();
    expect(await valueOf(admitted)).toBe("completed");
    expect(charges).toBe(1);
  });

  test("work continuing after its enclosing call finishes cannot reuse a released lease", async () => {
    const redis = sharedRedis();
    const proceed = deferred();
    const detached = Promise.withResolvers<Result<string, unknown>>();
    let acquisitions = 0;
    const common = {
      enabled: true,
      organizationId,
      userId: firstUser,
      policy,
      redis: {
        send: async (command: string, args: string[]) => {
          if (args.at(0)?.includes("ZREMRANGEBYSCORE")) {
            acquisitions += 1;
          }
          return await redis.send(command, args);
        },
      },
    };
    await valueOf(
      withActionAdmission({
        ...common,
        run: async () => {
          detached.resolve(
            (async () => {
              await proceed.promise;
              return await withActionAdmission({
                ...common,
                run: async () => "served",
              });
            })(),
          );
        },
      }),
    );
    expect(acquisitions).toBe(1);
    proceed.finish();
    expect(await valueOf(detached.promise)).toBe("served");
    expect(acquisitions).toBe(2);
  });

  test("waits for the shared connection before sending a command", async () => {
    const redis = sharedRedis();
    const connected = Promise.withResolvers<typeof redis>();
    let commands = 0;
    const admitted = withActionAdmission({
      enabled: true,
      organizationId,
      userId: firstUser,
      policy,
      redisReady: async () => await connected.promise,
      run: async () => "served",
    });
    await Promise.resolve();
    expect(commands).toBe(0);
    connected.resolve({
      ...redis,
      send: async (command, args) => {
        commands += 1;
        return await redis.send(command, args);
      },
    });
    expect(await valueOf(admitted)).toBe("served");
    expect(commands).toBeGreaterThan(0);
  });

  test("disabled admission preserves the handler result without touching coordination", async () => {
    const result = await valueOf(
      withActionAdmission({
        organizationId,
        userId: firstUser,
        enabled: false,
        redis: {
          send: async () => {
            throw new Error("Disabled admission touched coordination");
          },
        },
        run: async () => ({ status: "served" }),
      }),
    );
    expect(result).toEqual({ status: "served" });
  });

  test("caller instances enforce both organization and user concurrency", async () => {
    const redis = sharedRedis();
    const first = deferred();
    const second = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const common = { enabled: true, organizationId, policy, redis };
    const firstCall = withActionAdmission({
      ...common,
      userId: firstUser,
      createId: () => "first",
      run: async () => {
        firstStarted.finish();
        await first.promise;
      },
    });
    await firstStarted.promise;
    expect(
      await failureOf(
        withActionAdmission({
          ...common,
          userId: firstUser,
          createId: () => "same-user",
          run: async () => "unexpected",
        }),
      ),
    ).toMatchObject({ reason: "busy" });
    const secondCall = withActionAdmission({
      ...common,
      userId: secondUser,
      createId: () => "second",
      run: async () => {
        secondStarted.finish();
        await second.promise;
      },
    });
    await secondStarted.promise;
    expect(
      await failureOf(
        withActionAdmission({
          ...common,
          userId: toSafeId<"user">("user_c"),
          createId: () => "third",
          run: async () => "unexpected",
        }),
      ),
    ).toMatchObject({ reason: "busy" });
    first.finish();
    second.finish();
    await Promise.all([valueOf(firstCall), valueOf(secondCall)]);
    expect(
      await valueOf(
        withActionAdmission({
          ...common,
          userId: firstUser,
          createId: () => "after-release",
          run: async () => "served",
        }),
      ),
    ).toBe("served");
  });

  test("a failed action releases its lease", async () => {
    const redis = sharedRedis();
    const common = {
      enabled: true,
      organizationId,
      userId: firstUser,
      policy,
      redis,
    };
    const failure = new ActionAdmissionError({
      message: "Action failed",
      reason: "unavailable",
    });
    expect(
      await failureOf(
        withActionAdmission({
          ...common,
          createId: () => "failed",
          run: async () => {
            throw failure;
          },
        }),
      ),
    ).toBe(failure);
    expect(
      await valueOf(
        withActionAdmission({
          ...common,
          createId: () => "retry",
          run: async () => "served",
        }),
      ),
    ).toBe("served");
  });

  test("expired leases cease to occupy a shared slot", async () => {
    const redis = sharedRedis();
    const pending = deferred();
    const started = deferred();
    const common = {
      enabled: true,
      organizationId,
      userId: firstUser,
      policy,
      redis,
    };
    const firstCall = withActionAdmission({
      ...common,
      createId: () => "orphan",
      run: async () => {
        started.finish();
        await pending.promise;
      },
    });
    await started.promise;
    redis.setTime(policy.leaseMs);
    expect(
      await valueOf(
        withActionAdmission({
          ...common,
          createId: () => "new",
          run: async () => "served",
        }),
      ),
    ).toBe("served");
    pending.finish();
    await valueOf(firstCall);
  });

  test("a transient renewal failure retries before the lease expires", async () => {
    let renewalAttempts = 0;
    const redis = sharedRedis({
      onRenew: async () => {
        renewalAttempts += 1;
        if (renewalAttempts === 1) {
          throw new Error("Transient connection failure");
        }
        return 1;
      },
    });
    const timing = manualTiming(redis);
    const pending = deferred();
    const started = deferred();
    const common = {
      enabled: true,
      organizationId,
      userId: firstUser,
      policy: { ...policy, leaseMs: 100 },
      redis,
      timing,
    };
    const firstCall = withActionAdmission({
      ...common,
      createId: () => "first",
      run: async (signal) => {
        started.finish();
        await pending.promise;
        expect(signal.aborted).toBe(false);
      },
    });
    await started.promise;
    await timing.fireNext();
    await timing.fireNext();
    expect(renewalAttempts).toBe(2);
    timing.setTime(100);
    expect(
      await failureOf(
        withActionAdmission({
          ...common,
          createId: () => "second",
          run: async () => "unexpected",
        }),
      ),
    ).toMatchObject({ reason: "busy" });
    pending.finish();
    await valueOf(firstCall);
  });

  test("a missing lease aborts and fails the admitted action", async () => {
    const redis = sharedRedis({ onRenew: async () => 0 });
    const timing = manualTiming(redis);
    const started = deferred();
    let observedAbort = false;
    const admitted = withActionAdmission({
      enabled: true,
      organizationId,
      userId: firstUser,
      policy: { ...policy, leaseMs: 100 },
      redis,
      timing,
      run: async (signal) => {
        started.finish();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(new DOMException("Action aborted", "AbortError"));
            },
            { once: true },
          );
        });
      },
    });
    const failure = failureOf(admitted);
    await started.promise;
    await timing.fireNext();
    expect(await failure).toMatchObject({ reason: "unavailable" });
    expect(observedAbort).toBe(true);
  });
  for (const failureKind of [
    "signal-reason",
    "abort-error",
    "handler-error",
  ] as const) {
    test(`lease loss preserves error identity for ${failureKind}`, async () => {
      const redis = sharedRedis({ onRenew: async () => 0 });
      const timing = manualTiming(redis);
      const started = deferred();
      const pending = deferred();
      const conflict = new HandlerError({
        status: 409,
        message: "The resource changed",
      });
      const admitted = withActionAdmission({
        enabled: true,
        organizationId,
        userId: firstUser,
        policy: { ...policy, leaseMs: 100 },
        redis,
        timing,
        run: async (signal) => {
          started.finish();
          await pending.promise;
          expect(signal.aborted).toBe(true);
          switch (failureKind) {
            case "signal-reason":
              throw signal.reason;
            case "abort-error":
              throw new DOMException("Action aborted", "AbortError");
            case "handler-error":
              throw conflict;
          }
        },
      });
      const failure = failureOf(admitted);
      await started.promise;
      await timing.fireNext();
      pending.finish();
      const error = await failure;
      if (failureKind === "handler-error") {
        expect(error).toBe(conflict);
        expect(error).toMatchObject({ status: 409 });
      } else {
        expect(ActionAdmissionError.is(error)).toBe(true);
        expect(error).toMatchObject({ reason: "unavailable" });
      }
    });
  }
});
