import { describe, expect, test } from "bun:test";

import { detached } from "@/api/lib/analytics/capture";
import {
  currentQueryCounter,
  queryCountLogger,
  runOutsideQueryCounter,
  runWithQueryCounter,
} from "@/api/lib/db-query-counter";
import {
  currentRequestWork,
  recordReadWork,
} from "@/api/lib/observability/request-work";

/** Work that issues one statement at once and one after `release`. */
const gatedWork = () => {
  const gate = Promise.withResolvers<undefined>();
  const finished = Promise.withResolvers<undefined>();
  const work = async () => {
    queryCountLogger.logQuery("select 'before the caller returns'", []);
    recordReadWork("storageReadBytes", 10);
    await gate.promise;
    queryCountLogger.logQuery("select 'after the caller returns'", []);
    recordReadWork("storageReadBytes", 10);
    finished.resolve(undefined);
  };
  return { work, release: () => gate.resolve(undefined), finished };
};

describe("detached work and the caller's measurement", () => {
  test("statements and reads of detached work never reach the caller's counters", async () => {
    const { work, release, finished } = gatedWork();
    const measured = await runWithQueryCounter(async (outer) =>
      runWithQueryCounter(async (inner) => {
        queryCountLogger.logQuery("select 'caller'", []);
        detached(work, "test.detached-work");
        return { outer, inner };
      }),
    );
    expect(measured.inner.count).toBe(1);
    expect(measured.outer.count).toBe(1);

    // The detached work finishes long after the caller returned; whenever
    // that happens, the caller's totals stay what they were at return.
    release();
    await finished.promise;
    expect(measured.inner.count).toBe(1);
    expect(measured.outer.count).toBe(1);
    expect(measured.inner.storageReadBytes).toBe(0);
    expect(measured.outer.storageReadBytes).toBe(0);
  });

  test("a promise started inside the caller's context is charged whenever it runs", async () => {
    // The shape the helper replaces: the count depends on when the work runs.
    const { work, release, finished } = gatedWork();
    const counter = await runWithQueryCounter(async (active) => {
      const pending = work();
      expect(pending).toBeInstanceOf(Promise);
      return active;
    });
    expect(counter.count).toBe(1);
    release();
    await finished.promise;
    expect(counter.count).toBe(2);
  });

  test("detached work keeps running when the caller has no counter", async () => {
    const { work, release, finished } = gatedWork();
    detached(work, "test.detached-work");
    release();
    await finished.promise;
    expect(currentQueryCounter()).toBeUndefined();
  });

  test("a site's own rejection handler receives the failure, including a synchronous throw", async () => {
    const failures = Promise.withResolvers<unknown[]>();
    const received: unknown[] = [];
    const record = (error: unknown) => {
      received.push(error);
      if (received.length === 2) {
        failures.resolve(received);
      }
    };
    const rejected = new Error("rejected");
    const thrown = new Error("thrown");
    detached(
      async () => await Promise.reject(rejected),
      "test.rejected",
      record,
    );
    detached(
      () => {
        throw thrown;
      },
      "test.thrown",
      record,
    );
    expect(await failures.promise).toEqual(
      expect.arrayContaining([thrown, rejected]),
    );
  });

  test("the detachment covers every continuation of the work", async () => {
    const seen = await runWithQueryCounter(async () =>
      runOutsideQueryCounter(async () => {
        const atStart = currentQueryCounter();
        await Promise.resolve();
        const afterAwait = currentQueryCounter();
        const inMicrotask = await new Promise((resolve) => {
          queueMicrotask(() => resolve(currentRequestWork()));
        });
        return { atStart, afterAwait, inMicrotask };
      }),
    );
    expect(seen).toEqual({
      atStart: undefined,
      afterAwait: undefined,
      inMicrotask: undefined,
    });
  });
});
