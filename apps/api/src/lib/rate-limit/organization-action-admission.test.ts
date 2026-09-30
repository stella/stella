import { Value } from "@sinclair/typebox/value";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  ACTION_ADMISSION_CODES,
  type ActionAdmissionCode,
} from "@stll/api-contract/action-admission";

import { ORGANIZATION_ACCESS_STATE } from "@/api/db/schema";
import {
  reportExportBodySchema,
  reportExportConsumesServices,
} from "@/api/handlers/reports/views/export-input";
import { toSafeId } from "@/api/lib/branded-types";
import type { OrganizationActionState } from "@/api/lib/usage/organization-action-budget";
import { mcpActionPeriodIdentity } from "@/api/mcp/action-admission-identity";

import { withActionAdmission } from "./action-admission";
import { ACTION_KINDS, type AdmittedActionIdentity } from "./action-kinds";
import {
  ACTION_SERVICE_DEADLINE_EXPIRED,
  ACTION_SERVICE_DEADLINE_SCRIPT,
} from "./action-period-budget";

const organizationId = toSafeId<"organization">("service_budget_org");
const userId = toSafeId<"user">("service_budget_user");
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
            return {
              state: ORGANIZATION_ACCESS_STATE.evaluationEnded,
              evaluationEndsAt: new Date(nowMs - 1),
            };
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
          return {
            state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
            evaluationEndsAt: new Date(nowMs + 1),
          } satisfies OrganizationActionState;
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
        return {
          state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
          evaluationEndsAt: new Date(nowMs + 1),
        } satisfies OrganizationActionState;
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
        readOrganizationState: async () => ({
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
    ] satisfies { state: OrganizationActionState; limit: number }[];
    const actionKinds = Object.keys(ACTION_KINDS).filter(
      (kind): kind is keyof typeof ACTION_KINDS =>
        Object.hasOwn(ACTION_KINDS, kind),
    );
    for (const actionKind of actionKinds) {
      if (!ACTION_KINDS[actionKind].consumesServices) {
        continue;
      }
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
            return state;
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
    ] satisfies OrganizationActionState[]) {
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
        readOrganizationState: async () => state,
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
            return undefined;
          }
          return {
            state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
            evaluationEndsAt: new Date(nowMs + 1),
          };
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
