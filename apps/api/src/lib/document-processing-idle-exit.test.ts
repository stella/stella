import { describe, expect, test } from "bun:test";

import { createIdleExitCheck } from "@/api/lib/document-processing-idle-exit";
import type { IdleExitReason } from "@/api/lib/document-processing-idle-exit";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";

/**
 * The class these pin: an idle-exit decision driven by asynchronous
 * samples must be a function of completed, non-overlapping, consecutive
 * observations — never of timer cadence, in-flight reordering, or failed
 * counts. Each rule is exercised deterministically by driving the tick
 * directly.
 */

/** Far enough off that only the tests about the cap ever reach it. */
const UNREACHED_QUIET_CAP = 1000;
/** Long enough that only a read built never to settle can miss it. */
const GENEROUS_SAMPLE_TIMEOUT_MS = 60_000;
/** Short enough to keep a test built on a read that never settles fast. */
const SHORT_SAMPLE_TIMEOUT_MS = 5;

const harness = (
  requiredIdleChecks: number,
  counts: () => Promise<number>,
  hasUnfinishedReconciliation: () => Promise<boolean> = async () => false,
  {
    maxQuietChecks = UNREACHED_QUIET_CAP,
    sampleTimeoutMs = GENEROUS_SAMPLE_TIMEOUT_MS,
  }: { maxQuietChecks?: number; sampleTimeoutMs?: number } = {},
) => {
  const exitReasons: IdleExitReason[] = [];
  const failures: unknown[] = [];
  let samples = 0;
  const holdsAtSample: number[] = [];
  const check = createIdleExitCheck({
    countPending: counts,
    hasUnfinishedReconciliation,
    isReconciliationInFlight: () => false,
    maxQuietChecks,
    reconciliationGeneration: () => 0,
    requiredIdleChecks,
    sampleTimeoutMs,
    onIdleExit: (reason) => {
      exitReasons.push(reason);
    },
    onCheckFailure: (error) => {
      failures.push(error);
    },
    onReconciliationHold: () => {
      holdsAtSample.push(samples);
    },
  });
  const tick = async () => {
    samples += 1;
    return await check();
  };
  return {
    tick,
    exitReasons: () => exitReasons,
    exits: () => exitReasons.length,
    failureErrors: () => failures,
    failures: () => failures.length,
    holdsAtSample: () => holdsAtSample,
  };
};

/** A read that never settles, as a count on a dead connection would. */
const HANG = Symbol("hang");

const neverSettles = new Promise<never>(() => {});

const hung = async <T>(): Promise<T> => await neverSettles;

const sequence = (values: (number | Error | typeof HANG)[]) => {
  let index = 0;
  return async () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    if (value instanceof Error) {
      throw value;
    }
    if (value === HANG) {
      return await hung<number>();
    }
    return value ?? 0;
  };
};

describe("createIdleExitCheck", () => {
  test("exits only after the required consecutive empty samples", async () => {
    const h = harness(3, sequence([0, 0, 0]));
    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("exit");
    expect(h.exits()).toBe(1);
  });

  test("a busy sample resets the streak", async () => {
    const h = harness(2, sequence([0, 5, 0, 0]));
    await h.tick();
    await h.tick();
    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("exit");
  });

  test("a failed count resets the streak instead of exiting", async () => {
    const h = harness(2, sequence([0, new Error("redis down"), 0, 0]));
    await h.tick();
    await h.tick();
    expect(h.failures()).toBe(1);
    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("exit");
  });

  test("overlapping ticks are skipped, not double-counted", async () => {
    const resolvers: ((value: number) => void)[] = [];
    const h = harness(
      2,
      async () =>
        await new Promise<number>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    // A sample settles the reconciliation verdict before it counts, so let
    // it reach the count before handing one over.
    const countStarted = async () => await Bun.sleep(0);

    const first = h.tick();
    // The first sample is still in flight: further ticks must not start
    // a second count or advance the streak.
    expect(await h.tick()).toBe("skipped");
    expect(await h.tick()).toBe("skipped");
    await countStarted();
    expect(resolvers).toHaveLength(1);

    resolvers.shift()?.(0);
    expect(await first).toBe("checked");

    const second = h.tick();
    await countStarted();
    resolvers.shift()?.(0);
    expect(await second).toBe("exit");
  });

  test("an empty queue is not idle while reconciliation has work behind it", async () => {
    const h = harness(2, sequence([0, 0, 0, 0]), async () => true);
    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("checked");
    expect(h.exits()).toBe(0);
  });

  test("reconciliation draining mid-streak resets it", async () => {
    let unfinished = false;
    const h = harness(2, sequence([0, 0, 0, 0]), async () => unfinished);
    await h.tick();
    unfinished = true;
    // The streak must restart from this sample, not resume where it left off.
    expect(await h.tick()).toBe("checked");
    unfinished = false;
    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("exit");
  });

  test("a reconciliation that starts after the verdict is caught by the next sample", async () => {
    let unfinished = false;
    let exits = 0;
    const tick = createIdleExitCheck({
      countPending: async () => {
        // Reconciliation ticks are timer-driven, so one can begin after
        // this sample read its verdict. It marks itself unfinished before
        // its own first await, which is what the next sample reads.
        unfinished = true;
        return 0;
      },
      hasUnfinishedReconciliation: async () => unfinished,
      isReconciliationInFlight: () => false,
      maxQuietChecks: UNREACHED_QUIET_CAP,
      reconciliationGeneration: () => 0,
      requiredIdleChecks: 2,
      sampleTimeoutMs: GENEROUS_SAMPLE_TIMEOUT_MS,
      onIdleExit: () => {
        exits += 1;
      },
      onCheckFailure: () => undefined,
      onReconciliationHold: () => undefined,
    });

    expect(await tick()).toBe("checked");
    // The streak cannot span the tick that started inside the sample
    // before it.
    expect(await tick()).toBe("checked");
    expect(exits).toBe(0);
  });

  /**
   * A reconciliation tick that crosses a sample's count leaves the
   * sample's readings describing different moments. The sample measures
   * again rather than calling the moment busy, so what decides it is the
   * crossing tick's own verdict.
   */
  const crossedHarness = ({
    crossEveryCount,
    leftWorkBehind,
    requiredIdleChecks,
  }: {
    crossEveryCount: boolean;
    leftWorkBehind: boolean;
    requiredIdleChecks: number;
  }) => {
    let counts = 0;
    let exits = 0;
    let generation = 0;
    let running = false;
    let unfinished = false;
    const tick = createIdleExitCheck({
      countPending: async () =>
        await Promise.resolve(0).then((pending) => {
          counts += 1;
          // The reconcile timer fires while the count is in flight. With
          // `crossEveryCount` it fires during every one, which is what a
          // sampler phase-locked inside reconciliation would see.
          if (crossEveryCount || counts % 2 === 1) {
            generation += 1;
            running = true;
          }
          return pending;
        }),
      hasUnfinishedReconciliation: async () => {
        // Waiting for a tick in flight is what completes it, and its
        // verdict is what this sample gets.
        if (running) {
          running = false;
          unfinished = leftWorkBehind;
        }
        return unfinished;
      },
      isReconciliationInFlight: () => running,
      maxQuietChecks: UNREACHED_QUIET_CAP,
      reconciliationGeneration: () => generation,
      requiredIdleChecks,
      sampleTimeoutMs: GENEROUS_SAMPLE_TIMEOUT_MS,
      onIdleExit: () => {
        exits += 1;
      },
      onCheckFailure: () => undefined,
      onReconciliationHold: () => undefined,
    });
    return { counts: () => counts, exits: () => exits, tick };
  };

  test("a sample crossed by a saturated tick reads that tick's verdict", async () => {
    const h = crossedHarness({
      crossEveryCount: false,
      leftWorkBehind: true,
      requiredIdleChecks: 1,
    });

    expect(await h.tick()).toBe("checked");
    expect(h.exits()).toBe(0);
  });

  test("samples crossed by drained ticks still complete the streak", async () => {
    // The livelock shape: every sample's count is crossed by a tick that
    // reports drained. Reading the crossing as busy would reset the streak
    // forever on a system with nothing left to do.
    const h = crossedHarness({
      crossEveryCount: false,
      leftWorkBehind: false,
      requiredIdleChecks: 2,
    });

    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("exit");
    expect(h.exits()).toBe(1);
  });

  test("a producer that crosses every count is conceded, not chased forever", async () => {
    const h = crossedHarness({
      crossEveryCount: true,
      leftWorkBehind: false,
      requiredIdleChecks: 1,
    });

    expect(await h.tick()).toBe("checked");
    expect(h.exits()).toBe(0);
    // It measured again rather than deciding on the first reading, and
    // stopped rather than spinning.
    expect(h.counts()).toBeGreaterThan(1);
    expect(h.counts()).toBeLessThan(8);
  });

  test("a final sample with nothing running still exits", async () => {
    const h = harness(1, sequence([0]));

    expect(await h.tick()).toBe("exit");
    expect(h.exits()).toBe(1);
  });

  test("exit fires exactly once; later ticks are inert", async () => {
    const h = harness(1, sequence([0, 0, 0]));
    expect(await h.tick()).toBe("exit");
    expect(await h.tick()).toBe("skipped");
    expect(await h.tick()).toBe("skipped");
    expect(h.exitReasons()).toEqual(["idle"]);
  });
});

/**
 * The class these pin: no single read, and no reconciliation phase that
 * never settles, can keep a batch worker alive indefinitely. A read that
 * hangs ends at the sample deadline, and a queue that stays quiet for the
 * cap ends the process however reconciliation answers, while the strict
 * path keeps every guarantee it had.
 */
describe("idle exit under reads that never settle", () => {
  test("a hung count is a failed sample that resets the strict streak", async () => {
    const h = harness(2, sequence([0, HANG, 0, 0]), async () => false, {
      sampleTimeoutMs: SHORT_SAMPLE_TIMEOUT_MS,
    });

    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("checked");
    expect(h.failures()).toBe(1);
    expect(TimeoutError.is(h.failureErrors()[0])).toBe(true);
    // The streak restarts after the failure rather than counting it.
    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("exit");
    expect(h.exitReasons()).toEqual(["idle"]);
  });

  test("counts that keep hanging are quiet, so the cap still ends the process", async () => {
    const h = harness(2, sequence([HANG]), async () => false, {
      maxQuietChecks: 3,
      sampleTimeoutMs: SHORT_SAMPLE_TIMEOUT_MS,
    });

    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("exit");
    expect(h.failures()).toBe(3);
    expect(h.exitReasons()).toEqual(["quiet_cap"]);
  });

  test("a hung reconciliation wait is unfinished work, not a failure, and the cap ends it once", async () => {
    const h = harness(2, sequence([0]), hung<boolean>, {
      maxQuietChecks: 3,
      sampleTimeoutMs: SHORT_SAMPLE_TIMEOUT_MS,
    });

    expect(await h.tick()).toBe("checked");
    // Not idle: a strict-path worker would have exited here.
    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("exit");
    expect(await h.tick()).toBe("skipped");
    expect(h.failures()).toBe(0);
    expect(h.exitReasons()).toEqual(["quiet_cap"]);
  });

  test("a pending job restarts the quiet streak", async () => {
    const h = harness(2, sequence([0, 0, 5, 0, 0, 0]), async () => true, {
      maxQuietChecks: 3,
    });

    for (let sample = 1; sample <= 5; sample += 1) {
      expect(await h.tick()).toBe("checked");
    }
    // Without the reset, the fourth sample would already be past the cap.
    expect(await h.tick()).toBe("exit");
    expect(h.exitReasons()).toEqual(["quiet_cap"]);
  });

  test("the hold is reported once, on the sample the queue alone would have exited on", async () => {
    const h = harness(2, sequence([0, 0, 5, 0, 0, 0]), async () => true, {
      maxQuietChecks: 3,
    });

    for (let sample = 1; sample <= 6; sample += 1) {
      await h.tick();
    }
    // The quiet streak reached the idle window on the second sample and
    // again on the fifth; only the first is reported.
    expect(h.holdsAtSample()).toEqual([2]);
  });

  test("the hold is never reported when the strict path exits first", async () => {
    const h = harness(3, sequence([0]), async () => false, {
      maxQuietChecks: 5,
    });

    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("exit");
    expect(h.exitReasons()).toEqual(["idle"]);
    expect(h.holdsAtSample()).toEqual([]);
  });

  test("a cap shorter than the idle window is refused", () => {
    expect(() =>
      harness(3, sequence([0]), async () => false, { maxQuietChecks: 2 }),
    ).toThrow("maxQuietChecks (2) is below requiredIdleChecks (3)");
  });
});
