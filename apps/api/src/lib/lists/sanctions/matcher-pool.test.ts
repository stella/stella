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
import type { MatcherWorkOutcome } from "./matcher-pool";
import type { SanctionsMatcherRequest } from "./matcher-protocol";
import type {
  SanctionsMatcherFailureCause,
  reportSanctionsScreeningFailure,
} from "./screening-failure";
import { createMatcherTestClock } from "./test-fixtures/matcher-test-clock";
import { recordingMatcherWorker } from "./test-fixtures/recording-matcher-worker";

const outcomeValue = <T>(outcome: MatcherWorkOutcome<T>): T | null =>
  outcome.status === "completed" ? outcome.value : null;

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
      const failed = pool
        .run(async (session) => await session.match(request("Acme Trading")))
        .then(outcomeValue);
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
      const next = await pool
        .run(
          async (session) => await session.match(request("Acme Trading")),
          // Recycling starts a cold worker; retain the short fault deadline above.
          { deadlineMs: SANCTIONS_MATCHER_CONFIG.warmupDeadlineMs },
        )
        .then(outcomeValue);
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
      await pool
        .run(async (session) => await session.match(first))
        .then(outcomeValue),
    ).toEqual({ status: "screened", result: expected });
    const changed = request("Different Enterprise", "second");
    changed.query = first.query;
    const newExpected = screen(
      buildScreeningIndex([list("Different Enterprise")]),
      changed.query,
      { cutoff: changed.cutoff, limit: changed.limit },
    ).unwrap();
    expect(
      await pool
        .run(async (session) => await session.match(changed))
        .then(outcomeValue),
    ).toEqual({ status: "screened", result: newExpected });
    expect(newExpected.possibleMatches).toHaveLength(0);
    expect(
      await pool
        .run(async (session) => {
          expect(session.hasEdition("eu", "first")).toBe(false);
          expect(session.hasEdition("eu", "second")).toBe(true);
          return await session.match({ ...changed, list: null });
        })
        .then(outcomeValue),
    ).toEqual({ status: "screened", result: newExpected });
  } finally {
    await pool.close();
  }
});

test("compiled runtime loads the deployed matcher worker", async () => {
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
if (response.status !== "completed" || response.value.status !== "screened" || response.value.result.possibleMatches.length !== 1) { process.exit(1); }
`,
    );
    const workerBuild = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "sanctions-matcher-worker.ts")],
      naming: "sanctions-matcher-worker.js",
      outdir: workers,
      target: "bun",
    });
    expect(workerBuild.success).toBe(true);
    const binary = path.join(parent, "screening-probe");
    const parentBuild = Bun.spawn({
      cmd: [
        process.execPath,
        "build",
        "--compile",
        entrypoint,
        "--outfile",
        binary,
      ],
      cwd: directory,
      stderr: "pipe",
      stdout: "pipe",
    });
    const buildError = await new Response(parentBuild.stderr).text();
    expect(await parentBuild.exited, buildError).toBe(0);
    const child = Bun.spawn({
      cmd: [binary],
      env: { ...process.env, STELLA_WORKER_DIR: workers },
      stderr: "pipe",
      stdout: "pipe",
    });
    const childError = await new Response(child.stderr).text();
    expect(await child.exited, childError).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

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
      const response = await pool
        .run(
          async (session) =>
            await session.match({
              ...request(name),
              list: cold ? corpus : null,
            }),
        )
        .then(outcomeValue);
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
      const pending = pool.run(operation).then(outcomeValue);
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
    expect(
      await pool
        .run(async () => "recovered", { deadlineMs: 1000 })
        .then(outcomeValue),
    ).toBe("recovered");
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
    const first = pool.run(operation).then(outcomeValue);
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
    const queued = pool.run(operation).then(outcomeValue);
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
    expect(await pool.run(async () => "recovered").then(outcomeValue)).toBe(
      "recovered",
    );
    expect(workers).toHaveLength(2);
    const replacement = workers.at(1);
    retired?.events.emit("error");
    retired?.events.emit("exit");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(replacement?.terminations).toBe(0);
    expect(
      await pool.run(async () => "still recovered").then(outcomeValue),
    ).toBe("still recovered");
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
      const pending = pool
        .run(async () => {
          entered.resolve(undefined);
          return await response.promise;
        })
        .then(outcomeValue);
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
    const pending = pool
      .run(async () => {
        entered.resolve(undefined);
        await release.promise;
        return "reply";
      })
      .then(outcomeValue);
    await entered.promise;
    expect(clock.pending()).not.toEqual([150]);
    release.resolve(undefined);
    await pending;
  } finally {
    release.resolve(undefined);
    await pool.close();
  }
});

const observableFaults = {
  "worker-create": "worker-create",
  "worker-error": "worker-error",
  "worker-exit": "worker-exit",
  "worker-send": "worker-send",
  "worker-reply": "worker-reply",
  operation: "operation",
  deadline: "deadline",
} as const satisfies {
  [
    Cause in Exclude<
      SanctionsMatcherFailureCause,
      "closed" | "admission" | "worker-retire"
    >
  ]: Cause;
};

test.each(Object.values(observableFaults))(
  "reports %s once and releases its worker lease for recovery",
  async (fault) => {
    const { EventEmitter } = await import("node:events");
    const clock = createMatcherTestClock();
    const observations: Parameters<typeof reportSanctionsScreeningFailure>[] =
      [];
    let spawned = 0;
    let retired = 0;
    const pool = createSanctionsMatcherPool({
      clock,
      reportFailure: (...args) => observations.push(args),
      createWorker: () => {
        spawned += 1;
        if (spawned === 1 && fault === "worker-create") {
          throw new TypeError("Worker creation fault");
        }
        // oxlint-disable-next-line unicorn/prefer-event-target -- This fake implements node Worker on/once/off, whose contract requires EventEmitter.
        const worker = new EventEmitter();
        return asTestRaw<Worker>(
          Object.assign(worker, {
            unref: () => worker,
            terminate: async () => {
              retired += 1;
              return 0;
            },
            postMessage: () => {
              if (fault === "worker-send") {
                throw new TypeError("Worker sending fault");
              }
              if (fault === "worker-error") {
                worker.emit("error", new TypeError("Worker fault"));
                return;
              }
              if (fault === "worker-exit") {
                worker.emit("exit", 1);
                return;
              }
              if (fault === "deadline") {
                clock.advance(SANCTIONS_MATCHER_CONFIG.deadlineMs);
                return;
              }
              worker.emit("message", { status: "unavailable" });
            },
          }),
        );
      },
    });
    try {
      const failed = await pool.run(async (session) => {
        if (fault === "operation") {
          throw new TypeError("Operation fault");
        }
        return await session.match(request("Private Subject"));
      });
      expect(failed).toEqual({ status: "unavailable", cause: fault });
      expect(
        observations.map(([observation]) => ({
          stage: observation.stage,
          reason: observation.reason,
        })),
      ).toEqual([{ stage: "matcher-pool", reason: fault }]);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(await pool.run(async () => "recovered")).toEqual({
        status: "completed",
        value: "recovered",
      });
      expect(spawned).toBe(2);
      expect(retired).toBe(fault === "worker-create" ? 0 : 1);
    } finally {
      await pool.close();
    }
  },
);

test("failed worker retirement is observed and releases admission for another request", async () => {
  const reports: Parameters<typeof reportSanctionsScreeningFailure>[0][] = [];
  const pool = createSanctionsMatcherPool({
    clock: createMatcherTestClock(),
    reportFailure: (report) => reports.push(report),
    createWorker: () =>
      asTestRaw<Worker>({
        on: () => undefined,
        unref: () => undefined,
        terminate: async () => {
          throw new TypeError("Retirement failure");
        },
      }),
  });
  try {
    expect(
      await pool.run(async () => {
        throw new TypeError("Operation failure");
      }),
    ).toEqual({ status: "unavailable", cause: "operation" });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(reports.map(({ reason }) => reason)).toEqual([
      "operation",
      "worker-retire",
    ]);
    expect(await pool.run(async () => "recovered")).toEqual({
      status: "completed",
      value: "recovered",
    });
  } finally {
    await pool.close();
  }
});

test("lease settlement callbacks fire exactly once after work, including acquisitions without a lease", async () => {
  const clock = createMatcherTestClock();
  const entered = Promise.withResolvers<undefined>();
  const held = Promise.withResolvers<undefined>();
  const counts = { active: 0, queued: 0, closed: 0 };
  const pool = createSanctionsMatcherPool({
    clock,
    deadlineMs: 10,
    createWorker: inertWorker,
    reportFailure: () => undefined,
  });
  const active = pool.run(
    async () => {
      entered.resolve(undefined);
      await held.promise;
      return "finished";
    },
    {
      onSettled: () => {
        counts.active += 1;
      },
    },
  );
  try {
    await entered.promise;
    clock.advance(10);
    expect(await active).toEqual({ status: "unavailable", cause: "deadline" });
    expect(counts.active).toBe(0);
    const queued = pool.run(async () => "never entered", {
      onSettled: () => {
        counts.queued += 1;
      },
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(counts.queued).toBe(0);
    clock.advance(10);
    expect(await queued).toEqual({ status: "unavailable", cause: "deadline" });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(counts.queued).toBe(1);
    expect(counts.active).toBe(0);
    held.resolve(undefined);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(counts.active).toBe(1);
    await pool.close();
    expect(
      await pool.run(async () => "closed", {
        onSettled: () => {
          counts.closed += 1;
        },
      }),
    ).toEqual({ status: "unavailable", cause: "closed" });
    expect(counts).toEqual({ active: 1, queued: 1, closed: 1 });
    await pool.close();
    expect(counts).toEqual({ active: 1, queued: 1, closed: 1 });
  } finally {
    held.resolve(undefined);
    await pool.close();
    await active;
  }
});

test("real worker work exhaustion retains its edition and screens the next cached query without reload", async () => {
  const template = list("Acme").entries.at(0);
  if (template === undefined) {
    throw new TypeError("Missing work-limit fixture entry");
  }
  const corpus = {
    version: list("Acme").version,
    entries: Array.from({ length: 20_000 }, (_, index) => ({
      ...template,
      sourceId: `work-limit-${index}`,
      names: [
        {
          name: `Registered Entity ${index} Holdings`,
          quality: "strong" as const,
        },
      ],
    })),
  } satisfies ParsedList;
  const query = {
    name: "Registered a b c d e f g h i j k l m n o p q r s t u v z",
    entityType: "organisation" as const,
  };
  const direct = screen(buildScreeningIndex([corpus]), query, {
    cutoff: DEFAULT_CUTOFF,
    limit: 10,
  });
  expect(direct.isErr() && direct.error.code).toBe("work-limit");
  const recorded = recordingMatcherWorker();
  const reports: Parameters<typeof reportSanctionsScreeningFailure>[0][] = [];
  let spawned = 0;
  const pool = createSanctionsMatcherPool({
    clock: createMatcherTestClock(),
    reportFailure: (report) => reports.push(report),
    createWorker: () => {
      spawned += 1;
      return recorded.createWorker();
    },
  });
  try {
    const requestBase = {
      source: "eu",
      editionId: "work-limit",
      cutoff: DEFAULT_CUTOFF,
      limit: 10,
    } as const;
    expect(
      await pool.run(
        async (session) =>
          await session.match({ ...requestBase, list: corpus, query }),
      ),
    ).toEqual({ status: "completed", value: { status: "work-limit" } });
    const transferred = { ...recorded.work };
    const safeQuery = {
      name: "Registered Entity 42 Holdings",
      entityType: "organisation" as const,
    };
    const expected = screen(buildScreeningIndex([corpus]), safeQuery, {
      cutoff: DEFAULT_CUTOFF,
      limit: 10,
    }).unwrap();
    expect(
      await pool.run(async (session) => {
        expect(session.hasEdition("eu", "work-limit")).toBe(true);
        return await session.match({
          ...requestBase,
          list: null,
          query: safeQuery,
        });
      }),
    ).toEqual({
      status: "completed",
      value: { status: "screened", result: expected },
    });
    expect(recorded.work.entries).toBe(transferred.entries);
    expect(recorded.work.entryBatches).toBe(transferred.entryBatches);
    expect(recorded.work.screenings).toBe(transferred.screenings + 1);
    expect(spawned).toBe(1);
    expect(reports).toEqual([]);
  } finally {
    await pool.close();
  }
});
