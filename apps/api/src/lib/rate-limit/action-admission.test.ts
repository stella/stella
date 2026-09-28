import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  ActionAdmissionError,
  withActionAdmission,
} from "@/api/lib/rate-limit/action-admission";

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

const failureOf = async (operation: Promise<unknown>) => {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("Expected admission to fail");
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
    expect(await admitted).toBe("served");
    expect(commands).toBeGreaterThan(0);
  });

  test("disabled admission preserves the handler result without touching coordination", async () => {
    const result = await withActionAdmission({
      organizationId,
      userId: firstUser,
      enabled: false,
      redis: {
        send: async () => {
          throw new Error("Disabled admission touched coordination");
        },
      },
      run: async () => ({ status: "served" }),
    });
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
    await Promise.all([firstCall, secondCall]);
    expect(
      await withActionAdmission({
        ...common,
        userId: firstUser,
        createId: () => "after-release",
        run: async () => "served",
      }),
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
      await withActionAdmission({
        ...common,
        createId: () => "retry",
        run: async () => "served",
      }),
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
      await withActionAdmission({
        ...common,
        createId: () => "new",
        run: async () => "served",
      }),
    ).toBe("served");
    pending.finish();
    await firstCall;
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
    await firstCall;
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
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    });
    await started.promise;
    await timing.fireNext();
    expect(await failureOf(admitted)).toMatchObject({ reason: "unavailable" });
    expect(observedAbort).toBe(true);
  });
});
