import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { ActionAdmissionError, withActionAdmission } from "./action-admission";
import type { AdmittedActionIdentity } from "./action-kinds";

const organizationId = toSafeId<"organization">("budget_org");
const userId = toSafeId<"user">("budget_user");
const policy = {
  organizationConcurrency: 2,
  userConcurrency: 2,
  leaseMs: 120_000,
};
const periodIdentity = {
  actionKind: "chat.improve-prompt",
  logicalPhaseId: "message:phase",
} as const satisfies AdmittedActionIdentity;
const periodPolicy = { periodMs: 86_400_000, limit: 2 };

const expectUnavailable = (result: Result<unknown, unknown>) => {
  expect(Result.isError(result)).toBe(true);
  if (Result.isOk(result)) {
    throw new Error("Expected rejection");
  }
  expect(ActionAdmissionError.is(result.error)).toBe(true);
  if (ActionAdmissionError.is(result.error)) {
    expect(result.error.reason).toBe("unavailable");
  }
};

describe("period admission boundary", () => {
  test("flag-off never connects, even with incomplete period configuration", async () => {
    let opened = false;
    const result = await withActionAdmission({
      organizationId,
      userId,
      enabled: false,
      periodPolicy,
      redisReady: async () => {
        opened = true;
        throw new Error("must not connect");
      },
      run: async () => "unchanged",
    });
    expect(result).toEqual(Result.ok("unchanged"));
    expect(opened).toBe(false);
  });

  test("configured periods reject missing phase identity before connecting", async () => {
    let opened = false;
    let ran = false;
    const result = await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy,
      periodPolicy,
      redisReady: async () => {
        opened = true;
        throw new Error("must not connect");
      },
      run: async () => {
        ran = true;
      },
    });
    expectUnavailable(result);
    expect(opened).toBe(false);
    expect(ran).toBe(false);
  });

  test("nested invalid identities fail closed before inherited lease reuse", async () => {
    for (const identity of [
      undefined,
      {
        actionKind: "chat.improve-prompt",
        logicalPhaseId: " ",
      } as const satisfies AdmittedActionIdentity,
    ]) {
      let acquisitions = 0;
      let nestedRan = false;
      const redis = {
        send: async (_command: string, args: string[]) => {
          if (args.at(0)?.includes("ZREMRANGEBYSCORE")) {
            acquisitions += 1;
          }
          return 1;
        },
      };
      const outer = await withActionAdmission({
        organizationId,
        userId,
        enabled: true,
        policy,
        periodPolicy,
        periodIdentity,
        redis,
        run: async () =>
          await withActionAdmission({
            organizationId,
            userId,
            enabled: true,
            policy,
            periodPolicy,
            redis,
            ...(identity === undefined ? {} : { periodIdentity: identity }),
            run: async () => {
              nestedRan = true;
            },
          }),
      });
      expect(Result.isOk(outer)).toBe(true);
      if (Result.isOk(outer)) {
        expectUnavailable(outer.value);
      }
      expect(nestedRan).toBe(false);
      expect(acquisitions).toBe(1);
    }
  });

  test("delayed acquisition retries one stale window using store time and the same phase", async () => {
    const acquisitions: string[][] = [];
    const result = await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy,
      periodPolicy,
      periodIdentity,
      redis: {
        send: async (_command, args) => {
          if (!args.at(0)?.includes("ZREMRANGEBYSCORE")) {
            return 1;
          }
          acquisitions.push(args);
          return acquisitions.length === 1 ? [-3, Number(args.at(10))] : 1;
        },
      },
      run: async () => "completed",
    });
    expect(result).toEqual(Result.ok("completed"));
    expect(acquisitions).toHaveLength(2);
    const first = acquisitions.at(0);
    const second = acquisitions.at(1);
    expect(second?.at(9)).toBe(first?.at(10));
    expect(second?.at(4)).not.toBe(first?.at(4));
    expect(second?.at(8)).toBe(first?.at(8));
    expect(second?.at(12)).toBe(first?.at(12));
  });

  test("a second stale reply fails closed without an acquisition loop", async () => {
    let acquisitions = 0;
    let ran = false;
    const result = await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy,
      periodPolicy,
      periodIdentity,
      redis: {
        send: async (_command, args) => {
          acquisitions += 1;
          return [-3, Number(args.at(10))];
        },
      },
      run: async () => {
        ran = true;
      },
    });
    expectUnavailable(result);
    expect(acquisitions).toBe(2);
    expect(ran).toBe(false);
  });

  test("store outage fails closed and does not execute tenant work", async () => {
    let ran = false;
    const result = await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy,
      periodPolicy,
      periodIdentity,
      redisReady: async () => {
        throw new Error("store unavailable");
      },
      run: async () => {
        ran = true;
      },
    });
    expectUnavailable(result);
    expect(ran).toBe(false);
  });

  test("nested finite handlers reuse the enclosing action admission without counting again", async () => {
    let acquisitions = 0;
    const redis = {
      send: async (_command: string, args: string[]) => {
        if (args.at(0)?.includes("ZREMRANGEBYSCORE")) {
          acquisitions += 1;
        }
        return 1;
      },
    };
    const result = await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy,
      periodPolicy,
      periodIdentity,
      redis,
      run: async () =>
        await withActionAdmission({
          organizationId,
          userId,
          enabled: true,
          policy,
          periodPolicy,
          redis,
          periodIdentity: {
            actionKind: "chat.suggest-thread-title",
            logicalPhaseId: "nested-request",
          },
          run: async () => "completed",
        }),
    });
    expect(result).toEqual(Result.ok(Result.ok("completed")));
    expect(acquisitions).toBe(1);
  });

  test("period exhaustion returns busy without executing the action", async () => {
    let ran = false;
    const result = await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy,
      periodPolicy,
      periodIdentity,
      redis: {
        send: async (_command, args) => {
          expect(args.at(1)).toBe("3");
          expect(args.at(4)).toContain("period:");
          return -1;
        },
      },
      run: async () => {
        ran = true;
      },
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("Expected period exhaustion");
    }
    expect(ActionAdmissionError.is(result.error)).toBe(true);
    if (ActionAdmissionError.is(result.error)) {
      expect(result.error.reason).toBe("busy");
    }
    expect(ran).toBe(false);
  });
});
