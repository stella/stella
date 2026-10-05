import { Value } from "@sinclair/typebox/value";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  ACTION_ADMISSION_CODES,
  type ActionAdmissionCode,
} from "@stll/api-contract/action-admission";
import { assertProperty } from "@stll/property-testing";

import { ORGANIZATION_ACCESS_STATE } from "@/api/db/schema";
import {
  reportExportBodySchema,
  reportExportConsumesServices,
} from "@/api/handlers/reports/views/export-input";
import { toSafeId } from "@/api/lib/branded-types";
import type { ActionCostObservation } from "@/api/lib/usage/action-costs/context";
import { FREE_TIER_OFF } from "@/api/lib/usage/organization-access";
import type { OrganizationAccessSnapshot } from "@/api/lib/usage/organization-access-snapshot";
import {
  ORGANIZATION_MODEL_CREDENTIALS,
  type OrganizationActionState,
} from "@/api/lib/usage/organization-action-budget";
import { mcpActionPeriodIdentity } from "@/api/mcp/action-admission-identity";

import { withActionAdmission } from "./action-admission";
import {
  ACTION_KINDS,
  ACTION_SERVICE_CREDENTIALS,
  type AdmittedActionIdentity,
  type PeriodActionKind,
} from "./action-kinds";
import {
  ACTION_SERVICE_DEADLINE_EXPIRED,
  ACTION_SERVICE_DEADLINE_SCRIPT,
} from "./action-period-budget";

const organizationId = toSafeId<"organization">("service_budget_org");
const userId = toSafeId<"user">("service_budget_user");

const actionState = (
  snapshot: OrganizationAccessSnapshot | undefined,
): OrganizationActionState => ({
  snapshot,
  freeTier: FREE_TIER_OFF,
  modelCredentials: ORGANIZATION_MODEL_CREDENTIALS.managed,
});
const nowMs = Date.UTC(2026, 9, 1, 12, 30);
const policy = {
  organizationConcurrency: 2,
  userConcurrency: 2,
  leaseMs: 120_000,
};
const serviceBudgetConfig = {
  periodMs: 86_400_000,
  evaluationActions: 7,
  selfManagedActions: 19,
};
const periodIdentity = {
  actionKind: "chat.improve-prompt",
  logicalPhaseId: "phase",
} as const satisfies AdmittedActionIdentity;

const expectRefusal = (
  result: Result<unknown, unknown>,
  code: ActionAdmissionCode,
) => {
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error).toMatchObject({ code });
  }
};

const recordingRedis = () => {
  const commands: string[][] = [];
  return {
    commands,
    client: {
      send: async (_command: string, args: string[]) => {
        commands.push(args);
        return 1;
      },
    },
  };
};

describe("organization budgets at action admission", () => {
  test("queued reservations resolve organization budgets at acceptance on fresh and inherited leases", async () => {
    for (const ownership of ["fresh", "inherited"] as const) {
      for (const acceptance of ["capped", "accepted", "expired"] as const) {
        const redis = recordingRedis();
        let reads = 0;
        let now = nowMs;
        const identity = {
          actionKind: "flow.start",
          logicalPhaseId: "queued-phase",
        } as const satisfies AdmittedActionIdentity;
        const queued = async () =>
          await withActionAdmission({
            organizationId,
            userId,
            enabled: true,
            policy,
            execution: "queued-kickoff",
            periodReservation: "on-acceptance",
            periodIdentity: identity,
            serviceBudgetsEnabled: true,
            serviceBudgetConfig,
            budgetNow: () => now,
            readOrganizationState: async () => {
              reads += 1;
              return actionState({
                state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
                evaluationEndsAt: new Date(nowMs + 1000),
              });
            },
            redis: redis.client,
            run: async (_signal, control) => {
              expect(
                redis.commands.filter((args) => args.at(1) === "3"),
              ).toHaveLength(0);
              if (acceptance === "capped") {
                return "capped";
              }
              if (acceptance === "expired") {
                now += 2000;
              }
              const reserved = await control.reservePeriod(identity);
              if (Result.isError(reserved)) {
                throw reserved.error;
              }
              expect(await control.reservePeriod(identity)).toEqual(
                Result.ok(undefined),
              );
              return "accepted";
            },
          });
        const result =
          ownership === "fresh"
            ? await queued()
            : (
                await withActionAdmission({
                  organizationId,
                  userId,
                  enabled: true,
                  policy,
                  mode: "concurrency-only",
                  redis: redis.client,
                  run: queued,
                })
              ).unwrap();
        if (acceptance === "expired") {
          expectRefusal(result, ACTION_ADMISSION_CODES.notEnabled);
        } else {
          expect(result).toEqual(Result.ok(acceptance));
        }
        expect(reads).toBe(acceptance === "capped" ? 1 : 2);
        expect(
          redis.commands.filter((args) => args.at(1) === "3"),
        ).toHaveLength(acceptance === "accepted" ? 1 : 0);
        expect(
          redis.commands.filter((args) =>
            args.at(0)?.includes("ZREMRANGEBYSCORE"),
          ),
        ).toHaveLength(1);
      }
    }
  });

  test("validated raw DOCX and PDF reports remain exportable after evaluation ends", async () => {
    for (const format of ["docx", "pdf"] as const) {
      for (const aiNarrative of [false, true, undefined]) {
        const body = {
          templateRef: { type: "builtin", key: "report" },
          viewId: "00000000-0000-4000-8000-000000000001",
          mode: "download",
          format,
          ...(aiNarrative === undefined ? {} : { aiNarrative }),
        };
        expect(Value.Check(reportExportBodySchema, body)).toBe(true);
        const consumesServices = reportExportConsumesServices({
          body,
          params: {},
          query: {},
        });
        const redis = recordingRedis();
        let stateReads = 0;
        let runs = 0;
        const result = await withActionAdmission({
          organizationId,
          userId,
          enabled: true,
          policy,
          serviceBudgetsEnabled: true,
          serviceBudgetConfig,
          periodIdentity: mcpActionPeriodIdentity(consumesServices),
          budgetNow: () => nowMs,
          readOrganizationState: async () => {
            stateReads += 1;
            return actionState({
              state: ORGANIZATION_ACCESS_STATE.evaluationEnded,
              evaluationEndsAt: new Date(nowMs - 1),
            });
          },
          redis: redis.client,
          run: async () => {
            runs += 1;
            return format;
          },
        });
        if (aiNarrative === false) {
          expect(result).toEqual(Result.ok(format));
          expect(stateReads).toBe(0);
          expect(runs).toBe(1);
          expect(redis.commands).toHaveLength(2);
          expect(redis.commands.at(0)?.at(1)).toBe("2");
          continue;
        }
        expectRefusal(result, ACTION_ADMISSION_CODES.notEnabled);
        expect(stateReads).toBe(1);
        expect(runs).toBe(0);
        expect(redis.commands).toHaveLength(0);
      }
    }
  });

  test("nested service admission validates phase identity without rereading organization state", async () => {
    for (const identity of [
      undefined,
      { actionKind: "chat.improve-prompt", logicalPhaseId: " " },
    ] satisfies (AdmittedActionIdentity | undefined)[]) {
      const redis = recordingRedis();
      let reads = 0;
      let nestedRuns = 0;
      const options = {
        organizationId,
        userId,
        enabled: true,
        policy,
        serviceBudgetsEnabled: true,
        serviceBudgetConfig,
        budgetNow: () => nowMs,
        readOrganizationState: async () => {
          reads += 1;
          return actionState({
            state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
            evaluationEndsAt: new Date(nowMs + 1),
          });
        },
        redis: redis.client,
      };
      const result = await withActionAdmission({
        ...options,
        periodIdentity,
        run: async () =>
          await withActionAdmission({
            ...options,
            ...(identity === undefined ? {} : { periodIdentity: identity }),
            run: async () => {
              nestedRuns += 1;
            },
          }),
      });
      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expectRefusal(
          result.value,
          ACTION_ADMISSION_CODES.admissionUnavailable,
        );
      }
      expect(reads).toBe(1);
      expect(nestedRuns).toBe(0);
      expect(redis.commands).toHaveLength(2);
    }
  });

  test("already admitted nested work crosses expiry without rereading or recounting", async () => {
    const redis = recordingRedis();
    let now = nowMs;
    let reads = 0;
    const options = {
      organizationId,
      userId,
      enabled: true,
      policy,
      serviceBudgetsEnabled: true,
      serviceBudgetConfig,
      periodIdentity,
      budgetNow: () => now,
      readOrganizationState: async () => {
        reads += 1;
        return actionState({
          state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
          evaluationEndsAt: new Date(nowMs + 1),
        });
      },
      redis: redis.client,
    };
    const result = await withActionAdmission({
      ...options,
      run: async (signal) => {
        now = nowMs + 1;
        return await withActionAdmission({
          ...options,
          run: async (nestedSignal) => {
            expect(nestedSignal).toBe(signal);
            return "continued admitted work";
          },
        });
      },
    });
    expect(result).toEqual(Result.ok(Result.ok("continued admitted work")));
    expect(reads).toBe(1);
    expect(redis.commands).toHaveLength(2);
  });

  test("evaluation deadline reaches atomic acquisition and survives a stale-window retry", async () => {
    const midnight = Date.UTC(2026, 9, 2);
    for (const staleRetry of [false, true]) {
      const admissionTime = staleRetry ? midnight - 2 : nowMs;
      const deadline = admissionTime + 1;
      const commands: string[][] = [];
      let runs = 0;
      const result = await withActionAdmission({
        organizationId,
        userId,
        enabled: true,
        policy,
        serviceBudgetsEnabled: true,
        serviceBudgetConfig,
        periodIdentity,
        budgetNow: () => admissionTime,
        readOrganizationState: async () =>
          actionState({
            state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
            evaluationEndsAt: new Date(deadline),
          }),
        redis: {
          send: async (_command, args) => {
            commands.push(args);
            const script = args.at(0);
            expect(script).toContain(ACTION_SERVICE_DEADLINE_SCRIPT);
            if (script === undefined) {
              throw new Error("Missing acquisition script");
            }
            expect(script.indexOf(ACTION_SERVICE_DEADLINE_SCRIPT)).toBeLessThan(
              script.indexOf('redis.call("ZREMRANGEBYSCORE"'),
            );
            expect(script.indexOf(ACTION_SERVICE_DEADLINE_SCRIPT)).toBeLessThan(
              script.indexOf('redis.call("HSET"'),
            );
            expect(args.at(13)).toBe(String(deadline));
            if (staleRetry && commands.length === 1) {
              return [-3, midnight];
            }
            return ACTION_SERVICE_DEADLINE_EXPIRED;
          },
        },
        run: async () => {
          runs += 1;
        },
      });
      expectRefusal(result, ACTION_ADMISSION_CODES.notEnabled);
      expect(runs).toBe(0);
      expect(commands).toHaveLength(staleRetry ? 2 : 1);
      if (staleRetry) {
        expect(commands.at(1)?.at(9)).toBe(String(midnight));
        expect(commands.at(1)?.at(13)).toBe(String(deadline));
      }
    }
  });

  test("every service-consuming kind uses its organization's selected budget", async () => {
    const stateCases = [
      {
        state: {
          state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
          evaluationEndsAt: new Date(nowMs + 1),
        },
        limit: serviceBudgetConfig.evaluationActions,
      },
      {
        state: {
          state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
          evaluationEndsAt: null,
        },
        limit: serviceBudgetConfig.selfManagedActions,
      },
    ] satisfies { state: OrganizationAccessSnapshot; limit: number }[];
    const actionKinds = Object.keys(ACTION_KINDS).filter(
      (kind): kind is keyof typeof ACTION_KINDS =>
        Object.hasOwn(ACTION_KINDS, kind),
    );
    const periodKinds = actionKinds.filter(
      (kind): kind is PeriodActionKind =>
        ACTION_KINDS[kind].admission === "period" &&
        ACTION_KINDS[kind].consumesServices,
    );
    for (const actionKind of periodKinds) {
      for (const { state, limit } of stateCases) {
        const redis = recordingRedis();
        const reads: unknown[] = [];
        const result = await withActionAdmission({
          organizationId,
          userId,
          enabled: true,
          policy,
          serviceBudgetsEnabled: true,
          serviceBudgetConfig,
          periodIdentity: { actionKind, logicalPhaseId: "phase" },
          periodPolicy: { periodMs: 3_600_000, limit: 101 },
          budgetNow: () => nowMs,
          readOrganizationState: async (scope) => {
            reads.push(scope);
            return actionState(state);
          },
          redis: redis.client,
          run: async () => "completed",
        });
        expect(result).toEqual(Result.ok("completed"));
        expect(reads).toEqual([{ organizationId, userId }]);
        const acquire = redis.commands.at(0);
        expect(acquire?.at(1)).toBe("3");
        expect(acquire?.at(9)).toBe(String(Date.UTC(2026, 9, 1)));
        expect(acquire?.at(10)).toBe(String(Date.UTC(2026, 9, 2)));
        expect(acquire?.at(11)).toBe(String(limit));
      }
    }
  });

  test("expired and ended evaluations refuse before coordination or tenant work", async () => {
    for (const state of [
      {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        evaluationEndsAt: new Date(nowMs),
      },
      {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        evaluationEndsAt: new Date(nowMs - 1),
      },
      {
        state: ORGANIZATION_ACCESS_STATE.evaluationEnded,
        evaluationEndsAt: new Date(nowMs + 1),
      },
    ] satisfies OrganizationAccessSnapshot[]) {
      const redis = recordingRedis();
      let ran = false;
      const result = await withActionAdmission({
        organizationId,
        userId,
        enabled: true,
        policy,
        serviceBudgetsEnabled: true,
        serviceBudgetConfig,
        periodIdentity,
        budgetNow: () => nowMs,
        readOrganizationState: async () => actionState(state),
        redis: redis.client,
        run: async () => {
          ran = true;
        },
      });
      expectRefusal(result, ACTION_ADMISSION_CODES.notEnabled);
      expect(redis.commands).toHaveLength(0);
      expect(ran).toBe(false);
    }
  });

  test("service admission without an injected reader or authorized database scope fails closed", async () => {
    const redis = recordingRedis();
    let runs = 0;
    const result = await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy,
      serviceBudgetsEnabled: true,
      serviceBudgetConfig,
      periodIdentity,
      budgetNow: () => nowMs,
      redis: redis.client,
      run: async () => {
        runs += 1;
      },
    });
    expectRefusal(result, ACTION_ADMISSION_CODES.admissionUnavailable);
    expect(redis.commands).toHaveLength(0);
    expect(runs).toBe(0);
  });

  test("missing state, incomplete selected configuration and state-read outages fail closed", async () => {
    for (const failure of [
      "missing-state",
      "missing-config",
      "read-outage",
    ] as const) {
      const redis = recordingRedis();
      let ran = false;
      const result = await withActionAdmission({
        organizationId,
        userId,
        enabled: true,
        policy,
        serviceBudgetsEnabled: true,
        serviceBudgetConfig: {
          ...serviceBudgetConfig,
          evaluationActions: failure === "missing-config" ? undefined : 7,
        },
        periodIdentity,
        budgetNow: () => nowMs,
        readOrganizationState: async () => {
          if (failure === "read-outage") {
            throw new Error("State store unavailable");
          }
          if (failure === "missing-state") {
            return actionState(undefined);
          }
          return actionState({
            state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
            evaluationEndsAt: new Date(nowMs + 1),
          });
        },
        redis: redis.client,
        run: async () => {
          ran = true;
        },
      });
      expectRefusal(result, ACTION_ADMISSION_CODES.admissionUnavailable);
      expect(redis.commands).toHaveLength(0);
      expect(ran).toBe(false);
    }
  });

  test("own-data read, export and delete bypass state and service budgets", async () => {
    for (const operation of ["read", "export", "delete"]) {
      const redis = recordingRedis();
      let readState = false;
      const result = await withActionAdmission({
        organizationId,
        userId,
        enabled: true,
        policy,
        serviceBudgetsEnabled: true,
        serviceBudgetConfig: {
          periodMs: undefined,
          evaluationActions: undefined,
          selfManagedActions: undefined,
        },
        periodIdentity: {
          actionKind: "mcp.data/call",
          logicalPhaseId: operation,
        },
        periodPolicy: { periodMs: 1, limit: 1 },
        budgetNow: () => nowMs,
        readOrganizationState: async () => {
          readState = true;
          throw new Error("Own-data operations must not read service access");
        },
        redis: redis.client,
        run: async () => operation,
      });
      expect(result).toEqual(Result.ok(operation));
      expect(readState).toBe(false);
      expect(redis.commands).toHaveLength(2);
      for (const command of redis.commands) {
        expect(command.at(1)).toBe("2");
      }
      expect(redis.commands.at(0)).toHaveLength(8);
    }
  });

  test("the organization-budget flag off preserves the configured global period", async () => {
    const redis = recordingRedis();
    let readState = false;
    const result = await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy,
      serviceBudgetsEnabled: false,
      periodIdentity,
      periodPolicy: { periodMs: 3_600_000, limit: 101 },
      budgetNow: () => nowMs,
      readOrganizationState: async () => {
        readState = true;
        throw new Error("Disabled organization budgets must not read state");
      },
      redis: redis.client,
      run: async () => "completed",
    });
    expect(result).toEqual(Result.ok("completed"));
    expect(readState).toBe(false);
    expect(redis.commands.at(0)?.at(9)).toBe(String(Date.UTC(2026, 9, 1, 12)));
    expect(redis.commands.at(0)?.at(10)).toBe(String(Date.UTC(2026, 9, 1, 13)));
    expect(redis.commands.at(0)?.at(11)).toBe("101");
  });

  test("the admission flag off executes without state, configuration, clock or coordination", async () => {
    let readState = false;
    let opened = false;
    let clockRead = false;
    const result = await withActionAdmission({
      organizationId,
      userId,
      enabled: false,
      serviceBudgetsEnabled: true,
      budgetNow: () => {
        clockRead = true;
        return nowMs;
      },
      readOrganizationState: async () => {
        readState = true;
        throw new Error("Disabled admission must not read state");
      },
      redisReady: async () => {
        opened = true;
        throw new Error("Disabled admission must not open coordination");
      },
      run: async () => "completed",
    });
    expect(result).toEqual(Result.ok("completed"));
    expect(readState).toBe(false);
    expect(opened).toBe(false);
    expect(clockRead).toBe(false);
  });
});

// A period counter that refuses past the limit the admission passes, as the
// acquisition script does: enough to observe which actions draw the budget.
const countingRedis = () => {
  const commands: string[][] = [];
  let counted = 0;
  return {
    commands,
    periodAcquisitions: () =>
      commands.filter((args) => args.at(1) === "3").length,
    client: {
      send: async (_command: string, args: string[]) => {
        commands.push(args);
        if (args.at(1) !== "3") {
          return 1;
        }
        counted += 1;
        return counted > Number(args.at(11)) ? -1 : 1;
      },
    },
  };
};

// Mirrors the acquisition script's period branch per KEYS[3]: a replayed
// phase is admitted again, a new phase is counted up to ARGV[7].
const periodStore = () => {
  const hashes = new Map<string, { count: number; phases: Set<string> }>();
  return {
    counts: () => [...hashes.values()].map(({ count }) => count),
    client: {
      send: async (_command: string, args: string[]) => {
        const key = args.at(4);
        if (args.at(1) !== "3" || key === undefined) {
          return 1;
        }
        const limit = Number(args.at(11));
        const phase = args.at(12) ?? "";
        const hash = hashes.get(key) ?? { count: 0, phases: new Set() };
        if (hash.phases.has(phase)) {
          return 1;
        }
        if (hash.count >= limit) {
          return -1;
        }
        hash.phases.add(phase);
        hash.count += 1;
        hashes.set(key, hash);
        return 1;
      },
    },
  };
};

const SERVICE_PERIOD_KINDS = Object.keys(ACTION_KINDS)
  .filter((kind): kind is keyof typeof ACTION_KINDS =>
    Object.hasOwn(ACTION_KINDS, kind),
  )
  .filter(
    (kind): kind is PeriodActionKind =>
      ACTION_KINDS[kind].admission === "period",
  )
  .filter((kind) => ACTION_KINDS[kind].consumesServices);

const FREE_ACTIONS = 3;
const lapsedEvaluation = {
  state: ORGANIZATION_ACCESS_STATE.evaluationEnded,
  evaluationEndsAt: new Date(nowMs - 1),
} as const satisfies OrganizationAccessSnapshot;
const freeActionState = (
  modelCredentials: OrganizationActionState["modelCredentials"],
): OrganizationActionState => ({
  snapshot: lapsedEvaluation,
  freeTier: {
    status: "on",
    policy: { serviceActionsPerPeriod: FREE_ACTIONS },
  },
  modelCredentials,
});

describe("the free floor's service budget", () => {
  const admitOnFree = async ({
    actionKind,
    modelCredentials,
    redis,
  }: {
    actionKind: PeriodActionKind;
    modelCredentials: OrganizationActionState["modelCredentials"];
    redis: ReturnType<typeof countingRedis>;
  }) =>
    await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy,
      serviceBudgetsEnabled: true,
      serviceBudgetConfig,
      periodIdentity: { actionKind, logicalPhaseId: Bun.randomUUIDv7() },
      budgetNow: () => nowMs,
      readOrganizationState: async () => freeActionState(modelCredentials),
      redis: redis.client,
      run: async () => "completed",
    });

  test("a chat send on the organization's own key is admitted past the free budget", async () => {
    const redis = countingRedis();
    for (let send = 0; send < FREE_ACTIONS + 5; send += 1) {
      expect(
        await admitOnFree({
          actionKind: "chat.send",
          modelCredentials: ORGANIZATION_MODEL_CREDENTIALS.organization,
          redis,
        }),
      ).toEqual(Result.ok("completed"));
    }
    expect(redis.periodAcquisitions()).toBe(0);
  });

  test("a chat send on managed models is refused once the free budget is spent", async () => {
    const redis = countingRedis();
    for (let send = 0; send < FREE_ACTIONS; send += 1) {
      expect(
        await admitOnFree({
          actionKind: "chat.send",
          modelCredentials: ORGANIZATION_MODEL_CREDENTIALS.managed,
          redis,
        }),
      ).toEqual(Result.ok("completed"));
    }
    expectRefusal(
      await admitOnFree({
        actionKind: "chat.send",
        modelCredentials: ORGANIZATION_MODEL_CREDENTIALS.managed,
        redis,
      }),
      ACTION_ADMISSION_CODES.periodExhausted,
    );
    expect(redis.periodAcquisitions()).toBe(FREE_ACTIONS + 1);
    expect(
      redis.commands
        .filter((args) => args.at(1) === "3")
        .map((args) => args.at(11)),
    ).toEqual(
      Array.from({ length: FREE_ACTIONS + 1 }, () => String(FREE_ACTIONS)),
    );
  });

  test("every model action kind draws the free budget on managed models and none on the organization's own key", async () => {
    const registered = Object.keys(ACTION_KINDS).filter(
      (kind): kind is keyof typeof ACTION_KINDS =>
        Object.hasOwn(ACTION_KINDS, kind),
    );
    const modelKinds = registered.filter(
      (kind): kind is PeriodActionKind =>
        ACTION_KINDS[kind].admission === "period" &&
        ACTION_KINDS[kind].serviceCredentials ===
          ACTION_SERVICE_CREDENTIALS.organizationModel,
    );
    expect(modelKinds.length).toBeGreaterThan(0);
    for (const actionKind of modelKinds) {
      const managed = countingRedis();
      for (let action = 0; action < FREE_ACTIONS; action += 1) {
        expect(
          await admitOnFree({
            actionKind,
            modelCredentials: ORGANIZATION_MODEL_CREDENTIALS.managed,
            redis: managed,
          }),
        ).toEqual(Result.ok("completed"));
      }
      expectRefusal(
        await admitOnFree({
          actionKind,
          modelCredentials: ORGANIZATION_MODEL_CREDENTIALS.managed,
          redis: managed,
        }),
        ACTION_ADMISSION_CODES.periodExhausted,
      );

      const own = countingRedis();
      for (let action = 0; action <= FREE_ACTIONS; action += 1) {
        expect(
          await admitOnFree({
            actionKind,
            modelCredentials: ORGANIZATION_MODEL_CREDENTIALS.organization,
            redis: own,
          }),
        ).toEqual(Result.ok("completed"));
      }
      expect(own.periodAcquisitions()).toBe(0);
    }
  });

  test("managed services stay counted on the organization's own key", async () => {
    const redis = countingRedis();
    for (let call = 0; call < FREE_ACTIONS; call += 1) {
      expect(
        await admitOnFree({
          actionKind: "mcp.services/call",
          modelCredentials: ORGANIZATION_MODEL_CREDENTIALS.organization,
          redis,
        }),
      ).toEqual(Result.ok("completed"));
    }
    expectRefusal(
      await admitOnFree({
        actionKind: "mcp.services/call",
        modelCredentials: ORGANIZATION_MODEL_CREDENTIALS.organization,
        redis,
      }),
      ACTION_ADMISSION_CODES.periodExhausted,
    );
  });

  test("a queued workflow on the organization's own key takes the per-kind backlog cap, not the free budget", async () => {
    const backlogCap = 2;
    for (const periodReservation of [undefined, "on-acceptance"] as const) {
      const store = periodStore();
      const kickoff = async () => {
        const identity = {
          actionKind: "workflow.start",
          logicalPhaseId: Bun.randomUUIDv7(),
        } as const satisfies AdmittedActionIdentity;
        return await withActionAdmission({
          organizationId,
          userId,
          enabled: true,
          policy,
          execution: "queued-kickoff",
          periodReservation,
          periodIdentity: identity,
          periodPolicy: {
            periodMs: serviceBudgetConfig.periodMs,
            limit: backlogCap,
          },
          serviceBudgetsEnabled: true,
          serviceBudgetConfig,
          budgetNow: () => nowMs,
          readOrganizationState: async () =>
            freeActionState(ORGANIZATION_MODEL_CREDENTIALS.organization),
          redis: store.client,
          run: async (_signal, control) => {
            if (periodReservation === "on-acceptance") {
              const reserved = await control.reservePeriod(identity);
              if (Result.isError(reserved)) {
                throw reserved.error;
              }
            }
            return "queued";
          },
        });
      };
      for (let start = 0; start < backlogCap; start += 1) {
        expect(await kickoff()).toEqual(Result.ok("queued"));
      }
      expectRefusal(await kickoff(), ACTION_ADMISSION_CODES.periodExhausted);
      expect(store.counts()).toEqual([backlogCap]);
      const managed = await withActionAdmission({
        organizationId,
        userId,
        enabled: true,
        policy,
        serviceBudgetsEnabled: true,
        serviceBudgetConfig,
        periodIdentity: {
          actionKind: "chat.send",
          logicalPhaseId: Bun.randomUUIDv7(),
        },
        budgetNow: () => nowMs,
        readOrganizationState: async () =>
          freeActionState(ORGANIZATION_MODEL_CREDENTIALS.managed),
        redis: store.client,
        run: async () => "completed",
      });
      expect(managed).toEqual(Result.ok("completed"));
      expect(store.counts()).toEqual([backlogCap, 1]);
    }
  });

  test("a missing free policy refuses as unavailable, never as unlimited", async () => {
    const redis = countingRedis();
    const result = await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy,
      serviceBudgetsEnabled: true,
      serviceBudgetConfig,
      periodIdentity,
      budgetNow: () => nowMs,
      readOrganizationState: async () => ({
        snapshot: lapsedEvaluation,
        freeTier: { status: "on", policy: undefined },
        modelCredentials: ORGANIZATION_MODEL_CREDENTIALS.managed,
      }),
      redis: redis.client,
      run: async () => "completed",
    });
    expectRefusal(result, ACTION_ADMISSION_CODES.admissionUnavailable);
    expect(redis.commands).toHaveLength(0);
  });

  test("the free budget is one count across every kind, per period", async () => {
    await assertProperty(
      "the free budget is one count across every kind, per period",
      fc.asyncProperty(
        fc.array(
          fc.record({
            actionKind: fc.constantFrom(...SERVICE_PERIOD_KINDS),
            modelCredentials: fc.constantFrom(
              ...Object.values(ORGANIZATION_MODEL_CREDENTIALS),
            ),
            period: fc.integer({ min: 0, max: 1 }),
          }),
          { maxLength: 3 * FREE_ACTIONS },
        ),
        async (drawn) => {
          const steps = drawn.toSorted(
            (left, right) => left.period - right.period,
          );
          const store = periodStore();
          const records: ActionCostObservation[] = [];
          const counted = [0, 0];
          for (const { actionKind, modelCredentials, period } of steps) {
            const draws = !(
              ACTION_KINDS[actionKind].serviceCredentials ===
                ACTION_SERVICE_CREDENTIALS.organizationModel &&
              modelCredentials === ORGANIZATION_MODEL_CREDENTIALS.organization
            );
            const exhausted = draws && (counted[period] ?? 0) >= FREE_ACTIONS;
            let ran = false;
            const logicalPhaseId = Bun.randomUUIDv7();
            const result = await withActionAdmission({
              organizationId,
              userId,
              enabled: true,
              policy,
              serviceBudgetsEnabled: true,
              serviceBudgetConfig,
              periodIdentity: { actionKind, logicalPhaseId },
              budgetNow: () => nowMs + period * serviceBudgetConfig.periodMs,
              readOrganizationState: async () =>
                freeActionState(modelCredentials),
              redis: store.client,
              costRecorder: {
                enqueue: (observation) => records.push(observation),
                estimate: () => null,
                callRate: () => null,
              },
              run: async () => {
                ran = true;
                return "completed";
              },
            });
            if (exhausted) {
              expectRefusal(result, ACTION_ADMISSION_CODES.periodExhausted);
              expect(ran).toBe(false);
              continue;
            }
            expect(result).toEqual(Result.ok("completed"));
            expect(
              records.findLast(
                (observation) =>
                  observation.type === "action" &&
                  observation.record.logicalPhaseId === logicalPhaseId,
              )?.record,
            ).toMatchObject({ actionKind, logicalPhaseId });
            if (draws) {
              counted[period] = (counted[period] ?? 0) + 1;
            }
          }
          // One pooled counter per period, never one per kind.
          expect(store.counts()).toEqual(counted.filter((count) => count > 0));
        },
      ),
    );
  });
});
