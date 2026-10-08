import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { initialBatchState } from "@stll/db-load-gate/health";

import { createSafeId } from "@/api/lib/branded-types";

import {
  EuCompletionStop,
  runEuCompletionTick,
  type EuCompletionRowOutcome,
  type EuCompletionRowOptions,
  type RunEuCompletionTickOptions,
} from "./eu-completion";
import {
  capRefusalHold,
  EU_COMPLETION_STORE_LIMITS,
} from "./eu-completion-store";
import type { EuCompletionReceipt } from "./eu-completion-store";

const sourceId = createSafeId<"caseLawSource">();
const receipt = (id: string): EuCompletionReceipt => ({
  id,
  sourceId,
  decisionId: createSafeId<"caseLawDecision">(),
  mode: "dry-run",
  parserVersion: 1,
  status: "pending",
  target: null,
  claimedSourceHash: null,
  completionSourceHash: null,
  claimedObservationOrder: null,
  claimedFingerprint: null,
  payload: null,
  payloadHash: null,
  provenance: null,
  detail: null,
  attempts: 0,
  attemptState: "idle",
  systemicFailures: 0,
  systemicProgress: 0,
  refusalCount: 0,
  refusalProgress: 0,
  refusalHoldUntil: null,
  mirrorWaits: 0,
  retryAt: null,
  writtenAt: null,
  writtenSourceHash: null,
  writtenParserVersion: null,
  writtenObservationOrder: null,
  supersededAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  completedAt: null,
});
const fixture = () => {
  const events: string[] = [];
  let enabled = true;
  let clock = 0;
  let sourceHoldUntil: number | null = null;
  let control: "on" | "off" = "on";
  let ticks = 0;
  let requests = 0;
  let admissions = 0;
  const rows = [receipt("first"), receipt("second")];
  const dependencies = {
    store: {
      loadControls: async () => {
        admissions++;
        return { global: control, source: control };
      },
      loadSourceGateState: async () => ({
        ...initialBatchState(),
        holdUntil: sourceHoldUntil,
      }),
      getApproval: async () => null,
      readSweepCursor: async () => null,
      reserve: async () => {
        events.push("reserve");
        return rows;
      },
      pickup: async (id: string) => {
        events.push(`pickup:${id}`);
        return "ready" as const;
      },
      recordFailure: async (row: EuCompletionReceipt) => {
        events.push(`refund:${row.id}`);
        return "retryable" as const;
      },
      releaseBenign: async (id: string) => {
        events.push(`refund:${id}`);
        return null;
      },
      recordTick: async ({
        mode,
        healthyCompleted,
        intentionallyHeld,
      }: Parameters<
        RunEuCompletionTickOptions["dependencies"]["store"]["recordTick"]
      >[0]) => {
        ticks =
          mode === "apply" && healthyCompleted === 0 && !intentionallyHeld
            ? ticks + 1
            : 0;
        return { ticksWithoutProgress: ticks, lastCompletedAt: null };
      },
    },
    isEnabled: async () => enabled,
    readGate: async () => ({ kind: "normal" as const, signals: [] }),
    fence: async () => {},
    requestCount: () => requests,
    runRow: async (
      row: EuCompletionReceipt,
      options: EuCompletionRowOptions,
    ): Promise<Result<EuCompletionRowOutcome, unknown>> => {
      const checked = await options.check();
      if (checked.isErr()) {
        return checked;
      }
      events.push(`run:${row.id}`);
      requests++;
      return Result.ok({ type: "dry-run" });
    },
  } satisfies RunEuCompletionTickOptions["dependencies"];
  const run = async (overrides: Partial<RunEuCompletionTickOptions> = {}) =>
    await runEuCompletionTick({
      sourceId,
      mode: "dry-run",
      parserVersion: 1,
      maxRows: 2,
      signal: new AbortController().signal,
      now: () => clock,
      dependencies,
      ...overrides,
    });
  return {
    events,
    admissions: () => admissions,
    dependencies,
    run,
    rows,
    disable: () => {
      enabled = false;
    },
    setControl: (state: "on" | "off") => {
      control = state;
    },
    setTime: (time: number) => {
      clock = time;
    },
    hold: () => {
      sourceHoldUntil = 1000;
    },
  };
};

describe("bounded EU completion orchestration", () => {
  test("per-request fences do not repeat document admission reads", async () => {
    const state = fixture();
    state.dependencies.runRow = async (_row, options) => {
      for (let request = 0; request < 4; request++) {
        const checked = await options.check();
        if (checked.isErr()) {
          return checked;
        }
        const immediate = options.checkBeforeSend();
        if (immediate.isErr()) {
          return immediate;
        }
      }
      return Result.ok({ type: "dry-run" });
    };
    expect((await state.run()).status).toBe("completed");
    expect(state.admissions()).toBe(state.rows.length);
  });
  test.each([
    "off",
    "held",
    "time-limit",
    "request-budget",
    "byte-budget",
    "cancelled",
  ] as const)(
    "benign %s refunds without recording a source failure",
    async (reason) => {
      const state = fixture();
      let failures = 0;
      state.dependencies.store.recordFailure = async () => {
        failures++;
        return "retryable";
      };
      state.dependencies.runRow = async () =>
        Result.err(
          new EuCompletionStop({ message: "fixture benign stop", reason }),
        );
      const report = await state.run();
      expect(report.status).toBe(reason);
      expect(failures).toBe(0);
      expect(state.events).toEqual(["reserve", "pickup:first", "refund:first"]);
      expect(report.noProgress).toBe(0);
    },
  );

  test.each(["env", "durable", "source-backoff"] as const)(
    "%s admission stops before queue selection",
    async (kind) => {
      const state = fixture();
      if (kind === "env") {
        state.disable();
      }
      if (kind === "durable") {
        state.setControl("off");
      }
      if (kind === "source-backoff") {
        state.hold();
      }
      const report = await state.run();
      expect(report.status).toBe(kind === "source-backoff" ? "held" : "off");
      expect(state.events).toEqual([]);
      expect(report.noProgress).toBe(0);
    },
  );
  test("apply cannot infer supervised approval from enabled controls", async () => {
    const state = fixture();
    expect((await state.run({ mode: "apply" })).status).toBe(
      "approval-required",
    );
    expect(state.events).toEqual([]);
  });
  test("pickup precedes every effect and the run reports actual request charges", async () => {
    const state = fixture();
    const report = await state.run();
    expect(state.events).toEqual([
      "reserve",
      "pickup:first",
      "run:first",
      "pickup:second",
      "run:second",
    ]);
    expect(report.attempted).toBe(2);
    expect(report.requests).toBe(2);
  });
  test.each([
    "applied",
    "unchanged",
    "review-required",
    "failed",
    "isolated",
  ] as const)(
    "row outcome %s continues to the adjacent receipt",
    async (type) => {
      const state = fixture();
      state.dependencies.runRow = async (row) => {
        state.events.push(`run:${row.id}`);
        return Result.ok({ type });
      };
      const report = await state.run();
      expect(report.status).toBe("completed");
      expect(report.attempted).toBe(2);
    },
  );
  test.each(["retryable", "publisher-refused"] as const)(
    "%s stops the tick before a second pickup",
    async (type) => {
      const state = fixture();
      state.dependencies.runRow = async () =>
        Result.ok(
          type === "publisher-refused"
            ? { type, retryAt: new Date(1000) }
            : { type },
        );
      const report = await state.run();
      expect(report.status).toBe(type === "retryable" ? "failed" : type);
      expect(state.events).toEqual(["reserve", "pickup:first"]);
    },
  );
  test.each(["mirror-repair-required", "withdrawn"] as const)(
    "%s cannot supply healthy evidence for isolating the adjacent document",
    async (type) => {
      const state = fixture();
      const evidence: EuCompletionRowOptions["healthyEvidence"][] = [];
      state.dependencies.runRow = async (row, options) => {
        if (row.id === "first") {
          return Result.ok({ type });
        }
        evidence.push(options.healthyEvidence);
        return Result.ok({ type: "dry-run" });
      };
      const report = await state.run();
      expect(evidence).toEqual(["none"]);
      expect(report.status).toBe("completed");
      expect(report.noProgress).toBe(0);
    },
  );
  test("returned Err from a check after pickup stops effects, refunds its attempt and leaves following receipts untouched", async () => {
    const state = fixture();
    state.dependencies.runRow = async (_row, options) => {
      state.disable();
      const checked = await options.check();
      if (checked.isErr()) {
        return checked;
      }
      state.events.push("unexpected-effect");
      return Result.ok({ type: "applied" });
    };
    const report = await state.run();
    expect(report.status).toBe("off");
    expect(state.events).toEqual(["reserve", "pickup:first", "refund:first"]);
  });
  test("soft deadline stops before the next pickup", async () => {
    const state = fixture();
    state.dependencies.runRow = async () => {
      state.setTime(4 * 60_000);
      return Result.ok({ type: "dry-run" });
    };
    expect((await state.run()).status).toBe("time-limit");
    expect(state.events).toEqual(["reserve", "pickup:first"]);
  });
  test("hard cancellation during work is durably refunded", async () => {
    const state = fixture();
    state.dependencies.runRow = async () =>
      Result.err(
        new EuCompletionStop({
          message: "fixture deadline",
          reason: "cancelled",
        }),
      );
    expect((await state.run()).status).toBe("cancelled");
    expect(state.events).toEqual(["reserve", "pickup:first", "refund:first"]);
  });
});

test("a publisher refusal holds completion no longer than the hold cap", () => {
  const now = 1_000_000;
  const max = EU_COMPLETION_STORE_LIMITS.refusalMaxHoldMs;
  expect(capRefusalHold(now + 60_000, now)).toBe(now + 60_000);
  expect(capRefusalHold(now + max, now)).toBe(now + max);
  expect(capRefusalHold(now + max + 1, now)).toBe(now + max);
  expect(capRefusalHold(Number.MAX_SAFE_INTEGER, now)).toBe(now + max);
});
