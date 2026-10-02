import { expect, test } from "bun:test";

import { defaultConfig, initialBatchState } from "@stll/db-load-gate/health";

import {
  runBackgroundReplayTick,
  type BackgroundReplayBatch,
  type BackgroundReplayDependencies,
  type BackgroundReplaySource,
} from "@/api/handlers/case-law/ingestion/background-replay";
import type { ReplayRunReport } from "@/api/handlers/case-law/ingestion/replay";
import { createSafeId } from "@/api/lib/branded-types";

import { ReplayStageError, replayFailure } from "./replay-failure";

const fixture = (dailyBudget = 3) => {
  const source: BackgroundReplaySource = {
    id: createSafeId<"caseLawSource">(),
    adapterKey: "cz-nss",
    currentParserVersion: 3,
    dailyBudget,
    mode: "enrolled",
    rowsBehind: 20,
  };
  let clock = Date.UTC(2026, 9, 1);
  let spent = 0;
  let completed = 0;
  let pending: BackgroundReplayBatch | null = null;
  let leased = false;
  let slotted = false;
  let writes = 0;
  const batch = (): BackgroundReplayBatch => ({
    id: `receipt-${spent}`,
    source,
    decisionId: createSafeId<"caseLawDecision">(),
    parserVersionFrom: 1,
    targetParserVersion: 3,
  });
  const success = (current: BackgroundReplayBatch): ReplayRunReport => ({
    visited: 1,
    outcomes: {
      applied: 1,
      unchanged: 0,
      "would-apply": 0,
      rejected: 0,
      "missing-payload": 0,
      retryable: 0,
      withdrawn: 0,
      "withdraw-incomplete": 0,
      "would-withdraw": 0,
    },
    rejections: {
      "incomplete-metadata": 0,
      "identity-mismatch": 0,
      "raw-fidelity-lost": 0,
      "unsupported-content": 0,
      "no-document": 0,
      supplement: 0,
    },
    problems: [],
    omittedProblems: 0,
    resumeAfter: current.decisionId,
    haltReason: null,
  });
  const dependencies: BackgroundReplayDependencies = {
    chooseSource: async () => source,
    killRequested: async () => false,
    acquireLease: async () => {
      if (leased) {
        return null;
      }
      leased = true;
      return async () => {
        leased = false;
      };
    },
    acquireHeavySlot: async () => {
      if (slotted) {
        return null;
      }
      slotted = true;
      return async () => {
        slotted = false;
      };
    },
    loadGateState: async () => null,
    saveGateState: async () => {
      writes += 1;
    },
    gate: async () => ({ kind: "normal", signals: [] }),
    pendingBatch: async () =>
      pending === null
        ? { type: "empty" }
        : { type: "reserved", batch: pending },
    reserveBatch: async () => {
      if (spent >= source.dailyBudget) {
        return { type: "budget-exhausted" };
      }
      spent += 1;
      pending = batch();
      writes += 1;
      return { type: "reserved", batch: pending };
    },
    previewBatch: async () => batch(),
    replay: async (current, { apply }) => {
      if (apply) {
        expect(leased).toBe(true);
        expect(slotted).toBe(true);
      }
      const report = success(current);
      if (!apply) {
        report.outcomes.applied = 0;
        report.outcomes["would-apply"] = 1;
      }
      return report;
    },
    completeBatch: async () => {
      pending = null;
      completed += 1;
      writes += 1;
      return "applied";
    },
    pickUpBatch: async () => "ready",
    recordFailure: async () => "retryable",
    advancePreview: async () => {},
    metric: () => {},
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
  };
  const run = async (maxRows = 10) =>
    runBackgroundReplayTick({
      dependencies,
      maxRows,
      maxDurationMs: 60_000,
      healthConfig: { ...defaultConfig, minSleepMs: 0 },
    });
  return {
    source,
    dependencies,
    run,
    success,
    counts: () => ({ spent, completed, writes, leased, slotted }),
    nextDay: () => {
      clock += 86_400_000;
      spent = 0;
    },
  };
};

test("every tick respects both the daily reservation budget and its own bound", async () => {
  for (let budget = 1; budget <= 8; budget += 1) {
    for (let limit = 1; limit <= 8; limit += 1) {
      const state = fixture(budget);
      const report = await state.run(limit);
      expect(report.applied).toBe(Math.min(budget, limit));
      expect(state.counts().spent).toBe(Math.min(budget, limit));
      expect(state.counts().completed).toBe(report.applied);
      expect(state.counts().leased).toBe(false);
      expect(state.counts().slotted).toBe(false);
    }
  }
});

test("invalid invocation bounds fail before reading or reserving a source", async () => {
  const cases = [
    ...[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY].map((maxRows) => ({
      maxRows,
    })),
    ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((maxDurationMs) => ({
      maxDurationMs,
    })),
  ];
  for (const bounds of cases) {
    const state = fixture();
    let selected = false;
    state.dependencies.chooseSource = async () => {
      selected = true;
      return state.source;
    };
    await expect(
      runBackgroundReplayTick({
        dependencies: state.dependencies,
        maxRows: 1,
        maxDurationMs: 60_000,
        ...bounds,
      }),
    ).rejects.toThrow("Replay tick bounds must be positive");
    expect(selected).toBe(false);
    expect(state.counts().spent).toBe(0);
  }
});

test("an empty selection exits without acquiring ownership or charging rows", async () => {
  const state = fixture();
  state.dependencies.chooseSource = async () => null;
  expect(await state.run()).toMatchObject({
    status: "empty",
    source: null,
    attempted: 0,
  });
  expect(state.counts()).toEqual({
    spent: 0,
    completed: 0,
    writes: 0,
    leased: false,
    slotted: false,
  });
});

test("budget exhaustion exits and a fresh UTC day's budget permits more work", async () => {
  const state = fixture(2);
  expect((await state.run()).status).toBe("budget-exhausted");
  expect((await state.run()).applied).toBe(0);
  state.nextDay();
  expect((await state.run()).applied).toBe(2);
});

test("a gate stop after one row holds without reserving the next row", async () => {
  const state = fixture();
  state.dependencies.gate = async () => ({
    kind: state.counts().completed === 0 ? "normal" : "unknown",
    signals: [],
  });
  const report = await state.run();
  expect(report.status).toBe("held");
  expect(state.counts().spent).toBe(1);
  expect(state.counts().completed).toBe(1);
});

test("kill switches at batch boundaries and during health I/O prevent new reservations", async () => {
  const state = fixture();
  state.dependencies.killRequested = async () => state.counts().completed === 1;
  expect((await state.run()).status).toBe("killed");
  expect(state.counts().spent).toBe(1);
  const duringHealth = fixture();
  let killed = false;
  duringHealth.dependencies.killRequested = async () => killed;
  duringHealth.dependencies.gate = async () => {
    killed = true;
    return { kind: "normal", signals: [] };
  };
  expect((await duringHealth.run()).status).toBe("killed");
  expect(duringHealth.counts().spent).toBe(0);
});

test("dry runs never acquire writing ownership or mutate durable state", async () => {
  const state = fixture();
  state.source.mode = "dry-run";
  const report = await state.run(4);
  expect(report.attempted).toBe(3);
  expect(report.applied).toBe(0);
  expect(state.counts()).toEqual({
    spent: 0,
    completed: 0,
    writes: 0,
    leased: false,
    slotted: false,
  });
});

test("cancellation or elapsed bounds during admission prevent replay and release ownership", async () => {
  for (const boundary of ["slot", "pending", "reservation"] as const) {
    for (const stop of ["killed", "time-limit"] as const) {
      const state = fixture();
      let killed = false;
      state.dependencies.killRequested = async () => killed;
      const interrupt = async () => {
        if (stop === "killed") {
          killed = true;
        } else {
          await state.dependencies.sleep(60_000);
        }
      };
      if (boundary === "slot") {
        const acquire = state.dependencies.acquireHeavySlot;
        state.dependencies.acquireHeavySlot = async () => {
          const release = await acquire();
          await interrupt();
          return release;
        };
      } else if (boundary === "pending") {
        const pending = state.dependencies.pendingBatch;
        state.dependencies.pendingBatch = async (...args) => {
          const result = await pending(...args);
          await interrupt();
          return result;
        };
      } else {
        const reserve = state.dependencies.reserveBatch;
        state.dependencies.reserveBatch = async (...args) => {
          const result = await reserve(...args);
          await interrupt();
          return result;
        };
      }
      const report = await state.run();
      expect(report.status).toBe(stop);
      expect(report.attempted).toBe(0);
      expect(state.counts().spent).toBe(boundary === "reservation" ? 1 : 0);
      expect(state.counts().completed).toBe(0);
      expect(state.counts().leased).toBe(false);
      expect(state.counts().slotted).toBe(false);
    }
  }
});

test("overlapping ticks admit only one owner while replay waits on external I/O", async () => {
  const state = fixture();
  const entered = Promise.withResolvers<undefined>();
  const resume = Promise.withResolvers<undefined>();
  state.dependencies.replay = async (batch) => {
    entered.resolve(undefined);
    await resume.promise;
    return state.success(batch);
  };
  const first = state.run(1);
  await entered.promise;
  expect((await state.run(1)).status).toBe("lease-unavailable");
  expect(state.counts().spent).toBe(1);
  resume.resolve(undefined);
  expect((await first).applied).toBe(1);
  expect(state.counts().completed).toBe(1);
});

test("a failed receipt completion resumes the charged reservation before selecting new work", async () => {
  const state = fixture(1);
  const complete = state.dependencies.completeBatch;
  state.dependencies.completeBatch = async () => {
    throw new TypeError("receipt unavailable");
  };
  const failed = await state.run();
  expect(failed.errors).toBe(1);
  expect(failed.applied).toBe(0);
  expect(state.counts().spent).toBe(1);
  expect(state.counts().leased).toBe(false);
  state.dependencies.completeBatch = complete;
  const report = await state.run();
  expect(report.applied).toBe(1);
  expect(state.counts().spent).toBe(1);
  expect(state.counts().completed).toBe(1);
});

test("retryable outcomes persist a deferred receipt before ending a bounded tick", async () => {
  const state = fixture(1);
  state.dependencies.replay = async (batch) => {
    const report = state.success(batch);
    report.outcomes.applied = 0;
    report.outcomes.retryable = 1;
    return report;
  };
  expect((await state.run()).status).toBe("failed");
  expect(state.counts().completed).toBe(0);
  state.dependencies.replay = async (batch) => state.success(batch);
  expect((await state.run()).applied).toBe(1);
  expect(state.counts().spent).toBe(1);
});

test("a halted replay without visited rows never completes its reservation", async () => {
  const state = fixture();
  state.dependencies.replay = async (batch) => {
    const report = state.success(batch);
    report.visited = 0;
    report.outcomes.applied = 0;
    report.haltReason = "source lease lost";
    return report;
  };
  const report = await state.run();
  expect(report.status).toBe("failed");
  expect(report.errors).toBe(1);
  expect(state.counts().completed).toBe(0);
});

test("higher priority work can claim the heavy slot at the next batch boundary", async () => {
  const state = fixture();
  const acquire = state.dependencies.acquireHeavySlot;
  state.dependencies.acquireHeavySlot = async () =>
    state.counts().completed === 0 ? acquire() : null;
  expect((await state.run()).status).toBe("slot-unavailable");
  expect(state.counts().completed).toBe(1);
  expect(state.counts().spent).toBe(1);
  expect(state.counts().leased).toBe(false);
  expect(state.counts().slotted).toBe(false);
});

test("a deferred throwing row yields to later rows within the same tick", async () => {
  const state = fixture(4);
  const pending = state.dependencies.pendingBatch;
  let deferred = false;
  const seen: string[] = [];
  const failures: string[] = [];
  state.dependencies.pendingBatch = async (...args) =>
    deferred ? { type: "empty" } : await pending(...args);
  state.dependencies.recordFailure = async (batch, failure) => {
    deferred = true;
    failures.push(batch.id);
    expect(failure).toMatchObject({
      code: "adapter-exception",
      messageClass: "adapter",
      scope: "row",
    });
    return "retryable";
  };
  state.dependencies.replay = async (batch) => {
    seen.push(batch.id);
    if (seen.length === 1) {
      throw new ReplayStageError({
        message: "fixture exception with content that must not persist",
        failure: replayFailure("adapter-exception"),
      });
    }
    return state.success(batch);
  };
  const report = await state.run(4);
  expect(failures).toEqual(seen.slice(0, 1));
  expect(new Set(seen).size).toBe(4);
  expect(report).toMatchObject({
    attempted: 4,
    errors: 1,
    applied: 3,
    failed: 0,
  });
  expect(state.counts().leased).toBe(false);
  expect(state.counts().slotted).toBe(false);
});

test("tick counts use the verified completion disposition rather than the replay claim", async () => {
  const state = fixture(1);
  state.dependencies.completeBatch = async () => "blocked";
  const report = await state.run(1);
  expect(report.applied).toBe(0);
  expect(report.blocked).toBe(1);
});

test("a persisted hold short-circuits before a lease or reservation", async () => {
  const state = fixture(1);
  state.dependencies.loadGateState = async () => ({
    ...initialBatchState(),
    heldSince: state.dependencies.now(),
    holdUntil: state.dependencies.now() + 60_000,
  });
  state.dependencies.acquireLease = async () => {
    throw new TypeError("held tick reached lease");
  };
  expect((await state.run()).status).toBe("held");
  expect(state.counts().spent).toBe(0);
});

test("an unknown or failed preflight gate never selects or leases a source", async () => {
  for (const kind of ["unknown", "stop", "error"] as const) {
    const state = fixture();
    state.dependencies.chooseSource = async () => {
      throw new TypeError("held tick reached probe");
    };
    state.dependencies.gate = async () => {
      if (kind === "error") {
        throw new TypeError("fixture gate unavailable");
      }
      return { kind, signals: [] };
    };
    expect((await state.run()).status).toBe("held");
    expect(state.counts().writes).toBe(0);
  }
});

test("a dry run records each preview cursor without completing an apply reservation", async () => {
  const state = fixture(3);
  state.source.mode = "dry-run";
  const previews: string[] = [];
  state.dependencies.advancePreview = async (batch) => {
    previews.push(batch.decisionId);
  };
  expect((await state.run(3)).attempted).toBe(3);
  expect(previews).toHaveLength(3);
  expect(state.counts().spent).toBe(0);
  expect(state.counts().completed).toBe(0);
});

test("systemic failures stop before another row, while pick-up precedes every writer", async () => {
  for (const code of [
    "stored-raw-read",
    "receipt-write",
    "writer-retryable",
    "unexpected",
  ] as const) {
    const state = fixture(20);
    let pickedUp = false;
    let settlements = 0;
    state.dependencies.pickUpBatch = async () => {
      pickedUp = true;
      return "ready";
    };
    state.dependencies.replay = async () => {
      expect(pickedUp).toBe(true);
      throw new ReplayStageError({
        message: "fixture outage",
        failure: replayFailure(code),
      });
    };
    state.dependencies.recordFailure = async (_batch, failure) => {
      expect(failure.scope).toBe("systemic");
      settlements += 1;
      return "retryable";
    };
    expect(await state.run(20)).toMatchObject({
      status: "failed",
      attempted: 1,
      failed: 0,
    });
    expect(settlements).toBe(1);
    expect(state.counts().leased).toBe(false);
    expect(state.counts().slotted).toBe(false);
  }
});

test("the hard deadline settles as systemic and yields a successful time limit", async () => {
  const state = fixture();
  const controller = new AbortController();
  state.dependencies.replay = async () => {
    controller.abort();
    throw controller.signal.reason;
  };
  let settled = false;
  state.dependencies.recordFailure = async (_batch, failure) => {
    expect(failure).toMatchObject({ code: "tick-deadline", scope: "systemic" });
    settled = true;
    return "retryable";
  };
  const report = await runBackgroundReplayTick({
    dependencies: state.dependencies,
    maxRows: 3,
    maxDurationMs: 60_000,
    signal: controller.signal,
  });
  expect(report.status).toBe("time-limit");
  expect(settled).toBe(true);
});

test("a crash-exhausted pickup yields to the next row without invoking its writer", async () => {
  const state = fixture(3);
  const pending = state.dependencies.pendingBatch;
  let exhausted = false;
  state.dependencies.pendingBatch = async (...args) =>
    exhausted ? { type: "empty" } : await pending(...args);
  state.dependencies.pickUpBatch = async () => {
    if (!exhausted) {
      exhausted = true;
      return "failed";
    }
    return "ready";
  };
  const report = await state.run(3);
  expect(report).toMatchObject({
    status: "row-limit",
    attempted: 3,
    failed: 1,
    applied: 2,
  });
  expect(state.counts().completed).toBe(2);
  expect(state.counts().leased).toBe(false);
  expect(state.counts().slotted).toBe(false);
});

test("an isolated systemic row yields while a real outage stops without exhausting a row", async () => {
  for (const disposition of ["isolated", "retryable"] as const) {
    const state = fixture(4);
    const pending = state.dependencies.pendingBatch;
    let deferred = false;
    let work = 0;
    state.dependencies.pendingBatch = async (...args) =>
      deferred ? { type: "empty" } : await pending(...args);
    state.dependencies.replay = async (batch) => {
      work += 1;
      if (work === 1) {
        throw new ReplayStageError({
          message: "fixture row timeout",
          failure: replayFailure("stored-raw-timeout"),
        });
      }
      return state.success(batch);
    };
    state.dependencies.recordFailure = async () => {
      deferred = true;
      return disposition;
    };
    const result = await state.run(4);
    expect(result).toMatchObject(
      disposition === "isolated"
        ? { status: "row-limit", attempted: 4, applied: 3, failed: 0 }
        : { status: "failed", attempted: 1, applied: 0, failed: 0 },
    );
  }
});
