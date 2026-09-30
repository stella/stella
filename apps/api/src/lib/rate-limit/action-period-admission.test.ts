import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { ActionAdmissionError, withActionAdmission } from "./action-admission";

const organizationId = toSafeId<"organization">("budget_org");
const userId = toSafeId<"user">("budget_user");
const policy = {
  organizationConcurrency: 2,
  userConcurrency: 2,
  leaseMs: 120_000,
};
const periodIdentity = {
  actionKind: "chat.send",
  logicalPhaseId: "message:phase",
};
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
            actionKind: "nested.finite",
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
