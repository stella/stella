import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SchedulerTaskFailure } from "@/api/lib/scheduler/types";

import type { OnlineMigrationOutcome } from "../../../db/online-migration-connection";
import {
  ONLINE_WORK_NAMES,
  type OnlineWorkName,
  type OnlineWorkUnitClaim,
} from "../../../db/online-migrations";
import { PENDING } from "../../../db/online-work-lifecycle";
import { allFinalizedOnlineWork } from "../../../tests/helpers/online-work-lifecycle";
import {
  createOnlineWorkRunner,
  type OnlineWorkStateSnapshot,
  type OnlineWorkStateStore,
} from "./online-work-runner";

const nameAt = (offset: number): OnlineWorkName =>
  ONLINE_WORK_NAMES.at(offset) ??
  (() => {
    throw new TypeError(`Expected online work at ${String(offset)}`);
  })();

const FIRST = nameAt(0);
const SECOND = nameAt(1);
const START = new Date("2026-10-23T10:00:00.000Z");

const lifecycleWithPending = (pending: readonly OnlineWorkName[]) => ({
  ...allFinalizedOnlineWork(),
  ...Object.fromEntries(pending.map((name) => [name, PENDING])),
});

type StoredRow = {
  state: OnlineWorkStateSnapshot["state"];
  attempts: number;
  lastError: string | null;
  finishedAt: Date | null;
  pausedUntil: Date | null;
};

const createMemoryStore = () => {
  const rows = new Map<string, StoredRow>();
  const update = (name: string, change: Partial<StoredRow>) => {
    const row = rows.get(name);
    if (row === undefined) {
      throw new TypeError(`No state row for ${name}`);
    }
    rows.set(name, { ...row, ...change });
  };
  const store: OnlineWorkStateStore = {
    initialize: async (units) => {
      for (const { name, state } of units) {
        if (!rows.has(name)) {
          rows.set(name, {
            state,
            attempts: 0,
            lastError: null,
            finishedAt: null,
            pausedUntil: null,
          });
        }
      }
    },
    readStates: async () =>
      [...rows].map(([name, { state, attempts, finishedAt, pausedUntil }]) => ({
        name,
        state,
        attempts,
        finishedAt,
        pausedUntil,
      })),
    markRunning: async ({ name, attempts, at }) => {
      const current = rows.get(name);
      if (
        current?.pausedUntil !== null &&
        current?.pausedUntil !== undefined &&
        current.pausedUntil > at
      ) {
        return false;
      }
      rows.set(name, {
        state: "running",
        attempts,
        lastError: null,
        finishedAt: null,
        pausedUntil: null,
      });
      return true;
    },
    markDone: async (name) => {
      update(name, { state: "done", lastError: null, finishedAt: START });
    },
    markPending: async (name) => {
      const row = rows.get(name);
      if (row?.state === "running") {
        update(name, { state: "pending" });
      }
    },
    markFailed: async ({ name, error }) => {
      update(name, { state: "failed", lastError: error, finishedAt: START });
    },
  };
  return { rows, store };
};

type HarnessOptions = {
  pending?: readonly OnlineWorkName[];
  lockHeld?: boolean;
};

const createHarness = ({
  pending = [FIRST, SECOND],
  lockHeld = false,
}: HarnessOptions = {}) => {
  const { rows, store } = createMemoryStore();
  const claims: OnlineWorkName[] = [];
  const releases: OnlineWorkName[] = [];
  /** The unit's checkpoint at each release: a finished walk records first. */
  const statesAtRelease: (StoredRow["state"] | undefined)[] = [];
  const walks = new Map<
    OnlineWorkName,
    PromiseWithResolvers<OnlineMigrationOutcome>
  >();
  const detachedWork: Promise<Result<void, SchedulerTaskFailure>>[] = [];
  const runner = createOnlineWorkRunner({
    names: ONLINE_WORK_NAMES,
    lifecycle: lifecycleWithPending(pending),
    store,
    claim: async ({ name }): Promise<OnlineWorkUnitClaim> => {
      if (lockHeld) {
        return { type: "lock_held" };
      }
      claims.push(name);
      const walk = Promise.withResolvers<OnlineMigrationOutcome>();
      walks.set(name, walk);
      let released = false;
      const release = async () => {
        if (!released) {
          released = true;
          releases.push(name);
          statesAtRelease.push(rows.get(name)?.state);
        }
      };
      return {
        type: "claimed",
        release,
        run: async (record) => {
          try {
            return await record(
              await Result.tryPromise({
                try: async () => await walk.promise,
                catch: (cause: unknown) => cause,
              }),
            );
          } finally {
            await release();
          }
        },
      };
    },
    detach: (work) => {
      detachedWork.push(work);
    },
  });
  const walkOf = (name: OnlineWorkName) =>
    walks.get(name) ??
    (() => {
      throw new TypeError(`No walk for ${name}`);
    })();
  const settle = async () => {
    const work = detachedWork.splice(0);
    return await Promise.allSettled(work);
  };
  return {
    rows,
    claims,
    releases,
    statesAtRelease,
    tick: async (now = START) => (await runner(now)).unwrap(),
    walkOf,
    settle,
  };
};

describe("online work runner", () => {
  test("an active operator pause skips admission and expiry resumes automatically", async () => {
    const harness = createHarness({ pending: [FIRST] });
    harness.rows.set(FIRST, {
      state: "paused",
      attempts: 0,
      lastError: null,
      finishedAt: null,
      pausedUntil: new Date(START.getTime() + 60_000),
    });
    expect(await harness.tick()).toEqual({ type: "idle" });
    expect(harness.claims).toEqual([]);
    expect(await harness.tick(new Date(START.getTime() + 60_000))).toEqual({
      type: "started",
      name: FIRST,
    });
  });

  test("a pause committed during claim prevents detached work from starting", async () => {
    const { rows, store } = createMemoryStore();
    const releases: string[] = [];
    const runner = createOnlineWorkRunner({
      names: [FIRST],
      lifecycle: lifecycleWithPending([FIRST]),
      store,
      claim: async () => {
        rows.set(FIRST, {
          state: "paused",
          attempts: 0,
          lastError: null,
          finishedAt: null,
          pausedUntil: new Date(START.getTime() + 60_000),
        });
        return {
          type: "claimed",
          release: async () => {
            releases.push(FIRST);
          },
          run: async () => panic("Paused work must not start"),
        };
      },
      detach: () => panic("Paused work must not detach"),
    });
    expect((await runner(START)).unwrap()).toEqual({ type: "idle" });
    expect(releases).toEqual([FIRST]);
    expect(rows.get(FIRST)?.state).toBe("paused");
  });

  test("a tick claims the first pending unit in registry order and records it building", async () => {
    const harness = createHarness();

    expect(await harness.tick()).toEqual({ type: "started", name: FIRST });
    expect(harness.claims).toEqual([FIRST]);
    expect(harness.rows.get(FIRST)).toMatchObject({
      state: "running",
      attempts: 1,
    });
    expect(harness.rows.get(SECOND)?.state).toBe("pending");
  });

  test("a tick while this process builds claims nothing more", async () => {
    const harness = createHarness();
    await harness.tick();

    expect(await harness.tick()).toEqual({ type: "building", name: FIRST });
    expect(harness.claims).toEqual([FIRST]);
  });

  test("a lock held elsewhere skips the tick and records no attempt", async () => {
    const harness = createHarness({ lockHeld: true });

    expect(await harness.tick()).toEqual({ type: "skipped" });
    expect(harness.rows.get(FIRST)?.state).toBe("pending");
  });

  test("a finished unit is finalized, released, and the next tick takes the next unit", async () => {
    const harness = createHarness();
    await harness.tick();

    harness.walkOf(FIRST).resolve({ type: "complete" });
    await harness.settle();

    expect(harness.rows.get(FIRST)).toMatchObject({ state: "done" });
    expect(harness.releases).toEqual([FIRST]);
    // The checkpoint is written while the claim still holds the lock.
    expect(harness.statesAtRelease).toEqual(["done"]);
    expect(await harness.tick()).toEqual({ type: "started", name: SECOND });
  });

  test("a runner whose snapshot went stale while another finished the unit leaves it finished", async () => {
    const { rows, store } = createMemoryStore();
    const lifecycle = lifecycleWithPending([FIRST]);
    let holder: "a" | "b" | null = null;
    const walked: string[] = [];
    const gaveUp: string[] = [];
    const claimAs =
      (runnerId: "a" | "b") => async (): Promise<OnlineWorkUnitClaim> => {
        if (holder !== null) {
          return { type: "lock_held" };
        }
        holder = runnerId;
        const release = async () => {
          holder = null;
        };
        return {
          type: "claimed",
          release: async () => {
            gaveUp.push(runnerId);
            await release();
          },
          run: async (record) => {
            walked.push(runnerId);
            try {
              return await record(Result.ok({ type: "complete" }));
            } finally {
              await release();
            }
          },
        };
      };
    // Runner b chose its unit from this snapshot, taken before a finished it.
    const stale = await store.readStates();
    let staleReads = 1;
    const work: Promise<unknown>[] = [];
    const a = createOnlineWorkRunner({
      names: ONLINE_WORK_NAMES,
      lifecycle,
      store,
      claim: claimAs("a"),
      detach: (finished) => {
        work.push(finished);
      },
    });
    const b = createOnlineWorkRunner({
      names: ONLINE_WORK_NAMES,
      lifecycle,
      store: {
        ...store,
        readStates: async () => {
          if (staleReads > 0) {
            staleReads -= 1;
            return stale;
          }
          return await store.readStates();
        },
      },
      claim: claimAs("b"),
      detach: () => panic("Runner b must not walk a finished unit"),
    });

    expect((await a(START)).unwrap()).toEqual({ type: "started", name: FIRST });
    await Promise.all(work);

    expect((await b(START)).unwrap()).toEqual({ type: "idle" });
    expect(walked).toEqual(["a"]);
    expect(gaveUp).toEqual(["b"]);
    expect(holder).toBeNull();
    expect(rows.get(FIRST)).toMatchObject({ state: "done", attempts: 1 });
  });

  test("a failed unit waits for its retry delay, then is claimed again", async () => {
    const harness = createHarness({ pending: [FIRST] });
    await harness.tick();

    harness
      .walkOf(FIRST)
      .reject(
        new Error(
          `connect postgres://owner:secret@db.internal:5432/stella failed ${"x".repeat(5000)}`,
        ),
      );
    const [settled] = await harness.settle();

    // Reported as a failure of the detached unit, after its checkpoint.
    expect(
      settled?.status === "fulfilled" && Result.isError(settled.value),
    ).toBe(true);
    const failed = harness.rows.get(FIRST);
    expect(failed?.state).toBe("failed");
    expect(failed?.lastError).not.toContain("secret");
    expect(failed?.lastError).toContain("[database-url]");
    expect(failed?.lastError?.length).toBe(2000);
    expect(harness.releases).toEqual([FIRST]);

    expect(await harness.tick(new Date(START.getTime() + 59_999))).toEqual({
      type: "idle",
    });
    expect(harness.claims).toEqual([FIRST]);

    expect(await harness.tick(new Date(START.getTime() + 60_000))).toEqual({
      type: "started",
      name: FIRST,
    });
    expect(harness.rows.get(FIRST)).toMatchObject({
      state: "running",
      attempts: 2,
      lastError: null,
    });
  });

  test("a later pending unit runs while an earlier failed unit waits", async () => {
    const harness = createHarness();
    await harness.tick();
    harness.walkOf(FIRST).reject(new Error("deterministic failure"));
    await harness.settle();

    expect(await harness.tick(new Date(START.getTime() + 30_000))).toEqual({
      type: "started",
      name: SECOND,
    });
    expect(harness.claims).toEqual([FIRST, SECOND]);
  });

  test("a deferred unit stays building and the next tick claims it again", async () => {
    const harness = createHarness({ pending: [FIRST] });
    await harness.tick();

    harness
      .walkOf(FIRST)
      .resolve({ type: "deferred", step: FIRST, retryAfterMs: 60_000 });
    await harness.settle();

    expect(harness.rows.get(FIRST)).toMatchObject({ state: "pending" });
    expect(await harness.tick()).toEqual({ type: "started", name: FIRST });
    expect(harness.claims).toEqual([FIRST, FIRST]);
  });

  test("a failure to record the claim gives the claim up", async () => {
    const { store } = createMemoryStore();
    const releases: string[] = [];
    const runner = createOnlineWorkRunner({
      names: ONLINE_WORK_NAMES,
      lifecycle: lifecycleWithPending([FIRST]),
      store: {
        ...store,
        markRunning: async () => {
          throw new Error("write refused");
        },
      },
      claim: async ({ name }) => ({
        type: "claimed",
        run: async () =>
          panic("A claim that was never recorded is never walked"),
        release: async () => {
          releases.push(name);
        },
      }),
      detach: () => undefined,
    });

    const outcome = await runner(START);

    expect(Result.isError(outcome) && outcome.error.cause).toHaveProperty(
      "message",
      "write refused",
    );
    expect(releases).toEqual([FIRST]);
  });

  test("no pending work leaves the runner idle without a claim", async () => {
    const harness = createHarness({ pending: [] });

    expect(await harness.tick()).toEqual({ type: "idle" });
    expect(harness.claims).toEqual([]);
  });

  test("finalized work is never claimed", async () => {
    const harness = createHarness({ pending: [SECOND] });

    expect(await harness.tick()).toEqual({ type: "started", name: SECOND });
    expect(harness.claims).toEqual([SECOND]);
  });
});
