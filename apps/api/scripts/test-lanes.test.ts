import { panic } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { listApiTestPaths, planApiTestBatches } from "./api-test-plan";
import { TEST_BATCH_KIND, type TestBatchKind } from "./test-batch-plan";
import durationTable from "./test-durations.json";
import {
  API_TEST_LANES_ENV,
  deriveTestLaneCount,
  laneRunExitCode,
  orderBatchesForLanes,
  runInLanes,
} from "./test-lanes";
import { durationSeconds } from "./test-timings";

const GIB = 1024 * 1024 * 1024;

const HEAVY_BUDGET_MB = 3072;

type FakeBatch = { kind: TestBatchKind; name: string };

const batch = (kind: TestBatchKind, name: string): FakeBatch => ({
  kind,
  name,
});

test("a serial measurement sweep reports every file even after a failure", async () => {
  const files = [
    batch(TEST_BATCH_KIND.regular, "first"),
    batch(TEST_BATCH_KIND.regular, "second"),
  ];
  const started: string[] = [];
  const outcomes = await runInLanes({
    batches: files,
    lanes: 1,
    failurePolicy: "complete",
    runBatch: async ({ name }) => {
      started.push(name);
      return name === "first" ? 1 : 0;
    },
  });
  expect(started).toEqual(["first", "second"]);
  expect(outcomes.map(({ exitCode }) => exitCode)).toEqual([1, 0]);
  expect(laneRunExitCode(outcomes)).toBe(1);
});

/** A batch body the test settles by hand, so overlap is observable. */
const controlledRun = () => {
  const started: string[] = [];
  const running = new Map<string, TestBatchKind>();
  const laneByBatch = new Map<string, number>();
  const runningLanes = new Set<number>();
  const settlers = new Map<string, (exitCode: number) => void>();
  let maxConcurrent = 0;
  let maxConcurrentHeavy = 0;
  const runBatch = async (
    { kind, name }: FakeBatch,
    lane: number,
  ): Promise<number> => {
    expect(Number.isSafeInteger(lane)).toBe(true);
    expect(lane).toBeGreaterThan(0);
    expect(runningLanes.has(lane)).toBe(false);
    runningLanes.add(lane);
    laneByBatch.set(name, lane);
    started.push(name);
    running.set(name, kind);
    maxConcurrent = Math.max(maxConcurrent, running.size);
    const heavyRunning = [...running.values()].filter(
      (runningKind) => runningKind === TEST_BATCH_KIND.heavyLogic,
    ).length;
    maxConcurrentHeavy = Math.max(maxConcurrentHeavy, heavyRunning);
    const exitCode = await new Promise<number>((resolve) => {
      settlers.set(name, resolve);
    });
    running.delete(name);
    runningLanes.delete(lane);
    return exitCode;
  };
  const settle = async (name: string, exitCode = 0) => {
    const resolve = settlers.get(name);
    if (resolve === undefined) {
      panic(`${name} is not running`);
    }
    settlers.delete(name);
    resolve(exitCode);
    // Let the lane observe the settlement and start its next batch.
    await Bun.sleep(0);
  };
  return {
    get maxConcurrent() {
      return maxConcurrent;
    },
    get maxConcurrentHeavy() {
      return maxConcurrentHeavy;
    },
    runBatch,
    laneByBatch,
    settle,
    started,
  };
};

describe("deriveTestLaneCount", () => {
  const runner = {
    availableParallelism: 4,
    laneMemoryBudgetMb: HEAVY_BUDGET_MB,
    totalMemoryBytes: 16 * GIB,
  };

  test("stays serial outside CI unless lanes are requested", () => {
    expect(deriveTestLaneCount({ ...runner, env: {} })).toBe(1);
    expect(deriveTestLaneCount({ ...runner, env: { CI: "false" } })).toBe(1);
    expect(
      deriveTestLaneCount({ ...runner, env: { [API_TEST_LANES_ENV]: "2" } }),
    ).toBe(2);
  });

  test("uses three lanes on a four-core, 16 GB CI runner", () => {
    expect(deriveTestLaneCount({ ...runner, env: { CI: "true" } })).toBe(3);
  });

  test("falls back to one lane on a two-core, 7 GB CI runner", () => {
    expect(
      deriveTestLaneCount({
        availableParallelism: 2,
        env: { CI: "true" },
        laneMemoryBudgetMb: HEAVY_BUDGET_MB,
        totalMemoryBytes: 7 * GIB,
      }),
    ).toBe(1);
  });

  test("lets memory, not cores, bound a many-core runner with little memory", () => {
    expect(
      deriveTestLaneCount({
        availableParallelism: 16,
        env: { CI: "1" },
        laneMemoryBudgetMb: HEAVY_BUDGET_MB,
        totalMemoryBytes: 7 * GIB,
      }),
    ).toBe(2);
  });

  test("never derives zero lanes on a single-core runner", () => {
    expect(
      deriveTestLaneCount({
        ...runner,
        availableParallelism: 1,
        env: { CI: "true" },
      }),
    ).toBe(1);
  });

  test("an explicit lane count overrides the CI derivation", () => {
    expect(
      deriveTestLaneCount({
        ...runner,
        env: { CI: "true", [API_TEST_LANES_ENV]: "1" },
      }),
    ).toBe(1);
  });

  test("rejects a lane count that is not a positive integer", () => {
    for (const value of ["0", "-1", "2.5", "two"]) {
      expect(() =>
        deriveTestLaneCount({
          ...runner,
          env: { [API_TEST_LANES_ENV]: value },
        }),
      ).toThrow(API_TEST_LANES_ENV);
    }
  });
});

const laneWorkload = fc
  .array(
    fc.record({
      kind: fc.constantFrom(...Object.values(TEST_BATCH_KIND)),
      weights: fc.array(fc.nat({ max: 100 }), { minLength: 1, maxLength: 5 }),
    }),
    { maxLength: 20 },
  )
  .map((groups) => {
    const batches = groups.map(({ kind, weights }, index) => ({
      kind,
      name: `batch-${index}`,
      testFiles: weights.map((_, file) => `${index}-${file}.test.ts`),
      seconds: weights.reduce((sum, weight) => sum + weight, 0),
    }));
    const durations = Object.fromEntries(
      groups.flatMap(({ weights }, index) =>
        weights.map((weight, file) => [`${index}-${file}.test.ts`, weight]),
      ),
    );
    return { batches, durations };
  });

describe("orderBatchesForLanes", () => {
  test("the ordered live API plan includes every test file exactly once", async () => {
    const apiRoot = `${import.meta.dir}/..`;
    const files = listApiTestPaths(apiRoot);
    const composed = await planApiTestBatches({
      apiRoot,
      executionMode: "batched",
      propertyOnly: false,
      testPaths: files,
    });
    const batches = composed.flatMap(({ testBatches, ...group }) =>
      testBatches.map((testFiles) => ({ ...group, testFiles })),
    );
    const ordered = orderBatchesForLanes(
      batches,
      durationSeconds(durationTable),
    );
    const scheduledFiles = ordered.flatMap(({ testFiles }) => testFiles);
    expect(scheduledFiles.toSorted()).toEqual(files.toSorted());
    expect(new Set(scheduledFiles).size).toBe(files.length);
    expect(ordered.length).toBe(batches.length);
    for (const planned of batches) {
      expect(ordered.filter((candidate) => candidate === planned).length).toBe(
        1,
      );
    }
  });

  test("sums every file and starts the longest batch across kinds, keeping ties stable", () => {
    const batches = [
      { ...batch(TEST_BATCH_KIND.db, "db"), testFiles: ["db"] },
      { ...batch(TEST_BATCH_KIND.regular, "regular"), testFiles: ["a", "b"] },
      { ...batch(TEST_BATCH_KIND.heavyLogic, "heavy"), testFiles: ["heavy"] },
      { ...batch(TEST_BATCH_KIND.moduleMock, "mock"), testFiles: ["mock"] },
    ];
    const ordered = orderBatchesForLanes(batches, {
      db: 10,
      a: 20,
      b: 20,
      heavy: 40,
      mock: 50,
    });
    expect(ordered.map(({ name }) => name)).toEqual([
      "mock",
      "regular",
      "heavy",
      "db",
    ]);
    expect(ordered.flatMap(({ testFiles }) => testFiles).toSorted()).toEqual(
      batches.flatMap(({ testFiles }) => testFiles).toSorted(),
    );
  });

  test("missing live files use the median without stale weights changing the order", () => {
    const batches = [
      { ...batch(TEST_BATCH_KIND.db, "short"), testFiles: ["short"] },
      { ...batch(TEST_BATCH_KIND.regular, "new"), testFiles: ["new"] },
      { ...batch(TEST_BATCH_KIND.moduleMock, "long"), testFiles: ["long"] },
    ];
    expect(
      orderBatchesForLanes(batches, { short: 2, long: 8, deleted: 100 }).map(
        ({ name }) => name,
      ),
    ).toEqual(["new", "long", "short"]);
    expect(orderBatchesForLanes(batches, {})).toEqual(batches);
  });

  test("lane ordering preserves every batch and file, descending weights and stable ties", () => {
    assertProperty(
      "lane ordering preserves every batch and file, descending weights and stable ties",
      fc.property(laneWorkload, ({ batches, durations }) => {
        const original = [...batches];
        const ordered = orderBatchesForLanes(batches, durations);
        expect(batches).toEqual(original);
        expect(ordered.map(({ name }) => name).toSorted()).toEqual(
          batches.map(({ name }) => name).toSorted(),
        );
        expect(
          ordered.flatMap(({ testFiles }) => testFiles).toSorted(),
        ).toEqual(batches.flatMap(({ testFiles }) => testFiles).toSorted());
        expect(orderBatchesForLanes(batches, durations)).toEqual(ordered);
        for (const [index, current] of ordered.entries()) {
          for (const later of ordered.slice(index + 1)) {
            expect(current.seconds).toBeGreaterThanOrEqual(later.seconds);
            if (current.seconds === later.seconds) {
              expect(batches.indexOf(current)).toBeLessThan(
                batches.indexOf(later),
              );
            }
          }
        }
      }),
    );
  });

  test("lanes never start shorter work while longer startable work waits", async () => {
    await assertProperty(
      "lanes never start shorter work while longer startable work waits",
      fc.asyncProperty(
        laneWorkload,
        fc.integer({ min: 1, max: 4 }),
        async ({ batches, durations }, lanes) => {
          const waiting = new Set(batches);
          const active = new Set<FakeBatch>();
          const settlers = new Map<FakeBatch, () => void>();
          const started: string[] = [];
          const checks: (() => void)[] = [];
          const done = runInLanes({
            batches: orderBatchesForLanes(batches, durations),
            lanes,
            runBatch: async (current) => {
              const heavyRunning = [...active].some(
                ({ kind }) => kind === TEST_BATCH_KIND.heavyLogic,
              );
              const activeCount = active.size;
              const startedOnce = waiting.delete(current);
              const startable = [...waiting].filter(
                ({ kind }) =>
                  !(heavyRunning && kind === TEST_BATCH_KIND.heavyLogic),
              );
              // Assertions run outside runBatch, whose rejections are exit codes.
              checks.push(() => {
                expect(activeCount).toBeLessThan(lanes);
                expect(
                  heavyRunning && current.kind === TEST_BATCH_KIND.heavyLogic,
                ).toBe(false);
                expect(startedOnce).toBe(true);
                for (const candidate of startable) {
                  expect(current.seconds).toBeGreaterThanOrEqual(
                    candidate.seconds,
                  );
                  if (current.seconds === candidate.seconds) {
                    expect(batches.indexOf(current)).toBeLessThan(
                      batches.indexOf(candidate),
                    );
                  }
                }
              });
              active.add(current);
              started.push(current.name);
              await new Promise<void>((resolve) => {
                settlers.set(current, resolve);
              });
              return 0;
            },
          });
          while (settlers.size > 0) {
            // Finish the most recently started batch to vary completion order.
            const next = [...settlers.entries()].at(-1);
            if (next === undefined) {
              panic("An active batch must have a settler");
            }
            const [current, settle] = next;
            settlers.delete(current);
            active.delete(current);
            settle();
            await Bun.sleep(0);
          }
          const outcomes = await done;
          for (const check of checks) {
            check();
          }
          expect(waiting.size).toBe(0);
          expect(started.toSorted()).toEqual(
            batches.map(({ name }) => name).toSorted(),
          );
          expect(
            outcomes.map(({ batch: { name } }) => name).toSorted(),
          ).toEqual(batches.map(({ name }) => name).toSorted());
          expect(outcomes.every(({ exitCode }) => exitCode === 0)).toBe(true);
        },
      ),
    );
  });
});

describe("runInLanes", () => {
  test("keeps at most the lane count in flight and refills in start order", async () => {
    const run = controlledRun();
    const batches = ["a", "b", "c", "d"].map((name) =>
      batch(TEST_BATCH_KIND.db, name),
    );
    const done = runInLanes({ batches, lanes: 2, runBatch: run.runBatch });
    await Bun.sleep(0);

    expect(run.started).toEqual(["a", "b"]);
    await run.settle("b");
    expect(run.started).toEqual(["a", "b", "c"]);
    await run.settle("a");
    await run.settle("c");
    await run.settle("d");

    expect((await done).map(({ exitCode }) => exitCode)).toEqual([0, 0, 0, 0]);
    expect(run.maxConcurrent).toBe(2);
    expect(run.laneByBatch.get("a")).not.toBe(run.laneByBatch.get("b"));
    expect(run.laneByBatch.get("c")).toBe(run.laneByBatch.get("b"));
    expect(run.laneByBatch.get("d")).toBe(run.laneByBatch.get("a"));
  });

  test("runs one heavy batch at a time and lets other batches pass a waiting one", async () => {
    const run = controlledRun();
    const batches = [
      batch(TEST_BATCH_KIND.heavyLogic, "heavy-1"),
      batch(TEST_BATCH_KIND.heavyLogic, "heavy-2"),
      batch(TEST_BATCH_KIND.regular, "regular-1"),
    ];
    const done = runInLanes({ batches, lanes: 3, runBatch: run.runBatch });
    await Bun.sleep(0);

    // heavy-2 must wait for heavy-1; the regular batch takes the free lane.
    expect(run.started).toEqual(["heavy-1", "regular-1"]);
    await run.settle("regular-1");
    expect(run.started).toEqual(["heavy-1", "regular-1"]);
    await run.settle("heavy-1");
    expect(run.started).toEqual(["heavy-1", "regular-1", "heavy-2"]);
    await run.settle("heavy-2");

    await done;
    expect(run.maxConcurrentHeavy).toBe(1);
  });

  test("with several lanes, runs every batch after a failure and reports outcomes in start order", async () => {
    const exitCodes: Record<string, number> = { a: 0, b: 3, c: 0, d: 7 };
    const outcomes = await runInLanes({
      batches: ["a", "b", "c", "d"].map((name) =>
        batch(TEST_BATCH_KIND.regular, name),
      ),
      lanes: 2,
      runBatch: async ({ name }) => {
        // Later batches finish first, so completion order differs from start
        // order.
        await Bun.sleep(name === "a" || name === "b" ? 20 : 0);
        return exitCodes[name] ?? 0;
      },
    });

    expect(
      outcomes.map(({ batch: { name }, exitCode }) => [name, exitCode]),
    ).toEqual([
      ["a", 0],
      ["b", 3],
      ["c", 0],
      ["d", 7],
    ]);
    expect(laneRunExitCode(outcomes)).toBe(3);
  });

  test("counts a batch that throws as a failure without stopping the run", async () => {
    const ran: string[] = [];
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const outcomes = await runInLanes({
      batches: [
        batch(TEST_BATCH_KIND.db, "broken"),
        batch(TEST_BATCH_KIND.db, "fine"),
      ],
      lanes: 2,
      runBatch: async ({ name }) => {
        ran.push(name);
        if (name === "broken") {
          throw new Error("spawn failed");
        }
        return 0;
      },
    });

    // The cause is printed, not swallowed.
    const printedErrors = consoleError.mock.calls.length;
    consoleError.mockRestore();

    expect(printedErrors).toBe(1);
    expect(ran).toEqual(["broken", "fine"]);
    expect(outcomes.map(({ exitCode }) => exitCode)).toEqual([1, 0]);
    expect(laneRunExitCode(outcomes)).toBe(1);
  });

  test("a single lane stops at the first failure and leaves the rest unstarted", async () => {
    const ran: string[] = [];
    const outcomes = await runInLanes({
      batches: ["a", "b", "c"].map((name) =>
        batch(TEST_BATCH_KIND.regular, name),
      ),
      lanes: 1,
      runBatch: async ({ name }) => {
        ran.push(name);
        return name === "b" ? 4 : 0;
      },
    });

    expect(ran).toEqual(["a", "b"]);
    expect(outcomes.map(({ exitCode }) => exitCode)).toEqual([0, 4, null]);
    expect(laneRunExitCode(outcomes)).toBe(4);
  });

  test("an aborted run starts nothing new, lets running batches finish, and never passes", async () => {
    const run = controlledRun();
    const shutdown = new AbortController();
    const done = runInLanes({
      batches: ["a", "b", "c"].map((name) => batch(TEST_BATCH_KIND.db, name)),
      lanes: 2,
      runBatch: run.runBatch,
      signal: shutdown.signal,
    });
    await Bun.sleep(0);

    expect(run.started).toEqual(["a", "b"]);
    shutdown.abort();
    await run.settle("a");
    await run.settle("b");

    const outcomes = await done;
    expect(run.started).toEqual(["a", "b"]);
    expect(outcomes.map(({ exitCode }) => exitCode)).toEqual([0, 0, null]);
    expect(laneRunExitCode(outcomes)).toBe(1);
  });

  test("a clean run exits zero", async () => {
    const outcomes = await runInLanes({
      batches: [batch(TEST_BATCH_KIND.regular, "a")],
      lanes: 3,
      runBatch: async () => 0,
    });
    expect(laneRunExitCode(outcomes)).toBe(0);
  });
});
