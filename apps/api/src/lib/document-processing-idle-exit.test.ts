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
  hasUnfinishedReconciliation: () => boolean = () => false,
) => {
  let exits = 0;
  let failures = 0;
  const tick = createIdleExitCheck({
    countPending: counts,
    hasUnfinishedReconciliation,
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

    const first = h.tick();
    // The first sample is still in flight: further ticks must not start
    // a second count or advance the streak.
    expect(await h.tick()).toBe("skipped");
    expect(await h.tick()).toBe("skipped");
    expect(resolvers).toHaveLength(1);

    resolvers.shift()?.(0);
    expect(await first).toBe("checked");

    const second = h.tick();
    resolvers.shift()?.(0);
    expect(await second).toBe("exit");
  });

  test("an empty queue is not idle while reconciliation has work behind it", async () => {
    const h = harness(2, sequence([0, 0, 0, 0]), () => true);
    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("checked");
    expect(h.exits()).toBe(0);
  });

  test("reconciliation draining mid-streak resets it", async () => {
    let unfinished = false;
    const h = harness(2, sequence([0, 0, 0, 0]), () => unfinished);
    await h.tick();
    unfinished = true;
    // The streak must restart from this sample, not resume where it left off.
    expect(await h.tick()).toBe("checked");
    unfinished = false;
    expect(await h.tick()).toBe("checked");
    expect(await h.tick()).toBe("exit");
  });

  test("a reconciliation that starts during the count is caught by that sample", async () => {
    let unfinished = false;
    let exits = 0;
    const tick = createIdleExitCheck({
      countPending: async () => {
        // Reconciliation ticks are timer-driven, so one can begin while a
        // sample's count is in flight; the sample must not certify the
        // moment before it.
        unfinished = true;
        return 0;
      },
      hasUnfinishedReconciliation: () => unfinished,
      requiredIdleChecks: 1,
      onIdleExit: () => {
        exits += 1;
      },
      onCheckFailure: () => undefined,
    });

    expect(await tick()).toBe("checked");
    expect(exits).toBe(0);
  });

  test("exit fires exactly once; later ticks are inert", async () => {
    const h = harness(1, sequence([0, 0, 0]));
    expect(await h.tick()).toBe("exit");
    expect(await h.tick()).toBe("skipped");
    expect(await h.tick()).toBe("skipped");
    expect(h.exits()).toBe(1);
  });
});
