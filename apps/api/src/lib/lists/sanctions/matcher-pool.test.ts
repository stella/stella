import { expect, test } from "bun:test";
import { MessageChannel, Worker } from "node:worker_threads";

import {
  buildScreeningIndex,
  DEFAULT_CUTOFF,
  SANCTIONS_SOURCES,
  screen,
} from "@stll/sanctions";
import type { ParsedList } from "@stll/sanctions";

import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  createSanctionsMatcherPool,
  SANCTIONS_MATCHER_CONFIG,
} from "./matcher-pool";
import type { SanctionsMatcherRequest } from "./matcher-protocol";
import { createMatcherTestClock } from "./test-fixtures/matcher-test-clock";
import { recordingMatcherWorker } from "./test-fixtures/recording-matcher-worker";

const MATCHER_WORK_BUDGET = 2_000_000;
const MAXIMUM_TRANSFER_ENTRIES = 1000;

const list = (name: string): ParsedList => ({
  version: { source: "eu", publishedAt: "2026-09-20", fileId: null },
  entries: [
    {
      source: "eu",
      issuer: SANCTIONS_SOURCES.eu.issuer,
      sourceId: "fixture",
      referenceNumber: null,
      entityType: "organisation",
      names: [{ name, quality: "strong" }],
      birthDates: [],
      nationalities: [],
      identifiers: [],
      addresses: [],
      programme: null,
      legalBasis: null,
      listedOn: null,
      sourceUrl: "https://example.com/list",
    },
  ],
});
const request = (
  name: string,
  editionId = "first",
): SanctionsMatcherRequest => ({
  source: "eu",
  editionId,
  list: list(name),
  query: { name, entityType: "organisation" },
  cutoff: DEFAULT_CUTOFF,
  limit: 10,
});
const actualWorker = () =>
  new Worker(new URL("sanctions-matcher-worker.ts", import.meta.url));

for (const fault of ["hang", "crash"] as const) {
  test(`${fault} returns unavailable, recycles the worker, and the next request answers`, async () => {
    let spawned = 0;
    const clock = createMatcherTestClock();
    const entered = Promise.withResolvers<undefined>();
    const { port1, port2 } = new MessageChannel();
    port1.once("message", () => entered.resolve(undefined));
    const crashed = Promise.withResolvers<undefined>();
    const pool = createSanctionsMatcherPool({
      deadlineMs: 150,
      clock,
      createWorker: () => {
        spawned += 1;
        const worker =
          spawned === 1
            ? new Worker(
                new URL(
                  "test-fixtures/matcher-fault-worker.ts",
                  import.meta.url,
                ),
                {
                  workerData: { fault, acknowledgement: port2 },
                  transferList: [port2],
                },
              )
            : actualWorker();
        if (spawned === 1) {
          worker.once("exit", () => crashed.resolve(undefined));
        }
        return worker;
      },
    });
    try {
      const failed = pool.run(
        async (session) => await session.match(request("Acme Trading")),
      );
      await entered.promise;
      // Reverting to wall-clock scheduling fails here before any worker timing matters.
      expect(clock.pending()).toEqual([150]);
      if (fault === "hang") {
        clock.advance(150);
      } else {
        await crashed.promise;
      }
      expect(await failed).toBeNull();
      expect(clock.pending()).toEqual([]);
      const next = await pool.run(
        async (session) => await session.match(request("Acme Trading")),
        // Recycling starts a cold worker; retain the short fault deadline above.
        { deadlineMs: SANCTIONS_MATCHER_CONFIG.warmupDeadlineMs },
      );
      expect(next?.status).toBe("screened");
      expect(spawned).toBe(2);
    } finally {
      await pool.close();
      port1.close();
      port2.close();
    }
  });
}

test("cached worker results match direct screening and replace changed editions", async () => {
  const pool = createSanctionsMatcherPool({ clock: createMatcherTestClock() });
  try {
    const first = request("Acme Trading");
    const expected = screen(
      buildScreeningIndex([list("Acme Trading")]),
      first.query,
      {
        cutoff: first.cutoff,
        limit: first.limit,
      },
    ).unwrap();
    expect(
      await pool.run(async (session) => await session.match(first)),
    ).toEqual({ status: "screened", result: expected });
    const changed = request("Different Enterprise", "second");
    changed.query = first.query;
    const newExpected = screen(
      buildScreeningIndex([list("Different Enterprise")]),
      changed.query,
      { cutoff: changed.cutoff, limit: changed.limit },
    ).unwrap();
    expect(
      await pool.run(async (session) => await session.match(changed)),
    ).toEqual({ status: "screened", result: newExpected });
    expect(newExpected.possibleMatches).toHaveLength(0);
    expect(
      await pool.run(async (session) => {
        expect(session.hasEdition("eu", "first")).toBe(false);
        expect(session.hasEdition("eu", "second")).toBe(true);
        return await session.match({ ...changed, list: null });
      }),
    ).toEqual({ status: "screened", result: newExpected });
  } finally {
    await pool.close();
  }
});

test("bundled runtime loads the deployed matcher worker", async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } =
    await import("node:fs");
  const { default: path } = await import("node:path");
  const directory = mkdtempSync(path.join(import.meta.dir, ".tmp-matcher-"));
  try {
    const workers = path.join(directory, "workers");
    const parent = path.join(directory, "parent");
    mkdirSync(workers);
    mkdirSync(parent);
    const entrypoint = path.join(directory, "entrypoint.ts");
    writeFileSync(
      entrypoint,
      `import { createSanctionsMatcherPool } from ${JSON.stringify(path.join(import.meta.dir, "matcher-pool.ts"))};
import { createMatcherTestClock } from ${JSON.stringify(path.join(import.meta.dir, "test-fixtures/matcher-test-clock.ts"))};
const pool = createSanctionsMatcherPool({ clock: createMatcherTestClock() });
const response = await pool.run(async (session) => await session.match(${JSON.stringify(request("Acme Trading"))}));
await pool.close();
if (response?.status !== "screened" || response.result.possibleMatches.length !== 1) { process.exit(1); }
`,
    );
    const workerBuild = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "sanctions-matcher-worker.ts")],
      naming: "sanctions-matcher-worker.js",
      outdir: workers,
      target: "bun",
    });
    expect(workerBuild.success).toBe(true);
    const parentBuild = await Bun.build({
      entrypoints: [entrypoint],
      outdir: parent,
      target: "bun",
    });
    expect(parentBuild.success).toBe(true);
    const child = Bun.spawn({
      cmd: ["bun", path.join(parent, "entrypoint.js")],
      env: { ...process.env, STELLA_WORKER_DIR: workers },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await child.exited).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cold construction and adversarial warm matching stay within work budgets", async () => {
  const template = list("Acme").entries.at(0);
  if (template === undefined) {
    throw new Error("Missing matcher fixture entry");
  }
  const corpus: ParsedList = {
    version: list("Acme").version,
    entries: Array.from({ length: 20_000 }, (_, index) => ({
      ...template,
      sourceId: `entry-${index}`,
      names: [
        {
          name: `Registered Entity${index} Holdings`,
          quality: "strong" as const,
        },
      ],
    })),
  };
  const recorded = recordingMatcherWorker();
  const pool = createSanctionsMatcherPool({
    clock: createMatcherTestClock(),
    createWorker: recorded.createWorker,
  });
  const index = buildScreeningIndex([corpus]);
  const timed = async (name: string, cold: boolean) => {
    // Bound vocabulary lookups, postings and scoring independently of elapsed time.
    const expected = screen(
      index,
      { name, entityType: "organisation" },
      { cutoff: DEFAULT_CUTOFF, limit: 10, maxWork: MATCHER_WORK_BUDGET },
    ).unwrap();
    const before = { ...recorded.work };
    let previous = performance.now();
    const start = previous;
    let maxGapMs = 0;
    let ticks = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGapMs = Math.max(maxGapMs, now - previous);
      previous = now;
      ticks += 1;
    }, 1);
    try {
      const response = await pool.run(
        async (session) =>
          await session.match({ ...request(name), list: cold ? corpus : null }),
      );
      const totalMs = performance.now() - start;
      maxGapMs = Math.max(maxGapMs, performance.now() - previous);
      expect(response).toEqual({ status: "screened", result: expected });
      // Each query screens once; only the cold query transfers the corpus,
      // in bounded chunks rather than one event-loop-blocking message.
      expect(recorded.work.screenings - before.screenings).toBe(1);
      expect(recorded.work.entries - before.entries).toBe(
        cold ? corpus.entries.length : 0,
      );
      expect(recorded.work.entryBatches - before.entryBatches).toBe(
        cold ? Math.ceil(corpus.entries.length / MAXIMUM_TRANSFER_ENTRIES) : 0,
      );
      expect(recorded.work.maximumBatchEntries).toBeLessThanOrEqual(
        MAXIMUM_TRANSFER_ENTRIES,
      );
      console.info(
        JSON.stringify({
          workerMatcher: name,
          cold,
          totalMs: Number(totalMs.toFixed(2)),
          maxGapMs: Number(maxGapMs.toFixed(2)),
          ticks,
        }),
      );
      return response;
    } finally {
      clearInterval(timer);
    }
  };
  try {
    expect((await timed("Registered Entity42 Holdings", true))?.status).toBe(
      "screened",
    );
    await timed("Registered Entity42 Holdings", false);
    await timed("Registered Entity Holdings", false);
    await timed(
      "Registered a b c d e f g h i j k l m n o p q r s t u v z",
      false,
    );
  } finally {
    await pool.close();
  }
}, 20_000);

test("deadline replies retain admission until unfinished operations settle", async () => {
  const clock = createMatcherTestClock();
  const pool = createSanctionsMatcherPool({ size: 2, deadlineMs: 20, clock });
  const held = Promise.withResolvers<undefined>();
  let started = 0;
  let unfinished = 0;
  let peak = 0;
  const operation = async () => {
    started += 1;
    unfinished += 1;
    peak = Math.max(peak, unfinished);
    await held.promise;
    unfinished -= 1;
    return "settled";
  };
  try {
    for (const _attempt of Array.from({ length: 8 })) {
      const pending = pool.run(operation);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(clock.pending()).toEqual([20]);
      clock.advance(20);
      expect(await pending).toBeNull();
    }
    expect(started).toBe(2);
    expect(unfinished).toBe(2);
    expect(peak).toBe(2);
    held.resolve(undefined);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(unfinished).toBe(0);
    expect(await pool.run(async () => "recovered", { deadlineMs: 1000 })).toBe(
      "recovered",
    );
  } finally {
    held.resolve(undefined);
    await pool.close();
  }
});

test("late retired-worker errors cannot release a held acquisition or a replacement worker", async () => {
  const clock = createMatcherTestClock();
  const termination = Promise.withResolvers<number>();
  const acquisition = Promise.withResolvers<undefined>();
  const workers: {
    events: {
      on: (name: string, listener: () => void) => void;
      emit: (name: string) => void;
    };
    terminations: number;
  }[] = [];
  const pool = createSanctionsMatcherPool({
    size: 1,
    deadlineMs: 20,
    clock,
    createWorker: () => {
      const listeners = new Map<string, () => void>();
      const state = {
        events: {
          on: (name: string, listener: () => void) => {
            listeners.set(name, listener);
          },
          emit: (name: string) => {
            listeners.get(name)?.();
          },
        },
        terminations: 0,
      };
      const ordinal = workers.length;
      workers.push(state);
      return asTestRaw<Worker>(
        Object.assign(state.events, {
          unref: () => state.events,
          terminate: async () => {
            state.terminations += 1;
            return await (ordinal === 0
              ? termination.promise
              : Promise.resolve(0));
          },
        }),
      );
    },
  });
  let unfinished = 0;
  let started = 0;
  const operation = async () => {
    started += 1;
    unfinished += 1;
    await acquisition.promise;
    unfinished -= 1;
    return "settled";
  };
  try {
    const first = pool.run(operation);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(clock.pending()).toEqual([20]);
    clock.advance(20);
    expect(await first).toBeNull();
    const retired = workers.at(0);
    expect(retired).toBeDefined();
    retired?.events.emit("error");
    termination.resolve(0);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const queued = pool.run(operation);
    expect(clock.pending()).toEqual([20]);
    clock.advance(20);
    expect(await queued).toBeNull();
    expect(started).toBe(1);
    expect(unfinished).toBe(1);
    expect(workers).toHaveLength(1);
    acquisition.resolve(undefined);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(await pool.run(async () => "recovered")).toBe("recovered");
    expect(workers).toHaveLength(2);
    const replacement = workers.at(1);
    retired?.events.emit("error");
    retired?.events.emit("exit");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(replacement?.terminations).toBe(0);
    expect(await pool.run(async () => "still recovered")).toBe(
      "still recovered",
    );
    expect(workers).toHaveLength(2);
    expect(unfinished).toBe(0);
  } finally {
    acquisition.resolve(undefined);
    termination.resolve(0);
    await pool.close();
  }
});

const inertWorker = () =>
  asTestRaw<Worker>({
    on: () => undefined,
    unref: () => undefined,
    terminate: async () => 0,
  });

const deadlineCases = [20, 150, 1000].flatMap((deadlineMs) =>
  [-1, 0, 1].map((offset) => ({ deadlineMs, elapsedMs: deadlineMs + offset })),
);

test.each(deadlineCases)(
  "a reply after $elapsedMs ms observes the $deadlineMs ms deadline even before the timer runs",
  async ({ deadlineMs, elapsedMs }) => {
    const clock = createMatcherTestClock();
    const entered = Promise.withResolvers<undefined>();
    const response = Promise.withResolvers<string>();
    const pool = createSanctionsMatcherPool({
      deadlineMs,
      clock,
      createWorker: inertWorker,
    });
    try {
      const pending = pool.run(async () => {
        entered.resolve(undefined);
        return await response.promise;
      });
      await entered.promise;
      expect(clock.pending()).toEqual([deadlineMs]);
      clock.elapse(elapsedMs);
      response.resolve("reply");
      expect(await pending).toBe(elapsedMs < deadlineMs ? "reply" : null);
      expect(clock.pending()).toEqual([]);
    } finally {
      response.resolve("reply");
      await pool.close();
    }
  },
);

test("the deadline harness rejects the wall-clock mutation before worker timing matters", async () => {
  const clock = createMatcherTestClock();
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  // Omitting the injected clock restores the original scheduling behavior.
  const pool = createSanctionsMatcherPool({
    deadlineMs: 150,
    createWorker: inertWorker,
  });
  try {
    const pending = pool.run(async () => {
      entered.resolve(undefined);
      await release.promise;
      return "reply";
    });
    await entered.promise;
    expect(clock.pending()).not.toEqual([150]);
    release.resolve(undefined);
    await pending;
  } finally {
    release.resolve(undefined);
    await pool.close();
  }
});
