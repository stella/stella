import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { LIMITS } from "@/api/lib/limits";

import {
  createDedicatedConnectionOwner,
  createDedicatedConnectionSlots,
} from "./dedicated-connection-slots";

type RecordingOwnerOptions = {
  capacity?: number;
  mode?:
    | "healthy"
    | "failFirstOpen"
    | "failWorkClose"
    | "failCancellationClose"
    | "failCancellationQuery"
    | "blockCancellation";
};

const recordingOwner = ({
  capacity = LIMITS.databaseDedicatedConnectionsPerProcess,
  mode = "healthy",
}: RecordingOwnerOptions = {}) => {
  let active = 0;
  let peak = 0;
  let opens = 0;
  const failure = new TypeError("Dedicated transport failed");
  const cancellationGate = Promise.withResolvers<undefined>();
  const owner = createDedicatedConnectionOwner({
    capacity,
    openClient: (options) => {
      opens += 1;
      expect(options.max).toBe(1);
      if (mode === "failFirstOpen" && opens === 1) {
        throw failure;
      }
      const kind =
        options.connection?.["statement_timeout"] === 500
          ? "cancellation"
          : "work";
      active += 1;
      peak = Math.max(peak, active);
      let state: "open" | "closed" = "open";
      return {
        unsafe: async () => {
          if (kind === "cancellation" && mode === "blockCancellation") {
            await cancellationGate.promise;
          }
          if (kind === "cancellation" && mode === "failCancellationQuery") {
            throw failure;
          }
          await Promise.resolve();
          return [];
        },
        end: async () => {
          if (
            (kind === "work" && mode === "failWorkClose") ||
            (kind === "cancellation" && mode === "failCancellationClose")
          ) {
            throw failure;
          }
          expect(state).toBe("open");
          state = "closed";
          active -= 1;
        },
      };
    },
  });
  return {
    owner,
    stats: () => ({ active, peak, opens }),
    failure,
    cancellationGate,
  };
};

const workOptions = (signal = new AbortController().signal) => ({
  url: "postgres://localhost/test",
  connectionTimeout: 1,
  statementTimeout: 1000,
  lockTimeout: 100,
  cancellationStatementTimeout: 500,
  signal,
});

describe("dedicated connection lifecycle", () => {
  test("the actual owner bounds concurrent work and cancellation clients", async () => {
    const { owner, stats } = recordingOwner();
    await Promise.all(
      Array.from({ length: 100 }, async () => {
        const job = await owner.openLongRunningSql(workOptions());
        const cancellation = job.cancelBackend(42);
        expect(job.cancelBackend(42)).toBe(cancellation);
        await cancellation;
        await job.end();
      }),
    );
    expect(stats()).toEqual({
      active: 0,
      peak: LIMITS.databaseDedicatedConnectionsPerProcess,
      opens: 200,
    });
  });

  test("maintenance waiters consume no sessions and share the work ceiling", async () => {
    const { owner, stats } = recordingOwner({ capacity: 3 });
    const lane = await owner.openMaintenanceSql("postgres://localhost/test");
    const nextLane = owner.openMaintenanceSql("postgres://localhost/test");
    const job = await owner.openLongRunningSql(workOptions());
    await job.cancelBackend(42);
    expect(stats().opens).toBe(3);
    expect(stats().peak).toBe(3);
    await job.end();
    await lane.end();
    const next = await nextLane;
    await next.end();
    expect(stats().active).toBe(0);
  });

  test("a constructor failure returns capacity for the next job", async () => {
    const { owner, failure, stats } = recordingOwner({
      capacity: 3,
      mode: "failFirstOpen",
    });
    expect(await rejectionOf(owner.openLongRunningSql(workOptions()))).toBe(
      failure,
    );
    const job = await owner.openLongRunningSql(workOptions());
    await job.end();
    expect(stats().active).toBe(0);
  });

  test("closing drains cancellation before its slots are reused", async () => {
    const { owner, stats, cancellationGate } = recordingOwner({
      capacity: 3,
      mode: "blockCancellation",
    });
    const job = await owner.openLongRunningSql(workOptions());
    const cancelled = job.cancelBackend(42);
    await Promise.resolve();
    const closing = job.end();
    const next = owner.openLongRunningSql(workOptions());
    await Promise.resolve();
    expect(stats().active).toBe(2);
    expect(stats().opens).toBe(2);
    cancellationGate.resolve(undefined);
    await cancelled;
    await closing;
    const successor = await next;
    await successor.end();
    expect(stats().active).toBe(0);
  });

  test("a query failure still closes cancellation and returns capacity", async () => {
    const { owner, stats, failure } = recordingOwner({
      capacity: 3,
      mode: "failCancellationQuery",
    });
    const job = await owner.openLongRunningSql(workOptions());
    expect(await rejectionOf(job.cancelBackend(42))).toBe(failure);
    await job.end();
    const next = await owner.openLongRunningSql(workOptions());
    await next.end();
    expect(stats().active).toBe(0);
  });

  for (const mode of ["failWorkClose", "failCancellationClose"] as const) {
    test(`${mode} retains capacity while its backend may still be alive`, async () => {
      const { owner, stats, failure } = recordingOwner({ capacity: 3, mode });
      const job = await owner.openLongRunningSql(workOptions());
      if (mode === "failWorkClose") {
        expect(await rejectionOf(job.end())).toBe(failure);
      } else {
        expect(await rejectionOf(job.cancelBackend(42))).toBe(failure);
        await job.end();
      }
      const controller = new AbortController();
      const queued = rejectionOf(
        owner.openLongRunningSql(workOptions(controller.signal)),
      );
      await Promise.resolve();
      expect(stats().active).toBe(1);
      expect(stats().opens).toBe(mode === "failWorkClose" ? 1 : 2);
      controller.abort();
      expect(await queued).toBe(controller.signal.reason);
    });
  }

  test("cancellation cannot open a second backend or outlive its owner", async () => {
    const { owner } = recordingOwner();
    const job = await owner.openLongRunningSql(workOptions());
    await job.cancelBackend(42);
    expect(() => job.cancelBackend(43)).toThrow("different backend");
    await job.end();
    expect(() => job.cancelBackend(42)).toThrow(
      "after dedicated connection closed",
    );
    expect(await rejectionOf(job.end())).toHaveProperty(
      "message",
      "Dedicated connection already closing",
    );
  });
});

describe("dedicated connection admission", () => {
  test("concurrent jobs and their cancellers never exceed the process ceiling", async () => {
    const capacity = LIMITS.databaseDedicatedConnectionsPerProcess;
    const acquire = createDedicatedConnectionSlots(capacity);
    let connections = 0;
    let peak = 0;
    let completed = 0;
    await Promise.all(
      Array.from({ length: 100 }, async () => {
        const release = await acquire({ kind: "longRunning" });
        // Each job holds its work session while its cancellation session opens.
        connections += 2;
        peak = Math.max(peak, connections);
        expect(connections).toBeLessThanOrEqual(capacity);
        await Promise.resolve();
        connections -= 2;
        release();
        completed += 1;
      }),
    );
    expect(peak).toBe(capacity);
    expect(connections).toBe(0);
    expect(completed).toBe(100);
  });

  test("a released slot admits queued work", async () => {
    const acquire = createDedicatedConnectionSlots(3);
    const releaseFirst = await acquire({ kind: "longRunning" });
    let admitted = false;
    const next = acquire({ kind: "longRunning" }).then((release) => {
      admitted = true;
      return release;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
    releaseFirst();
    const releaseNext = await next;
    expect(admitted).toBe(true);
    releaseNext();
  });

  test("a waiting maintenance lane leaves room for its current holder's work", async () => {
    const acquire = createDedicatedConnectionSlots(3);
    const releaseLane = await acquire({ kind: "maintenance" });
    let nextLaneHeld = false;
    const nextLane = acquire({ kind: "maintenance" }).then((release) => {
      nextLaneHeld = true;
      return release;
    });
    const releaseWork = await acquire({ kind: "longRunning" });
    expect(nextLaneHeld).toBe(false);
    releaseWork();
    releaseLane();
    const releaseNextLane = await nextLane;
    expect(nextLaneHeld).toBe(true);
    releaseNextLane();
  });

  test("aborted waiters leave no occupied slots or blocked successors", async () => {
    const acquire = createDedicatedConnectionSlots(3);
    const release = await acquire({ kind: "longRunning" });
    const controller = new AbortController();
    const reason = new DOMException("Stop queued work", "AbortError");
    const rejected = rejectionOf(
      acquire({ kind: "longRunning", signal: controller.signal }),
    );
    const successor = acquire({ kind: "longRunning" });
    controller.abort(reason);
    expect(await rejected).toBe(reason);
    release();
    const releaseSuccessor = await successor;
    releaseSuccessor();
    expect(
      await rejectionOf(
        acquire({ kind: "longRunning", signal: controller.signal }),
      ),
    ).toBe(reason);
    const releaseAfterAbort = await acquire({ kind: "longRunning" });
    releaseAfterAbort();
  });

  test("double release cannot inflate available capacity", async () => {
    const acquire = createDedicatedConnectionSlots(3);
    const release = await acquire({ kind: "longRunning" });
    release();
    expect(release).toThrow("Dedicated connection slots released twice");
  });

  test("capacity must admit a lane plus a work and cancellation pair", () => {
    for (const capacity of [0, 1, 2, 3.5, Infinity, Number.NaN]) {
      expect(() => createDedicatedConnectionSlots(capacity)).toThrow(
        "Dedicated connection capacity",
      );
    }
  });
});
