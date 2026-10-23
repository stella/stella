import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { OnlineMigrationOutcome } from "../../../db/online-migration-connection";
import {
  ONLINE_WORK_NAMES,
  type OnlineWorkName,
  type OnlineWorkUnitClaim,
} from "../../../db/online-migrations";
import {
  FINALIZED,
  ONLINE_WORK_LIFECYCLE,
  PENDING,
} from "../../../db/online-work-lifecycle";
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
  ...ONLINE_WORK_LIFECYCLE,
  ...Object.fromEntries(pending.map((name) => [name, PENDING])),
});

type StoredRow = {
  state: OnlineWorkStateSnapshot["state"];
  attempts: number;
  lastError: string | null;
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
    readStates: async () =>
      [...rows].map(([name, { state, attempts }]) => ({
        name,
        state,
        attempts,
      })),
    markBuilding: async ({ name, attempts }) => {
      rows.set(name, { state: "building", attempts, lastError: null });
    },
    markFinalized: async (name) => {
      update(name, { state: "finalized", lastError: null });
    },
    markFailed: async ({ name, error }) => {
      update(name, { state: "failed", lastError: error });
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
  const walks = new Map<
    OnlineWorkName,
    PromiseWithResolvers<OnlineMigrationOutcome>
  >();
  const detachedWork: Promise<void>[] = [];
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
        }
      };
      return {
        type: "claimed",
        release,
        run: async () => {
          try {
            return await walk.promise;
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
    tick: async () => await runner(START),
    walkOf,
    settle,
  };
};

describe("online work runner", () => {
  test("a tick claims the first pending unit in registry order and records it building", async () => {
    const harness = createHarness();

    expect(await harness.tick()).toEqual({ type: "started", name: FIRST });
    expect(harness.claims).toEqual([FIRST]);
    expect(harness.rows.get(FIRST)).toMatchObject({
      state: "building",
      attempts: 1,
    });
    expect(harness.rows.has(SECOND)).toBe(false);
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
    expect(harness.rows.has(FIRST)).toBe(false);
  });

  test("a finished unit is finalized, released, and the next tick takes the next unit", async () => {
    const harness = createHarness();
    await harness.tick();

    harness.walkOf(FIRST).resolve({ type: "complete" });
    await harness.settle();

    expect(harness.rows.get(FIRST)).toMatchObject({ state: "finalized" });
    expect(harness.releases).toEqual([FIRST]);
    expect(await harness.tick()).toEqual({ type: "started", name: SECOND });
  });

  test("a failed unit records a bounded error without the database URL, reports it, and is retried", async () => {
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

    expect(settled?.status).toBe("rejected");
    const failed = harness.rows.get(FIRST);
    expect(failed?.state).toBe("failed");
    expect(failed?.lastError).not.toContain("secret");
    expect(failed?.lastError).toContain("[database-url]");
    expect(failed?.lastError?.length).toBe(2000);
    expect(harness.releases).toEqual([FIRST]);

    expect(await harness.tick()).toEqual({ type: "started", name: FIRST });
    expect(harness.rows.get(FIRST)).toMatchObject({
      state: "building",
      attempts: 2,
      lastError: null,
    });
  });

  test("a deferred unit stays building and the next tick claims it again", async () => {
    const harness = createHarness({ pending: [FIRST] });
    await harness.tick();

    harness
      .walkOf(FIRST)
      .resolve({ type: "deferred", step: FIRST, retryAfterMs: 60_000 });
    await harness.settle();

    expect(harness.rows.get(FIRST)).toMatchObject({ state: "building" });
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
        markBuilding: async () => {
          throw new Error("write refused");
        },
      },
      claim: async ({ name }) => ({
        type: "claimed",
        run: async () => ({ type: "complete" }),
        release: async () => {
          releases.push(name);
        },
      }),
      detach: () => undefined,
    });

    const rejection = await rejectionOf(runner(START));

    expect(rejection).toHaveProperty("message", "write refused");
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
    expect(ONLINE_WORK_LIFECYCLE[FIRST]).toEqual(FINALIZED);
    expect(harness.claims).toEqual([SECOND]);
  });
});
