import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { withActionAdmission } from "@/api/lib/rate-limit/action-admission";

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
          mode === "busy" ? "rate_limited" : "service_unavailable",
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
