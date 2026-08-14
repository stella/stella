import { describe, expect, test } from "bun:test";

import { createIdleExitCheck } from "@/api/lib/document-processing-idle-exit";

/**
 * The class these pin: an idle-exit decision driven by asynchronous
 * samples must be a function of completed, non-overlapping, consecutive
 * observations — never of timer cadence, in-flight reordering, or failed
 * counts. Each rule is exercised deterministically by driving the tick
 * directly.
 */

const harness = (requiredIdleChecks: number, counts: () => Promise<number>) => {
  let exits = 0;
  let failures = 0;
  const tick = createIdleExitCheck({
    countPending: counts,
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

  test("exit fires exactly once; later ticks are inert", async () => {
    const h = harness(1, sequence([0, 0, 0]));
    expect(await h.tick()).toBe("exit");
    expect(await h.tick()).toBe("skipped");
    expect(await h.tick()).toBe("skipped");
    expect(h.exits()).toBe(1);
  });
});
