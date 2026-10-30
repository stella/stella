import { describe, expect, jest, test } from "bun:test";

import { restoreRealTimers } from "@stll/property-testing/fake-timers";

import { readQueryResult } from "@/lib/errors/query-result";
import { UploadQueue } from "@/lib/upload-queue";
import {
  createFileEntityUploader,
  type FileEntityUploadGrant,
  finalizeFailureKeepsUpload,
} from "@/lib/workspaces/mutations/file-entity-upload.logic";

// The queue's retry chains span several awaits; pump enough microtasks.
const flush = async (ticks = 60) => {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
};

const httpError = (status: number): Error & { status: number } =>
  Object.assign(new Error(`HTTP ${status}`), { status });

type FinalizeOutcome = { type: "ok" } | { type: "throw"; error: unknown };

/**
 * Upload steps with scripted finalize outcomes. Each reservation mints the
 * next upload id; every step call is recorded so tests can count reservations
 * and see which upload id each finalize targeted.
 */
const scriptedSteps = (finalizeOutcomes: FinalizeOutcome[]) => {
  const reservations: string[] = [];
  const puts: string[] = [];
  const finalizes: string[] = [];
  const aborts: string[] = [];

  const steps = {
    reserve: async (): Promise<FileEntityUploadGrant> => {
      const uploadId = `upload-${reservations.length + 1}`;
      reservations.push(uploadId);
      return await Promise.resolve({
        uploadId,
        url: `https://storage.test/${uploadId}`,
        headers: {},
      });
    },
    put: async (_file: File, grant: FileEntityUploadGrant) => {
      puts.push(grant.uploadId);
      await Promise.resolve();
    },
    finalize: async (uploadId: string, signal: AbortSignal) => {
      finalizes.push(uploadId);
      const outcome = finalizeOutcomes.shift();
      if (outcome === undefined) {
        // Hold the finalize in flight until the batch is cancelled.
        return await new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }
      if (outcome.type === "throw") {
        throw outcome.error;
      }
      return await Promise.resolve(`entity-for-${uploadId}`);
    },
    abort: async (uploadId: string) => {
      aborts.push(uploadId);
      await Promise.resolve();
    },
  };

  return { steps, reservations, puts, finalizes, aborts };
};

const runBatch = (steps: ReturnType<typeof scriptedSteps>["steps"]) => {
  const uploader = createFileEntityUploader<string>(steps);
  const queue = new UploadQueue<string>(
    async (file, signal) =>
      readQueryResult(await uploader.upload(file, signal)),
    1,
  );
  const done: { completed: string[]; failed: number; cancelled: boolean }[] =
    [];
  queue.on("done", (event) => {
    done.push({
      completed: [...event.completed],
      failed: event.failed.length,
      cancelled: event.cancelled,
    });
  });
  return { uploader, queue, done };
};

const file = () => new File(["contract"], "contract.pdf");

describe("file entity upload retries", () => {
  test.each([{ phase: "reserve" }, { phase: "put" }, { phase: "finalize" }])(
    "preserves a rejected $phase response through the typed failure boundary",
    async ({ phase }) => {
      const failure = {
        status: 503,
        response: new Response(null, { status: 503 }),
      };
      const script = scriptedSteps([{ type: "ok" }]);
      const reject = jest.fn<() => Promise<never>>().mockRejectedValue(failure);
      const uploader = createFileEntityUploader({
        ...script.steps,
        reserve: phase === "reserve" ? reject : script.steps.reserve,
        put: phase === "put" ? reject : script.steps.put,
        finalize: phase === "finalize" ? reject : script.steps.finalize,
      });

      const outcome = await uploader.upload(
        file(),
        new AbortController().signal,
      );

      expect(outcome.isErr()).toBe(true);
      if (outcome.isErr()) {
        expect(outcome.error).toBeInstanceOf(Error);
        expect(outcome.error.cause).toBe(failure);
        expect(outcome.error).toMatchObject({
          status: failure.status,
          response: failure.response,
        });
      }
    },
  );

  test.each([
    { status: 409, retries: true },
    { status: 422, retries: false },
  ])(
    "retains a plain HTTP failure's $status retry disposition",
    async ({ status, retries }) => {
      const script = scriptedSteps([
        { type: "throw", error: { status, message: "Upload refused" } },
        { type: "ok" },
      ]);
      const { queue, done } = runBatch(script.steps);

      queue.enqueue([file()]);
      await flush();
      queue.retryFailed();
      await flush();

      expect(script.reservations).toEqual(["upload-1"]);
      expect(script.finalizes).toEqual(
        retries ? ["upload-1", "upload-1"] : ["upload-1"],
      );
      expect(done.at(-1)).toMatchObject({ failed: retries ? 0 : 1 });
    },
  );

  test.each([
    { name: "transport failure", error: new TypeError("Failed to fetch") },
    { name: "request timeout", error: httpError(408) },
    { name: "plain request timeout", error: { status: 408 } },
  ])(
    "a finalize $name retries the same upload without another PUT",
    async ({ error }) => {
      jest.useFakeTimers();
      try {
        const script = scriptedSteps([
          { type: "throw", error },
          { type: "ok" },
        ]);
        const { queue, done } = runBatch(script.steps);

        queue.enqueue([file()]);
        await flush();
        jest.advanceTimersByTime(1000);
        await flush();

        expect(script.reservations).toEqual(["upload-1"]);
        expect(script.puts).toEqual(["upload-1"]);
        expect(script.finalizes).toEqual(["upload-1", "upload-1"]);
        expect(done).toEqual([
          { completed: ["entity-for-upload-1"], failed: 0, cancelled: false },
        ]);
      } finally {
        restoreRealTimers();
      }
    },
  );

  test("a plain rate-limit response keeps its retry delay and upload identity", async () => {
    jest.useFakeTimers();
    try {
      const response = new Response(null, {
        status: 429,
        headers: { "Retry-After": "2" },
      });
      const script = scriptedSteps([
        { type: "throw", error: { response } },
        { type: "ok" },
      ]);
      const { queue, done } = runBatch(script.steps);
      const delays: number[] = [];
      queue.on("rate-limited", ({ retryAfterS }) => {
        delays.push(retryAfterS);
      });

      queue.enqueue([file()]);
      await flush();
      expect(delays).toEqual([2]);
      expect(queue.getState()).toBe("rate-limited");
      jest.advanceTimersByTime(1999);
      await flush();
      expect(script.finalizes).toEqual(["upload-1"]);
      jest.advanceTimersByTime(1);
      await flush();

      expect(script.reservations).toEqual(["upload-1"]);
      expect(script.puts).toEqual(["upload-1"]);
      expect(script.finalizes).toEqual(["upload-1", "upload-1"]);
      expect(done.at(-1)).toMatchObject({ failed: 0, cancelled: false });
    } finally {
      restoreRealTimers();
    }
  });

  test("an existing error keeps its identity through the upload result", async () => {
    const failure = new TypeError("Failed to fetch");
    const script = scriptedSteps([{ type: "throw", error: failure }]);
    const uploader = createFileEntityUploader(script.steps);
    const outcome = await uploader.upload(file(), new AbortController().signal);

    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error).toBe(failure);
    }
  });

  test("a lost finalize response retains its upload after automatic retries are exhausted", async () => {
    jest.useFakeTimers();
    try {
      const script = scriptedSteps([
        { type: "throw", error: httpError(408) },
        { type: "throw", error: httpError(408) },
        { type: "throw", error: httpError(408) },
        { type: "throw", error: httpError(408) },
        { type: "ok" },
      ]);
      const { queue, done } = runBatch(script.steps);

      queue.enqueue([file()]);
      await flush();
      for (const delay of [1000, 2000, 4000]) {
        jest.advanceTimersByTime(delay);
        await flush();
      }
      expect(done).toEqual([{ completed: [], failed: 1, cancelled: false }]);
      expect(script.finalizes).toEqual(
        Array.from({ length: 4 }, () => "upload-1"),
      );

      queue.retryFailed();
      await flush();

      expect(script.reservations).toEqual(["upload-1"]);
      expect(script.puts).toEqual(["upload-1"]);
      expect(script.finalizes).toEqual(
        Array.from({ length: 5 }, () => "upload-1"),
      );
      expect(script.aborts).toEqual([]);
      expect(done.at(-1)).toEqual({
        completed: ["entity-for-upload-1"],
        failed: 0,
        cancelled: false,
      });
    } finally {
      restoreRealTimers();
    }
  });

  test("a finalize the server is still settling resumes on the same upload when the user retries", async () => {
    const script = scriptedSteps([
      { type: "throw", error: httpError(409) },
      { type: "ok" },
    ]);
    const { queue, done } = runBatch(script.steps);

    queue.enqueue([file()]);
    await flush();
    expect(done.at(-1)).toMatchObject({ failed: 1 });

    queue.retryFailed();
    await flush();

    expect(script.reservations).toEqual(["upload-1"]);
    expect(script.finalizes).toEqual(["upload-1", "upload-1"]);
    expect(done.at(-1)).toEqual({
      completed: ["entity-for-upload-1"],
      failed: 0,
      cancelled: false,
    });
  });

  test("a finalize the server refused for good cannot be retried", async () => {
    const script = scriptedSteps([
      { type: "throw", error: httpError(422) },
      { type: "ok" },
    ]);
    const { queue, done } = runBatch(script.steps);

    queue.enqueue([file()]);
    await flush();
    queue.retryFailed();
    await flush();

    expect(script.reservations).toEqual(["upload-1"]);
    expect(script.finalizes).toEqual(["upload-1"]);
    expect(done.at(-1)).toMatchObject({ completed: [], failed: 1 });
  });

  test("cancelling during finalize releases the staged upload", async () => {
    const script = scriptedSteps([]);
    const { queue, uploader } = runBatch(script.steps);

    queue.enqueue([file()]);
    await flush();
    expect(script.finalizes).toEqual(["upload-1"]);

    queue.cancel();
    await uploader.abortStaged();
    await flush();

    expect(script.aborts).toEqual(["upload-1"]);
  });

  test.each([
    { status: 0, keeps: true },
    { status: 408, keeps: true },
    { status: 409, keeps: true },
    { status: 429, keeps: true },
    { status: 500, keeps: true },
    { status: 503, keeps: true },
    { status: 400, keeps: false },
    { status: 404, keeps: false },
    { status: 422, keeps: false },
  ])(
    "a finalize failure with status $status keeps the upload: $keeps",
    ({ status, keeps }) => {
      const error =
        status === 0 ? new TypeError("Failed to fetch") : httpError(status);
      expect(finalizeFailureKeepsUpload(error)).toBe(keeps);
    },
  );
});
