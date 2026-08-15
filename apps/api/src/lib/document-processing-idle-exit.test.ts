import { describe, expect, test } from "bun:test";

import { createIdleExitCheck } from "@/api/lib/document-processing-idle-exit";

/**
 * The class these pin: an idle-exit decision driven by asynchronous
 * samples must be a function of completed, non-overlapping, consecutive
 * observations — never of timer cadence, in-flight reordering, or failed
 * counts. Each rule is exercised deterministically by driving the tick
 * directly.
 */

const harness = (
  requiredIdleChecks: number,
  counts: () => Promise<number>,
  hasUnfinishedReconciliation: () => Promise<boolean> = async () => false,
) => {
  let exits = 0;
  let failures = 0;
  const tick = createIdleExitCheck({
    countPending: counts,
    hasUnfinishedReconciliation,
    isReconciliationInFlight: () => false,
    reconciliationGeneration: () => 0,
    requiredIdleChecks,
    onIdleExit: () => {
      exits += 1;
    },
    onCheckFailure: () => {
      failures += 1;
    },
  });
  return { tick, exits: () => exits, failures: () => failures };
};

const sequence = (values: (number | Error)[]) => {
  let index = 0;
  return async () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    if (value instanceof Error) {
      throw value;
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
      reconciliationGeneration: () => 0,
      requiredIdleChecks: 2,
      onIdleExit: () => {
        exits += 1;
      },
      onCheckFailure: () => undefined,
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
      reconciliationGeneration: () => generation,
      requiredIdleChecks,
      onIdleExit: () => {
        exits += 1;
      },
      onCheckFailure: () => undefined,
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
    expect(h.exits()).toBe(1);
  });
});
