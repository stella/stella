import { Result } from "better-result";
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

import {
  REPLAY_FAILURE_CODES,
  ReplayStageError,
  replayFailure,
} from "./replay-failure";

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
  let preview: BackgroundReplayBatch | null = null;
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
    previewBatch: async () => {
      if (preview === null) {
        if (spent >= source.dailyBudget) {
          return { type: "budget-exhausted" };
        }
        spent += 1;
        preview = batch();
      }
      writes += 1;
      return { type: "reserved", batch: preview };
    },
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
    advancePreview: async () => {
      preview = null;
      writes += 1;
    },
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
    const result = await Result.tryPromise({
      try: async () =>
        await runBackgroundReplayTick({
          dependencies: state.dependencies,
          maxRows: 1,
          maxDurationMs: 60_000,
          ...bounds,
        }),
      catch: (cause) => cause,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toMatchObject({
        message: "Replay tick bounds must be positive",
      });
    }
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

test("dry runs charge durable admission without acquiring apply ownership", async () => {
  const state = fixture();
  state.source.mode = "dry-run";
  const report = await state.run(4);
  expect(report.attempted).toBe(3);
  expect(report.applied).toBe(0);
  expect(state.counts()).toEqual({
    spent: 3,
    completed: 0,
    writes: 6,
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
  const advance = state.dependencies.advancePreview;
  state.dependencies.advancePreview = async (batch) => {
    previews.push(batch.decisionId);
    await advance(batch);
  };
  expect((await state.run(3)).attempted).toBe(3);
  expect(new Set(previews).size).toBe(3);
  expect(state.counts().spent).toBe(3);
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

test("exhausted and terminal pickups remain visible and yield without invoking their writer", async () => {
  for (const outcome of ["retry-exhausted", "retry-terminal"] as const) {
    const state = fixture(3);
    const pending = state.dependencies.pendingBatch;
    let exhausted = false;
    state.dependencies.pendingBatch = async (...args) =>
      exhausted ? { type: "empty" } : await pending(...args);
    state.dependencies.pickUpBatch = async () => {
      if (!exhausted) {
        exhausted = true;
        return outcome;
      }
      return "ready";
    };
    const report = await state.run(3);
    expect(report).toMatchObject({
      status: "row-limit",
      attempted: 3,
      failed: 1,
      errors: 1,
      applied: 2,
      retryExhausted: Number(outcome === "retry-exhausted"),
      retryTerminal: Number(outcome === "retry-terminal"),
    });
    expect(state.counts().completed).toBe(2);
    expect(state.counts().leased).toBe(false);
    expect(state.counts().slotted).toBe(false);
  }
});

test("completion and failure settlement expose exhausted and terminal rows while allowing later work", async () => {
  for (const outcome of ["retry-exhausted", "retry-terminal"] as const) {
    for (const path of ["completion", "failure"] as const) {
      const state = fixture(2);
      let first = true;
      if (path === "completion") {
        const complete = state.dependencies.completeBatch;
        state.dependencies.completeBatch = async (...args) => {
          if (first) {
            first = false;
            return outcome;
          }
          return await complete(...args);
        };
      } else {
        state.dependencies.recordFailure = async () => outcome;
        state.dependencies.replay = async (batch) => {
          if (first) {
            first = false;
            throw new ReplayStageError({
              message: "fixture systemic failure",
              failure: replayFailure("adapter-exception"),
            });
          }
          return state.success(batch);
        };
      }
      expect(await state.run(2)).toMatchObject({
        status: "row-limit",
        attempted: 2,
        failed: 1,
        errors: 1,
        applied: 1,
        retryExhausted: Number(outcome === "retry-exhausted"),
        retryTerminal: Number(outcome === "retry-terminal"),
      });
    }
  }
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

test("dry-run failures preserve the cursor and retry the same charged row on the next tick", async () => {
  for (const code of REPLAY_FAILURE_CODES) {
    for (const outcome of ["report", "throw"] as const) {
      const state = fixture(1);
      state.source.mode = "dry-run";
      const failure = replayFailure(code);
      const seen: string[] = [];
      const recorded: string[] = [];
      const advanced: string[] = [];
      const advance = state.dependencies.advancePreview;
      state.dependencies.advancePreview = async (batch) => {
        advanced.push(batch.decisionId);
        await advance(batch);
      };
      state.dependencies.recordFailure = async (batch, recordedFailure) => {
        expect(recordedFailure).toMatchObject(failure);
        recorded.push(batch.decisionId);
        return "retryable";
      };
      state.dependencies.replay = async (batch, { apply }) => {
        expect(apply).toBe(false);
        seen.push(batch.decisionId);
        if (outcome === "throw") {
          throw new ReplayStageError({
            message: "fixture preview failure",
            failure,
          });
        }
        const report = state.success(batch);
        report.outcomes.applied = 0;
        report.outcomes.retryable = 1;
        report.failure = failure;
        return report;
      };
      const failed = await state.run(10);
      const failureStatus = failure.scope === "row" ? "retryable" : "failed";
      expect(failed).toMatchObject({
        status: code === "tick-deadline" ? "time-limit" : failureStatus,
        attempted: 1,
        errors: 1,
        applied: 0,
      });
      expect(recorded).toEqual(seen);
      expect(recorded).toHaveLength(1);
      expect(advanced).toEqual([]);
      expect(state.counts().spent).toBe(1);
      state.dependencies.replay = async (batch) => {
        seen.push(batch.decisionId);
        const report = state.success(batch);
        report.outcomes.applied = 0;
        report.outcomes["would-apply"] = 1;
        return report;
      };
      expect((await state.run(1)).attempted).toBe(1);
      expect(seen).toHaveLength(2);
      expect(new Set(seen).size).toBe(1);
      expect(advanced).toEqual(recorded);
      expect(recorded).toHaveLength(1);
      expect(state.counts().spent).toBe(1);
      expect(state.counts().completed).toBe(0);
    }
  }
});

test("terminal dry-run failures count as reviewed failures and allow later previews", async () => {
  const state = fixture(10);
  state.source.mode = "dry-run";
  const seen: string[] = [];
  const advance = state.dependencies.advancePreview;
  state.dependencies.recordFailure = async (batch) => {
    // The store atomically persists the terminal receipt and preview cursor.
    await advance(batch);
    return "failed";
  };
  state.dependencies.replay = async (batch) => {
    seen.push(batch.decisionId);
    const report = state.success(batch);
    report.outcomes.applied = 0;
    if (seen.length === 1) {
      report.outcomes.retryable = 1;
      report.failure = replayFailure("adapter-exception");
    } else {
      report.outcomes["would-apply"] = 1;
    }
    return report;
  };
  expect(await state.run(2)).toMatchObject({
    status: "row-limit",
    attempted: 2,
    failed: 1,
    errors: 1,
    applied: 0,
  });
  expect(new Set(seen).size).toBe(2);
});

test("dry-run retryable or halted reports without failure metadata never advance the cursor", async () => {
  for (const outcome of [
    "retryable",
    "withdraw-incomplete",
    "halted",
  ] as const) {
    const state = fixture(1);
    state.source.mode = "dry-run";
    let recorded = 0;
    let advanced = 0;
    state.dependencies.recordFailure = async (_batch, failure) => {
      expect(failure).toMatchObject({
        code: "writer-retryable",
        scope: "systemic",
      });
      recorded += 1;
      return "retryable";
    };
    state.dependencies.advancePreview = async () => {
      advanced += 1;
    };
    state.dependencies.replay = async (batch) => {
      const report = state.success(batch);
      report.outcomes.applied = 0;
      if (outcome === "halted") {
        report.visited = 0;
        report.haltReason = "source lease lost";
      } else {
        report.outcomes[outcome] = 1;
      }
      return report;
    };
    expect(await state.run(10)).toMatchObject({
      status: "failed",
      attempted: 1,
      errors: 1,
    });
    expect(recorded).toBe(1);
    expect(advanced).toBe(0);
  }
});

test("dry-run admission propagates exhaustion and deferred retries without using apply receipts", async () => {
  for (const admission of ["budget-exhausted", "waiting", "empty"] as const) {
    const state = fixture();
    state.source.mode = "dry-run";
    state.dependencies.previewBatch = async () => ({ type: admission });
    state.dependencies.pendingBatch = async () => {
      throw new TypeError("preview reached apply recovery");
    };
    state.dependencies.reserveBatch = async () => {
      throw new TypeError("preview reached apply reservation");
    };
    state.dependencies.pickUpBatch = async () => {
      throw new TypeError("preview reached apply pickup");
    };
    state.dependencies.completeBatch = async () => {
      throw new TypeError("preview reached apply completion");
    };
    state.dependencies.replay = async () => {
      throw new TypeError("unadmitted preview reached replay");
    };
    const statuses = {
      "budget-exhausted": "budget-exhausted",
      waiting: "retryable",
      empty: "complete",
    } as const;
    expect(await state.run()).toMatchObject({
      status: statuses[admission],
      attempted: 0,
      errors: 0,
    });
    expect(state.counts().spent).toBe(0);
  }
});

test("dry-run ticks share a durable UTC-day budget with apply reservations", async () => {
  const state = fixture(3);
  state.source.mode = "dry-run";
  expect((await state.run(2)).attempted).toBe(2);
  expect(await state.run(2)).toMatchObject({
    status: "budget-exhausted",
    attempted: 1,
  });
  expect(await state.run(2)).toMatchObject({
    status: "budget-exhausted",
    attempted: 0,
  });
  state.source.mode = "enrolled";
  expect(await state.run(2)).toMatchObject({
    status: "budget-exhausted",
    attempted: 0,
  });
  expect(state.counts().spent).toBe(3);
  state.nextDay();
  expect((await state.run(2)).applied).toBe(2);
});
