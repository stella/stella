import { Result } from "better-result";
import { describe, expect, expectTypeOf, test } from "bun:test";

import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";

import {
  ActionAdmissionError,
  withActionAdmission,
  reserveQueuedKickoffPeriod,
} from "./action-admission";
import { BACKGROUND_ACTION_KIND } from "./action-kinds";

const organizationId = toSafeId<"organization">("background_org");
const userId = toSafeId<"user">("background_user");
const policy = {
  organizationConcurrency: 2,
  userConcurrency: 2,
  leaseMs: 120_000,
};

describe("background action admission", () => {
  test("requires a classified background kind without a period identity", () => {
    type AdmissionOptions = Parameters<typeof withActionAdmission>[0];
    type BackgroundOptions = Extract<
      AdmissionOptions,
      { execution: "background-job" }
    >;
    expectTypeOf<
      Omit<BackgroundOptions, "actionKind">
    >().not.toExtend<AdmissionOptions>();
    expectTypeOf<
      Omit<BackgroundOptions, "periodIdentity"> & {
        periodIdentity: {
          actionKind: "workflow.start";
          logicalPhaseId: string;
        };
      }
    >().not.toExtend<AdmissionOptions>();
  });
  test("uses its separate two-key pool without period accounting", async () => {
    for (const actionKind of Object.values(BACKGROUND_ACTION_KIND)) {
      const calls: string[][] = [];
      const redis = {
        send: async (_command: string, args: string[]) => {
          calls.push(args);
          return 1;
        },
      };

      const result = await withActionAdmission({
        organizationId,
        userId,
        enabled: true,
        policy,
        execution: "background-job",
        serviceBudgetsEnabled: true,
        readOrganizationState: async () => {
          throw new Error(
            "Background leases must not read organization budgets",
          );
        },
        actionKind,
        periodPolicy: { periodMs: 86_400_000, limit: 1 },
        redis,
        run: async () => "done",
      });

      expect(result).toEqual(Result.ok("done"));
      const acquire = calls.find((args) =>
        args.at(0)?.includes("ZREMRANGEBYSCORE"),
      );
      expect(acquire?.at(1)).toBe("2");
      expect(acquire?.at(2)).toContain("background:organization");
      expect(acquire?.at(3)).toContain("background:user:");
      expect(acquire?.some((arg) => arg.includes(":period:"))).toBe(false);
    }
  });

  test("a nested kickoff at cap one reuses its lease and reserves one run", async () => {
    let active = 0;
    let acquisitions = 0;
    let reservations = 0;
    let releases = 0;
    const redis = {
      send: async (_command: string, args: string[]) => {
        const script = args.at(0) ?? "";
        if (script.includes("ZREMRANGEBYSCORE")) {
          if (active === 1) {
            return 0;
          }
          active += 1;
          acquisitions += 1;
          return 1;
        }
        if (script.includes("HEXISTS")) {
          expect(active).toBe(1);
          reservations += 1;
          return 1;
        }
        if (script.includes("ZREM")) {
          active -= 1;
          releases += 1;
        }
        return 1;
      },
    };
    const singlePolicy = {
      organizationConcurrency: 1,
      userConcurrency: 1,
      leaseMs: 120_000,
    };
    const outer = await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy: singlePolicy,
      redis,
      run: async () =>
        await withActionAdmission({
          organizationId,
          userId,
          enabled: true,
          policy: singlePolicy,
          redis,
          execution: "queued-kickoff",
          periodIdentity: {
            actionKind: "workflow.start",
            logicalPhaseId: "server-run-1",
          },
          periodPolicy: { periodMs: 86_400_000, limit: 10 },
          run: async () => {
            expect(active).toBe(1);
            expect(releases).toBe(0);
            return "queued";
          },
        }),
    });
    expect(outer).toEqual(Result.ok(Result.ok("queued")));
    expect(acquisitions).toBe(1);
    expect(reservations).toBe(1);
    expect(releases).toBe(1);
  });

  test("a refused nested period reservation returns an error without starting work", async () => {
    for (const reply of [-1, -2] as const) {
      let acquisitions = 0;
      let releases = 0;
      let executions = 0;
      const redis = {
        send: async (_command: string, args: string[]) => {
          const script = args.at(0) ?? "";
          if (script.includes("ZREMRANGEBYSCORE")) {
            acquisitions += 1;
            return 1;
          }
          if (script.includes("HEXISTS")) {
            return reply;
          }
          if (script.includes('redis.call("ZREM",')) {
            releases += 1;
          }
          return 1;
        },
      };
      const parent = await withActionAdmission({
        organizationId,
        userId,
        enabled: true,
        policy,
        redis,
        run: async () =>
          await withActionAdmission({
            organizationId,
            userId,
            enabled: true,
            redis,
            execution: "queued-kickoff",
            periodIdentity: {
              actionKind: "workflow.start",
              logicalPhaseId: `refused-run-${reply}`,
            },
            periodPolicy: { periodMs: 86_400_000, limit: 10 },
            run: async () => {
              executions += 1;
            },
          }),
      });
      expect(Result.isOk(parent)).toBe(true);
      const nested = parent.unwrap();
      expect(Result.isError(nested)).toBe(true);
      if (Result.isError(nested)) {
        expect(nested.error).toBeInstanceOf(ActionAdmissionError);
        expect(nested.error).toMatchObject({
          reason: reply === -1 ? "period_exhausted" : "unavailable",
        });
      }
      expect(executions).toBe(0);
      expect(acquisitions).toBe(1);
      expect(releases).toBe(1);
    }
  });

  test("an explicit background job nested inside the same pool acquires a fresh lease", async () => {
    const acquisitions: string[][] = [];
    const redis = {
      send: async (_command: string, args: string[]) => {
        if (args.at(0)?.includes("ZREMRANGEBYSCORE")) {
          acquisitions.push(args);
        }
        return 1;
      },
    };

    const outer = await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy,
      execution: "background-job",
      actionKind: BACKGROUND_ACTION_KIND.extraction,
      redis,
      run: async () =>
        await withActionAdmission({
          organizationId,
          userId,
          enabled: true,
          policy,
          execution: "background-job",
          actionKind: BACKGROUND_ACTION_KIND.extraction,
          redis,
          run: async () => "nested background",
        }),
    });

    expect(Result.isOk(outer)).toBe(true);
    if (Result.isOk(outer)) {
      expect(outer.value).toEqual(Result.ok("nested background"));
    }
    expect(acquisitions).toHaveLength(2);
    expect(
      acquisitions.every((args) =>
        args.at(2)?.includes("background:organization"),
      ),
    ).toBe(true);
  });

  test("queued kickoff fails closed without a configured period", async () => {
    let ran = false;
    const result = await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy,
      execution: "queued-kickoff",
      periodIdentity: {
        actionKind: "workflow.start",
        logicalPhaseId: "server-run-1",
      },
      redisReady: async () => {
        throw new Error("admission store should not be opened");
      },
      run: async () => {
        ran = true;
      },
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ reason: "unavailable" });
    }
    expect(ran).toBe(false);
  });
  test("a deferred kickoff reserves only at the accepted transaction boundary", async () => {
    const previous = env.FEATURE_ACTION_ADMISSION;
    env.FEATURE_ACTION_ADMISSION = true;
    try {
      for (const outcome of ["capped", "accepted"] as const) {
        let reservations = 0;
        const redis = {
          send: async (_command: string, args: string[]) => {
            const script = args.at(0) ?? "";
            if (script.includes("ZREMRANGEBYSCORE")) {
              expect(args.at(1)).toBe("2");
            } else if (script.includes("HEXISTS")) {
              expect(args.at(1)).toBe("3");
              reservations += 1;
            }
            return 1;
          },
        };
        const result = await withActionAdmission({
          organizationId,
          userId,
          enabled: true,
          policy,
          redis,
          execution: "queued-kickoff",
          periodReservation: "on-acceptance",
          periodIdentity: {
            actionKind: "flow.start",
            logicalPhaseId: `server-run-${outcome}`,
          },
          periodPolicy: { periodMs: 86_400_000, limit: 10 },
          run: async () => {
            expect(reservations).toBe(0);
            if (outcome === "accepted") {
              expect(await reserveQueuedKickoffPeriod()).toEqual(
                Result.ok(undefined),
              );
            }
            return outcome;
          },
        });
        expect(result).toEqual(Result.ok(outcome));
        expect(reservations).toBe(outcome === "accepted" ? 1 : 0);
      }
    } finally {
      env.FEATURE_ACTION_ADMISSION = previous;
    }
  });
});
