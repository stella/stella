import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  ACTION_ADMISSION_CODES,
  ACTION_ADMISSION_REFUSALS,
} from "@stll/api-contract/action-admission";

import { env } from "@/api/env";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  ActionAdmissionError,
  withActionAdmission,
} from "@/api/lib/rate-limit/action-admission";
import type { AdmittedActionIdentity } from "@/api/lib/rate-limit/action-kinds";
import type { ActionPeriodPolicy } from "@/api/lib/rate-limit/action-period-budget";

import { startChatExecutionAdmission } from "./chat-execution-admission";

const organizationId = toSafeId<"organization">("org_execution");
const userId = toSafeId<"user">("user_execution");
const action = {
  mode: "action",
  periodIdentity: { actionKind: "chat.send", logicalPhaseId: "thread:run" },
} as const;

const coordination = ({
  mode = "ready",
  userConcurrency = 1,
  periodPolicy,
}: {
  mode?: "ready" | "busy" | "offline";
  userConcurrency?: number;
  periodPolicy?: ActionPeriodPolicy;
} = {}) => {
  const active = new Set<string>();
  const periods = new Map<string, Set<string>>();
  let acquisitions = 0;
  let releases = 0;
  const redis = {
    send: async (_command: string, args: string[]) => {
      if (mode === "offline") {
        acquisitions += 1;
        throw new HandlerError({
          status: 503,
          message: "Coordination offline",
        });
      }
      const script = args.at(0);
      const acquire = script?.includes("ZREMRANGEBYSCORE");
      const reserve = script?.includes("HEXISTS") && !acquire;
      if (acquire || reserve) {
        if (acquire) {
          acquisitions += 1;
        }
        if (acquire && (mode === "busy" || active.size >= userConcurrency)) {
          return 0;
        }
        const counted = args.at(1) === "3";
        if (counted) {
          const key = args.at(4);
          const phase = args.at(12);
          if (key === undefined || phase === undefined) {
            throw new HandlerError({
              status: 500,
              message: "Missing period identity",
            });
          }
          const phases = periods.get(key) ?? new Set<string>();
          if (!phases.has(phase) && phases.size >= Number(args.at(11))) {
            return -1;
          }
          phases.add(phase);
          periods.set(key, phases);
        }
        const id = args.at(counted ? 8 : 7);
        if (id === undefined) {
          throw new HandlerError({
            status: 500,
            message: "Missing lease identity",
          });
        }
        if (reserve && !active.has(id)) {
          return -2;
        }
        if (acquire) {
          active.add(id);
        }
        return 1;
      }
      if (script?.includes("ZSCORE")) {
        return 1;
      }
      releases += 1;
      const id = args.at(4);
      if (id !== undefined) {
        active.delete(id);
      }
      return 1;
    },
  };
  const admit: typeof withActionAdmission = async (options) =>
    await withActionAdmission({
      ...options,
      policy: { organizationConcurrency: 3, userConcurrency, leaseMs: 120_000 },
      ...(periodPolicy === undefined ? {} : { periodPolicy }),
      redis,
    });
  return {
    admit,
    counts: () => ({ acquisitions, releases, active: active.size }),
    periodCount: () =>
      Array.from(periods.values()).reduce(
        (count, phases) => count + phases.size,
        0,
      ),
  };
};

const executionOf = async (
  operation: ReturnType<typeof startChatExecutionAdmission>,
) => {
  const acquired = await operation;
  if (Result.isError(acquired)) {
    throw acquired.error;
  }
  if (acquired.value === undefined) {
    throw new HandlerError({
      status: 500,
      message: "Expected enabled execution admission",
    });
  }
  return acquired.value;
};

describe("chat execution admission owns settlement independently of transport readiness", () => {
  test("every admission reason keeps its canonical refusal at the chat boundary", async () => {
    const reasons = {
      busy: "busy",
      period_exhausted: "period_exhausted",
      not_enabled: "not_enabled",
      unavailable: "unavailable",
    } as const satisfies { [Reason in ActionAdmissionError["reason"]]: Reason };
    const previousContactUrl = env.ACTION_LIMIT_CONTACT_URL;
    try {
      for (const contactUrl of [undefined, "https://example.test/help"]) {
        env.ACTION_LIMIT_CONTACT_URL = contactUrl;
        for (const reason of Object.values(reasons)) {
          const error = new ActionAdmissionError({
            reason,
            message: "Admission refused",
          });
          const acquired = await startChatExecutionAdmission({
            ...action,
            enabled: true,
            organizationId,
            userId,
            admit: async () => Result.err(error),
          });
          expect(Result.isError(acquired)).toBe(true);
          if (Result.isError(acquired)) {
            const refusal = ACTION_ADMISSION_REFUSALS[error.code];
            expect(acquired.error).toMatchObject({
              status: refusal.status,
              code: error.code,
              message: refusal.message,
              retryable: refusal.retryable,
              contactUrl:
                reason === "period_exhausted" || reason === "not_enabled"
                  ? contactUrl
                  : undefined,
              cause: error,
            });
          }
        }
      }
    } finally {
      env.ACTION_LIMIT_CONTACT_URL = previousContactUrl;
    }
  });

  test("claimed phases reserve once on the existing slot and fresh turns count an old run id anew", async () => {
    const store = coordination({
      periodPolicy: { periodMs: 86_400_000, limit: 2 },
    });
    for (const [index, turn] of ["turn-a", "turn-b", "turn-c"].entries()) {
      const execution = await executionOf(
        startChatExecutionAdmission({
          mode: "concurrency-only",
          actionKind: "chat.send",
          enabled: true,
          organizationId,
          userId,
          admit: store.admit,
        }),
      );
      try {
        const identity = {
          actionKind: "chat.send",
          logicalPhaseId: JSON.stringify([turn, "old-run"]),
        } as const satisfies AdmittedActionIdentity;
        const first = await execution.reservePeriod(identity);
        if (index < 2) {
          expect(Result.isOk(first)).toBe(true);
          expect(Result.isOk(await execution.reservePeriod(identity))).toBe(
            true,
          );
        } else {
          expect(Result.isError(first)).toBe(true);
          if (Result.isError(first)) {
            expect(first.error).toMatchObject({
              status: 403,
              code: ACTION_ADMISSION_CODES.periodExhausted,
              retryable: false,
            });
          }
        }
        expect(store.periodCount()).toBe(Math.min(index + 1, 2));
        expect(store.counts().active).toBe(1);
        expect(store.counts().acquisitions).toBe(index + 1);
      } finally {
        await execution.release();
      }
    }
  });

  test("each chat phase counts once across retries and detached titles count no period action", async () => {
    const store = coordination({
      periodPolicy: { periodMs: 86_400_000, limit: 3 },
    });
    for (const [index, phase] of [
      "initial",
      "regeneration",
      "approved-continuation",
    ].entries()) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const execution = await executionOf(
          startChatExecutionAdmission({
            enabled: true,
            organizationId,
            userId,
            mode: "action",
            periodIdentity: {
              actionKind: "chat.send",
              logicalPhaseId: JSON.stringify(["thread", phase]),
            },
            admit: store.admit,
          }),
        );
        await execution.release();
        expect(store.periodCount()).toBe(index + 1);
      }
      if (phase === "initial") {
        const title = await executionOf(
          startChatExecutionAdmission({
            enabled: true,
            organizationId,
            userId,
            mode: "concurrency-only",
            actionKind: "chat.generate-thread-title",
            admit: store.admit,
          }),
        );
        expect(store.counts().active).toBe(1);
        expect(store.periodCount()).toBe(1);
        await title.release();
      }
    }
    const refused = await startChatExecutionAdmission({
      ...action,
      enabled: true,
      organizationId,
      userId,
      admit: store.admit,
    });
    expect(Result.isError(refused)).toBe(true);
    if (Result.isError(refused)) {
      expect(refused.error).toMatchObject({
        status: 403,
        code: ACTION_ADMISSION_CODES.periodExhausted,
        retryable: false,
      });
    }
    expect(store.periodCount()).toBe(3);
    expect(store.counts().active).toBe(0);
  });

  test("concurrency-only titles still refuse busy or unavailable coordination", async () => {
    for (const mode of ["busy", "offline"] as const) {
      const store = coordination({
        mode,
        periodPolicy: { periodMs: 86_400_000, limit: 1 },
      });
      const acquired = await startChatExecutionAdmission({
        enabled: true,
        organizationId,
        userId,
        mode: "concurrency-only",
        actionKind: "chat.send",
        admit: store.admit,
      });
      expect(Result.isError(acquired)).toBe(true);
      if (Result.isError(acquired)) {
        expect(acquired.error.status).toBe(mode === "busy" ? 429 : 503);
      }
      expect(store.counts().acquisitions).toBe(1);
      expect(store.counts().active).toBe(0);
      expect(store.periodCount()).toBe(0);
    }
  });

  test("a ready transport keeps its slot until close and repeated close releases only once", async () => {
    const store = coordination();
    const options = {
      ...action,
      enabled: true,
      organizationId,
      userId,
      admit: store.admit,
    };
    const execution = await executionOf(startChatExecutionAdmission(options));
    expect(execution.signal.aborted).toBe(false);
    expect(store.counts()).toEqual({ acquisitions: 1, releases: 0, active: 1 });
    const refused = await startChatExecutionAdmission(options);
    expect(Result.isError(refused) && refused.error.status).toBe(429);
    expect(store.counts()).toEqual({ acquisitions: 2, releases: 0, active: 1 });
    await execution.release();
    await execution.release();
    expect(store.counts()).toEqual({ acquisitions: 2, releases: 1, active: 0 });
  });

  test("disabled execution admission never calls coordination or resolves its configuration", async () => {
    let calls = 0;
    const acquired = await startChatExecutionAdmission({
      ...action,
      enabled: false,
      organizationId,
      userId,
      admit: async () => {
        calls += 1;
        throw new HandlerError({
          status: 500,
          message: "Disabled admission read configuration",
        });
      },
    });
    expect(Result.isOk(acquired) && acquired.value).toBeUndefined();
    expect(calls).toBe(0);
  });

  for (const mode of ["busy", "offline"] as const) {
    test(`${mode} coordination returns a typed refusal without an execution handle`, async () => {
      const store = coordination({ mode });
      const acquired = await startChatExecutionAdmission({
        ...action,
        enabled: true,
        organizationId,
        userId,
        admit: store.admit,
      });
      expect(Result.isError(acquired)).toBe(true);
      if (Result.isError(acquired)) {
        const code =
          mode === "busy"
            ? ACTION_ADMISSION_CODES.concurrencyBusy
            : ACTION_ADMISSION_CODES.admissionUnavailable;
        const refusal = ACTION_ADMISSION_REFUSALS[code];
        expect(acquired.error).toMatchObject({
          code,
          status: refusal.status,
          message: refusal.message,
          retryable: refusal.retryable,
        });
      }
      expect(store.counts()).toEqual({
        acquisitions: 1,
        releases: 0,
        active: 0,
      });
    });
  }

  test("an execution inside the same caller's parent scope acquires its own slot", async () => {
    const store = coordination({ userConcurrency: 2 });
    const parent = await store.admit({
      enabled: true,
      organizationId,
      userId,
      run: async (parentSignal) => {
        const execution = await executionOf(
          startChatExecutionAdmission({
            ...action,
            enabled: true,
            organizationId,
            userId,
            admit: store.admit,
          }),
        );
        expect(execution.signal).not.toBe(parentSignal);
        expect(store.counts()).toEqual({
          acquisitions: 2,
          releases: 0,
          active: 2,
        });
        await execution.release();
        expect(store.counts()).toEqual({
          acquisitions: 2,
          releases: 1,
          active: 1,
        });
        return "completed";
      },
    });
    expect(Result.isOk(parent) && parent.value).toBe("completed");
    expect(store.counts()).toEqual({ acquisitions: 2, releases: 2, active: 0 });
  });

  test("successive continuation attempts acquire fresh slots after prior settlement", async () => {
    const store = coordination();
    const options = {
      ...action,
      enabled: true,
      organizationId,
      userId,
      admit: store.admit,
    };
    const first = await executionOf(startChatExecutionAdmission(options));
    await first.release();
    const continuation = await executionOf(
      startChatExecutionAdmission(options),
    );
    expect(continuation.signal).not.toBe(first.signal);
    expect(store.counts()).toEqual({ acquisitions: 2, releases: 1, active: 1 });
    await continuation.release();
    expect(store.counts()).toEqual({ acquisitions: 2, releases: 2, active: 0 });
  });
});
