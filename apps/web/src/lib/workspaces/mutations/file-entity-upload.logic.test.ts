import { describe, expect, jest, test } from "bun:test";

import { UploadQueue } from "@/lib/upload-queue";
import {
  createFileEntityUploader,
  finalizeFailureKeepsUpload,
  type FileEntityUploadGrant,
} from "@/lib/workspaces/mutations/file-entity-upload.logic";

// The queue's retry chains span several awaits; pump enough microtasks.
const flush = async (ticks = 60) => {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
};

const httpError = (status: number): Error & { status: number } =>
  Object.assign(new Error(`HTTP ${status}`), { status });

type FinalizeOutcome = { type: "ok" } | { type: "throw"; error: Error };

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
  const queue = new UploadQueue<string>(uploader.upload, 1);
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
  test("a finalize transport failure is retried on the same uploadId and never re-presigned", async () => {
    jest.useFakeTimers();
    try {
      const script = scriptedSteps([
        { type: "throw", error: new TypeError("Failed to fetch") },
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
      jest.useRealTimers();
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

  test("a finalize the server refused for good starts a fresh upload on retry", async () => {
    const script = scriptedSteps([
      { type: "throw", error: httpError(422) },
      { type: "ok" },
    ]);
    const { queue, done } = runBatch(script.steps);

    queue.enqueue([file()]);
    await flush();
    queue.retryFailed();
    await flush();

    expect(script.reservations).toEqual(["upload-1", "upload-2"]);
    expect(script.finalizes).toEqual(["upload-1", "upload-2"]);
    expect(done.at(-1)).toMatchObject({ completed: ["entity-for-upload-2"] });
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
