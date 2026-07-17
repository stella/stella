/* eslint-disable no-await-in-loop -- These tests drive the queue by hand:
   each step must settle an upload and flush microtasks before the next, so
   the awaits are sequential by design (Promise.all would break the ordering
   the scheduling invariants depend on). */
import { describe, expect, jest, test } from "bun:test";

import { UploadQueue } from "@/lib/upload-queue";

/**
 * Tests for the concurrent upload state machine. The state map these
 * tests pin (transitions in parentheses):
 *
 *   idle ──enqueue──▶ running
 *   running ──pause──▶ paused ──resume──▶ running
 *   running ──(429)──▶ rate-limited ──resume/timer──▶ running
 *   running ──cancel──▶ cancelled       (emits done{cancelled:true})
 *   running ──(drain: no pending/inflight/retrying)──▶ done
 *                                        (emits done{cancelled:false})
 *   done|cancelled ──retryFailed──▶ running   (fresh batch of failed files)
 *   done ──enqueue──▶ running                 (fresh batch)
 *
 * Per-file outcome inside a batch is completed | failed | retrying(transient).
 * Retryable = HTTP >= 500 or status 0 (network); 429 = rate-limit; other
 * 4xx or exhausted retries = permanent failure.
 */

// A single microtask flush cannot cover the module's multi-await retry
// chains, so pump several ticks. Cheap and deterministic.
const flush = async (ticks = 40) => {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
};

const makeFile = (name: string) =>
  new File(["x"], name, { type: "text/plain" });
const makeFiles = (...names: string[]) => names.map(makeFile);

const httpError = (status: number): Error & { status: number } =>
  Object.assign(new Error(`HTTP ${status}`), { status });

const rateLimitError = (retryAfterS?: number) => {
  const headers = new Headers();
  if (retryAfterS !== undefined) {
    headers.set("Retry-After", String(retryAfterS));
  }
  return Object.assign(new Error("HTTP 429"), {
    status: 429,
    response: new Response(null, { status: 429, headers }),
  });
};

type PendingUpload = {
  name: string;
  signal: AbortSignal;
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
};

/**
 * Scripted uploader: every call hangs until the test resolves/rejects it by
 * file name, so interleavings are deterministic. It also records the numbers
 * the invariants care about:
 *   - `maxActive`: peak concurrent in-flight calls (concurrency cap).
 *   - `callsByFile`: total invocations per file (double-upload detection).
 *   - `sawConcurrentDoubleUpload`: two live calls for the same file at once.
 */
class ScriptedUploader {
  active = 0;
  maxActive = 0;
  totalCalls = 0;
  readonly callsByFile = new Map<string, number>();
  sawConcurrentDoubleUpload = false;

  private readonly live: PendingUpload[] = [];
  private readonly liveNames = new Set<string>();
  private readonly settled = new WeakSet<PendingUpload>();

  readonly fn = (file: File, signal: AbortSignal): Promise<string> => {
    this.totalCalls++;
    this.callsByFile.set(file.name, (this.callsByFile.get(file.name) ?? 0) + 1);
    if (this.liveNames.has(file.name)) {
      this.sawConcurrentDoubleUpload = true;
    }
    this.liveNames.add(file.name);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);

    return new Promise<string>((resolve, reject) => {
      const entry: PendingUpload = {
        name: file.name,
        signal,
        resolve: (value) => {
          this.finish(entry);
          resolve(value);
        },
        reject: (error) => {
          this.finish(entry);
          reject(error);
        },
      };
      signal.addEventListener("abort", () => {
        if (this.settled.has(entry)) {
          return;
        }
        // Mirror fetch(): an aborted request rejects. The queue checks
        // `signal.aborted` and bails before treating this as retryable.
        entry.reject(new DOMException("Aborted", "AbortError"));
      });
      this.live.push(entry);
    });
  };

  private finish(entry: PendingUpload) {
    if (this.settled.has(entry)) {
      return;
    }
    this.settled.add(entry);
    this.active--;
    this.liveNames.delete(entry.name);
    const index = this.live.indexOf(entry);
    if (index !== -1) {
      this.live.splice(index, 1);
    }
  }

  private pendingFor(name: string): PendingUpload {
    const entry = this.live.find((p) => p.name === name);
    if (!entry) {
      throw new Error(`no in-flight upload for "${name}"`);
    }
    return entry;
  }

  resolveFile(name: string, value = `ok:${name}`) {
    this.pendingFor(name).resolve(value);
  }

  rejectFile(name: string, error: unknown) {
    this.pendingFor(name).reject(error);
  }

  liveNamesList(): string[] {
    return this.live.map((p) => p.name);
  }

  callCount(name: string): number {
    return this.callsByFile.get(name) ?? 0;
  }
}

type DoneEvent = {
  completed: unknown[];
  failed: { file: File; error: Error }[];
  cancelled: boolean;
};

/** Wire up a queue with recording listeners for the events under test. */
const harness = <T = string>(
  uploader: ScriptedUploader,
  concurrency: number,
) => {
  const queue = new UploadQueue<T>(
    uploader.fn as (file: File, signal: AbortSignal) => Promise<T>,
    concurrency,
  );
  const doneEvents: DoneEvent[] = [];
  const states: string[] = [];
  const progress: { completed: number; failed: number; total: number }[] = [];
  const rateLimited: { retryAfterS: number }[] = [];
  queue.on("done", (data) => doneEvents.push(data as DoneEvent));
  queue.on("state-change", (state) => states.push(state));
  queue.on("progress", (data) => progress.push(data));
  queue.on("rate-limited", (data) => rateLimited.push(data));
  return { queue, doneEvents, states, progress, rateLimited };
};

describe("terminal state is reached exactly once", () => {
  test("a clean batch classifies every file as completed and fires done once", async () => {
    const uploader = new ScriptedUploader();
    const { queue, doneEvents } = harness(uploader, 5);

    queue.enqueue(makeFiles("a", "b", "c"));
    await flush();

    uploader.resolveFile("a");
    uploader.resolveFile("b");
    uploader.resolveFile("c");
    await flush();

    expect(queue.getState()).toBe("done");
    expect(doneEvents).toHaveLength(1);
    const done = doneEvents[0]!;
    expect(done.cancelled).toBe(false);
    expect(done.completed).toHaveLength(3);
    expect(done.failed).toHaveLength(0);
    // completed + failed accounts for the whole batch, no double counting.
    expect(done.completed.length + done.failed.length).toBe(3);
    expect(queue.getProgress()).toEqual({ completed: 3, failed: 0, total: 3 });
  });

  test("a mixed batch partitions files into completed xor failed", async () => {
    const uploader = new ScriptedUploader();
    const { queue, doneEvents } = harness(uploader, 5);

    queue.enqueue(makeFiles("ok1", "bad", "ok2"));
    await flush();

    uploader.resolveFile("ok1");
    uploader.rejectFile("bad", httpError(400)); // permanent 4xx, not retried
    uploader.resolveFile("ok2");
    await flush();

    expect(queue.getState()).toBe("done");
    expect(doneEvents).toHaveLength(1);
    const done = doneEvents[0]!;
    expect(done.completed).toHaveLength(2);
    expect(done.failed).toHaveLength(1);
    expect(done.failed[0]!.file.name).toBe("bad");
    expect(done.completed.length + done.failed.length).toBe(3);
    // A permanent 4xx is never retried.
    expect(uploader.callCount("bad")).toBe(1);
    expect(uploader.sawConcurrentDoubleUpload).toBe(false);
  });

  test("cancelling fires exactly one done{cancelled:true} and is idempotent", async () => {
    const uploader = new ScriptedUploader();
    const { queue, doneEvents } = harness(uploader, 5);

    queue.enqueue(makeFiles("a", "b", "c"));
    await flush();
    expect(uploader.active).toBe(3);

    queue.cancel();
    await flush();

    expect(queue.getState()).toBe("cancelled");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]!.cancelled).toBe(true);
    // Aborted in-flight uploads are neither completed nor failed.
    expect(doneEvents[0]!.completed).toHaveLength(0);
    expect(doneEvents[0]!.failed).toHaveLength(0);
    // Abort settles the in-flight promises: nothing is left hanging.
    expect(uploader.active).toBe(0);

    // A second cancel (and cancel-after-done) must not re-terminate.
    queue.cancel();
    await flush();
    expect(doneEvents).toHaveLength(1);
  });
});

describe("no double upload", () => {
  test("a completed file is never uploaded again during the batch", async () => {
    const uploader = new ScriptedUploader();
    const { queue } = harness(uploader, 2);

    queue.enqueue(makeFiles("a", "b", "c", "d"));
    await flush();

    // Drain in a staggered order; each completion pulls in the next file.
    for (const name of ["a", "b", "c", "d"]) {
      uploader.resolveFile(name);
      await flush();
    }

    expect(queue.getState()).toBe("done");
    for (const name of ["a", "b", "c", "d"]) {
      expect(uploader.callCount(name)).toBe(1);
    }
    expect(uploader.sawConcurrentDoubleUpload).toBe(false);
  });

  test("a retried file runs its next attempt only after the previous settles", async () => {
    jest.useFakeTimers();
    try {
      const uploader = new ScriptedUploader();
      const { queue, doneEvents } = harness(uploader, 2);

      queue.enqueue(makeFiles("flaky"));
      await flush();
      expect(uploader.callCount("flaky")).toBe(1);

      uploader.rejectFile("flaky", httpError(500)); // retryable
      await flush();
      // Still in backoff: no second attempt yet, nothing in flight.
      expect(uploader.callCount("flaky")).toBe(1);
      expect(uploader.active).toBe(0);

      jest.advanceTimersByTime(1000); // RETRY_BACKOFF_MS[0]
      await flush();
      expect(uploader.callCount("flaky")).toBe(2);
      expect(uploader.active).toBe(1);

      uploader.resolveFile("flaky");
      await flush();

      expect(queue.getState()).toBe("done");
      expect(doneEvents).toHaveLength(1);
      expect(doneEvents[0]!.completed).toHaveLength(1);
      expect(uploader.sawConcurrentDoubleUpload).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test("retries are exhausted after MAX_RETRIES then the file fails", async () => {
    jest.useFakeTimers();
    try {
      const uploader = new ScriptedUploader();
      const { queue, doneEvents } = harness(uploader, 2);

      queue.enqueue(makeFiles("doomed"));
      await flush();

      // attempt 0, then backoffs 1000 / 2000 / 4000 for attempts 1..3.
      const backoffs = [1000, 2000, 4000];
      uploader.rejectFile("doomed", httpError(503));
      await flush();
      for (const delay of backoffs) {
        jest.advanceTimersByTime(delay);
        await flush();
        uploader.rejectFile("doomed", httpError(503));
        await flush();
      }

      expect(queue.getState()).toBe("done");
      expect(doneEvents).toHaveLength(1);
      expect(doneEvents[0]!.cancelled).toBe(false);
      expect(doneEvents[0]!.failed).toHaveLength(1);
      expect(doneEvents[0]!.completed).toHaveLength(0);
      // 1 initial attempt + 3 retries = 4 uploads, never concurrent.
      expect(uploader.callCount("doomed")).toBe(4);
      expect(uploader.sawConcurrentDoubleUpload).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("concurrency cap", () => {
  test("in-flight count never exceeds the cap while draining a large batch", async () => {
    const uploader = new ScriptedUploader();
    const cap = 3;
    const { queue } = harness(uploader, cap);

    const names = Array.from({ length: 9 }, (_, i) => `f${i}`);
    queue.enqueue(makeFiles(...names));
    await flush();

    expect(uploader.active).toBe(cap);

    // Settle files one at a time; each free slot pulls in exactly one more.
    let guard = 0;
    while (uploader.active > 0 && guard++ < 50) {
      expect(uploader.active).toBeLessThanOrEqual(cap);
      uploader.resolveFile(uploader.liveNamesList()[0]!);
      await flush();
    }

    expect(queue.getState()).toBe("done");
    expect(uploader.maxActive).toBe(cap);
    expect(uploader.sawConcurrentDoubleUpload).toBe(false);
  });

  test("interleaved success and permanent failure never exceed the cap", async () => {
    const uploader = new ScriptedUploader();
    const cap = 2;
    const { queue, doneEvents } = harness(uploader, cap);

    const names = ["a", "b", "c", "d", "e"];
    queue.enqueue(makeFiles(...names));
    await flush();

    // Deterministic interleaving of resolves and 4xx failures.
    const script: [string, "ok" | "fail"][] = [
      ["a", "ok"],
      ["b", "fail"],
      ["c", "ok"],
      ["d", "fail"],
      ["e", "ok"],
    ];
    for (const [name, outcome] of script) {
      expect(uploader.active).toBeLessThanOrEqual(cap);
      if (outcome === "ok") {
        uploader.resolveFile(name);
      } else {
        uploader.rejectFile(name, httpError(422));
      }
      await flush();
    }

    expect(queue.getState()).toBe("done");
    expect(uploader.maxActive).toBeLessThanOrEqual(cap);
    expect(doneEvents[0]!.completed).toHaveLength(3);
    expect(doneEvents[0]!.failed).toHaveLength(2);
  });
});

describe("rate limiting (429)", () => {
  test("a 429 parks the file, honours Retry-After, then resumes it once", async () => {
    jest.useFakeTimers();
    try {
      const uploader = new ScriptedUploader();
      const { queue, doneEvents, rateLimited } = harness(uploader, 2);

      queue.enqueue(makeFiles("a", "b"));
      await flush();

      uploader.rejectFile("a", rateLimitError(5));
      await flush();
      expect(queue.getState()).toBe("rate-limited");
      expect(rateLimited).toEqual([{ retryAfterS: 5 }]);

      // The other in-flight file may still finish; pump stays parked.
      uploader.resolveFile("b");
      await flush();
      expect(queue.getState()).toBe("rate-limited");
      expect(uploader.active).toBe(0);

      jest.advanceTimersByTime(5000);
      await flush();
      // Resumed: "a" was put back and re-attempted exactly once more.
      expect(uploader.callCount("a")).toBe(2);
      expect(uploader.active).toBe(1);

      uploader.resolveFile("a");
      await flush();

      expect(queue.getState()).toBe("done");
      expect(doneEvents).toHaveLength(1);
      expect(doneEvents[0]!.completed).toHaveLength(2);
      expect(uploader.sawConcurrentDoubleUpload).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("cancelling during rate-limit clears the timer and never double-terminates", async () => {
    jest.useFakeTimers();
    try {
      const uploader = new ScriptedUploader();
      const { queue, doneEvents } = harness(uploader, 2);

      queue.enqueue(makeFiles("a", "b"));
      await flush();
      uploader.rejectFile("a", rateLimitError(30));
      await flush();
      expect(queue.getState()).toBe("rate-limited");

      queue.cancel();
      await flush();
      expect(queue.getState()).toBe("cancelled");
      expect(doneEvents).toHaveLength(1);
      expect(doneEvents[0]!.cancelled).toBe(true);
      // The rate-limit timer was cleared, so it cannot fire a late resume.
      expect(jest.getTimerCount()).toBe(0);

      jest.advanceTimersByTime(60_000);
      await flush();
      expect(doneEvents).toHaveLength(1);
      expect(queue.getState()).toBe("cancelled");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("retryFailed", () => {
  test("re-runs only the failed files as a fresh batch", async () => {
    const uploader = new ScriptedUploader();
    const { queue, doneEvents } = harness(uploader, 5);

    queue.enqueue(makeFiles("keep", "drop"));
    await flush();
    uploader.resolveFile("keep");
    uploader.rejectFile("drop", httpError(400));
    await flush();
    expect(doneEvents).toHaveLength(1);
    expect(queue.getFailedFiles().map((f) => f.file.name)).toEqual(["drop"]);

    queue.retryFailed();
    await flush();
    // Only the previously failed file is re-uploaded; the completed one is not.
    expect(uploader.callCount("keep")).toBe(1);
    expect(uploader.callCount("drop")).toBe(2);
    // retryFailed starts a fresh batch scoped to the retried files: total and
    // completed are reset, so the new done reflects only this retry batch.
    expect(queue.getProgress().total).toBe(1);

    uploader.resolveFile("drop");
    await flush();

    expect(queue.getState()).toBe("done");
    expect(doneEvents).toHaveLength(2);
    expect(doneEvents[1]!.completed).toHaveLength(1);
    expect(doneEvents[1]!.failed).toHaveLength(0);
  });

  test("is ignored while a batch is still running", async () => {
    const uploader = new ScriptedUploader();
    const { queue } = harness(uploader, 5);

    queue.enqueue(makeFiles("a"));
    await flush();
    queue.retryFailed(); // no-op: state is running
    await flush();

    expect(queue.getState()).toBe("running");
    expect(uploader.callCount("a")).toBe(1);
    uploader.resolveFile("a");
    await flush();
    expect(queue.getState()).toBe("done");
  });
});

describe("progress and drain", () => {
  test("progress counters are monotonically non-decreasing within a batch", async () => {
    const uploader = new ScriptedUploader();
    const { queue, progress } = harness(uploader, 3);

    queue.enqueue(makeFiles("a", "b", "c", "d"));
    await flush();
    uploader.resolveFile("a");
    await flush();
    uploader.rejectFile("b", httpError(400));
    await flush();
    uploader.resolveFile("c");
    await flush();
    uploader.resolveFile("d");
    await flush();

    expect(queue.getState()).toBe("done");
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]!.completed).toBeGreaterThanOrEqual(
        progress[i - 1]!.completed,
      );
      expect(progress[i]!.failed).toBeGreaterThanOrEqual(
        progress[i - 1]!.failed,
      );
      expect(progress[i]!.total).toBe(4);
    }
    expect(queue.getProgress()).toEqual({ completed: 3, failed: 1, total: 4 });
  });

  test("a fully drained batch leaves no in-flight work and no pending timers", async () => {
    jest.useFakeTimers();
    try {
      const uploader = new ScriptedUploader();
      const { queue } = harness(uploader, 3);

      queue.enqueue(makeFiles("a", "b", "c"));
      await flush();
      uploader.resolveFile("a");
      uploader.resolveFile("b");
      uploader.resolveFile("c");
      await flush();

      expect(queue.getState()).toBe("done");
      expect(uploader.active).toBe(0);
      expect(uploader.liveNamesList()).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("interleaving table (deterministic scheduling coverage)", () => {
  // Several fixed completion orders over the same batch, each asserting the
  // core invariants. Gives interleaving breadth without a property runner
  // (apps/web does not depend on fast-check).
  const orders: string[][] = [
    ["a", "b", "c", "d"],
    ["d", "c", "b", "a"],
    ["b", "d", "a", "c"],
    ["c", "a", "d", "b"],
  ];
  const failers = new Set(["b"]);

  for (const [index, order] of orders.entries()) {
    test(`order #${index} respects cap, single done, exact partition`, async () => {
      const uploader = new ScriptedUploader();
      const cap = 2;
      const { queue, doneEvents } = harness(uploader, cap);

      queue.enqueue(makeFiles("a", "b", "c", "d"));
      await flush();

      for (const name of order) {
        expect(uploader.active).toBeLessThanOrEqual(cap);
        // A file is only in flight once it has been pulled from pending;
        // settle whichever live file the order names, else advance and retry.
        if (uploader.liveNamesList().includes(name)) {
          if (failers.has(name)) {
            uploader.rejectFile(name, httpError(400));
          } else {
            uploader.resolveFile(name);
          }
          await flush();
        }
      }
      // Drain anything still live (files the order could not reach yet).
      let guard = 0;
      while (uploader.active > 0 && guard++ < 20) {
        const name = uploader.liveNamesList()[0]!;
        if (failers.has(name)) {
          uploader.rejectFile(name, httpError(400));
        } else {
          uploader.resolveFile(name);
        }
        await flush();
      }

      expect(queue.getState()).toBe("done");
      expect(doneEvents).toHaveLength(1);
      expect(uploader.maxActive).toBeLessThanOrEqual(cap);
      expect(uploader.sawConcurrentDoubleUpload).toBe(false);
      const { completed, failed } = doneEvents[0]!;
      expect(completed.length + failed.length).toBe(4);
      expect(failed).toHaveLength(1);
      expect(failed[0]!.file.name).toBe("b");
    });
  }
});

describe("KNOWN BUG: retry re-injection oversubscribes the concurrency cap", () => {
  // The retry path frees the file's slot (deletes it from `inflight`) and
  // then calls pump() to fill that slot with the next pending file *before*
  // awaiting the backoff. When the backoff elapses, processFile() re-inserts
  // the retried file directly into `inflight` without re-checking the cap, so
  // the in-flight count transiently exceeds `concurrency`.
  //
  // This test documents the CURRENT (buggy) behaviour so a future fix has a
  // regression anchor; the assertion below flips once the cap is respected.
  // See report: no product-code fix is made in this tests-only change.
  test("in-flight count reaches cap + 1 when a retry resumes into a full pipe", async () => {
    jest.useFakeTimers();
    try {
      const uploader = new ScriptedUploader();
      const cap = 1;
      const { queue } = harness(uploader, cap);

      queue.enqueue(makeFiles("retry", "filler"));
      await flush();
      expect(uploader.active).toBe(1); // "retry" in flight, "filler" pending

      // "retry" fails retryably; its slot is freed and pump() starts "filler".
      uploader.rejectFile("retry", httpError(500));
      await flush();
      expect(uploader.liveNamesList()).toEqual(["filler"]);
      expect(uploader.active).toBe(1);

      // "filler" is still hanging when the backoff elapses and "retry" resumes.
      jest.advanceTimersByTime(1000);
      await flush();

      // BUG: two uploads are now concurrent under a cap of 1.
      expect(uploader.active).toBe(2);
      expect(uploader.maxActive).toBe(cap + 1);
      // The two live uploads are different files, so this is a cap breach,
      // not the same file uploaded twice at once.
      expect(uploader.sawConcurrentDoubleUpload).toBe(false);

      uploader.resolveFile("filler");
      uploader.resolveFile("retry");
      await flush();
      expect(queue.getState()).toBe("done");
    } finally {
      jest.useRealTimers();
    }
  });
});
