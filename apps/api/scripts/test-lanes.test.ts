import { panic } from "better-result";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { TEST_BATCH_KIND, type TestBatchKind } from "./test-batch-plan";
import { runInLanes } from "./test-lanes";

afterEach(() => {
  mock.restore();
});

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
      (runningKind) =>
        runningKind === TEST_BATCH_KIND.heavyLogic ||
        runningKind === TEST_BATCH_KIND.heavyDb,
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
      batch(TEST_BATCH_KIND.heavyDb, "heavy-2"),
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
  });

  test("an aborted run starts nothing new and lets running batches finish", async () => {
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
  });
});
