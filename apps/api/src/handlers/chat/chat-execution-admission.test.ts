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

import { startChatExecutionAdmission } from "./chat-execution-admission";

const organizationId = toSafeId<"organization">("org_execution");
const userId = toSafeId<"user">("user_execution");

const coordination = ({
  mode = "ready",
  userConcurrency = 1,
}: {
  mode?: "ready" | "busy" | "offline";
  userConcurrency?: number;
} = {}) => {
  const active = new Set<string>();
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
      if (script?.includes("ZREMRANGEBYSCORE")) {
        acquisitions += 1;
        if (mode === "busy" || active.size >= userConcurrency) {
          return 0;
        }
        const id = args.at(7);
        if (id === undefined) {
          throw new HandlerError({
            status: 500,
            message: "Missing lease identity",
          });
        }
        active.add(id);
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
      redis,
    });
  return {
    admit,
    counts: () => ({ acquisitions, releases, active: active.size }),
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
  test("every preflight refusal keeps its canonical code and recovery metadata", async () => {
    const previousContact = env.ACTION_LIMIT_CONTACT_URL;
    env.ACTION_LIMIT_CONTACT_URL = "https://example.test/contact";
    try {
      for (const reason of [
        "busy",
        "period_exhausted",
        "not_enabled",
        "unavailable",
      ] as const) {
        const error = new ActionAdmissionError({
          reason,
          message: "Private coordination detail",
        });
        const admitted = await startChatExecutionAdmission({
          enabled: true,
          organizationId,
          userId,
          admit: async () => Result.err(error),
        });
        expect(Result.isError(admitted)).toBe(true);
        if (Result.isError(admitted)) {
          const metadata = ACTION_ADMISSION_REFUSALS[error.code];
          expect(admitted.error).toMatchObject({
            code: error.code,
            status: metadata.status,
            message: metadata.message,
            retryable: metadata.retryable,
            cause: error,
          });
          expect(admitted.error.contactUrl).toBe(
            metadata.status === 403 ? env.ACTION_LIMIT_CONTACT_URL : undefined,
          );
        }
      }
    } finally {
      env.ACTION_LIMIT_CONTACT_URL = previousContact;
    }
  });

  test("a ready transport keeps its slot until close and repeated close releases only once", async () => {
    const store = coordination();
    const options = {
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
        enabled: true,
        organizationId,
        userId,
        admit: store.admit,
      });
      expect(Result.isError(acquired)).toBe(true);
      if (Result.isError(acquired)) {
        expect(acquired.error.status).toBe(mode === "busy" ? 429 : 503);
        expect(acquired.error.code).toBe(
          mode === "busy"
            ? ACTION_ADMISSION_CODES.concurrencyBusy
            : ACTION_ADMISSION_CODES.admissionUnavailable,
        );
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
