import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";

import { BodyByteLimitError } from "@stll/fetch/body-reader";
import { rejectionOf } from "@stll/property-testing/rejection";
import { createTestClock } from "@stll/test-kit";

import { runWithQueryCounter } from "@/api/lib/db-query-counter";
import { runWithPublicReadScope } from "@/api/lib/legal-search/public-read-timeout-context";
import { currentReadWork } from "@/api/lib/observability/request-work";
import {
  OBJECT_READ_TIMEOUT_MS,
  readS3BytesBounded,
  S3ObjectBudgetError,
} from "@/api/lib/s3";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const testFetch = createTestFetch();

const trackedBody = (length: number) => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(length).fill(42));
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, pulls: () => pulls, wasCancelled: () => cancelled };
};

describe("bounded presigned document bodies", () => {
  test.each([undefined, "not-a-length", "-1", "8"])(
    "refuses unusable or excessive declared length %s before consuming bytes",
    async (length) => {
      const body = trackedBody(8);
      testFetch.set(
        asFetchMock(
          async () =>
            new Response(body.body, {
              headers: length === undefined ? {} : { "content-length": length },
            }),
        ),
      );
      const error = await rejectionOf(
        readS3BytesBounded({ key: "user-files/declared-length", maxBytes: 4 }),
      );
      if (length === "8") {
        expect(error).toBeInstanceOf(S3ObjectBudgetError);
      } else {
        expect(error).toMatchObject({ _tag: "S3ObjectReadError" });
      }
      expect(body.pulls()).toBe(0);
      expect(body.wasCancelled()).toBe(true);
    },
  );

  test("counts and cancels bytes beyond an understated length", async () => {
    const body = trackedBody(8);
    testFetch.set(
      asFetchMock(
        async () =>
          new Response(body.body, { headers: { "content-length": "4" } }),
      ),
    );
    expect(
      await rejectionOf(
        readS3BytesBounded({ key: "user-files/false-length", maxBytes: 4 }),
      ),
    ).toBeInstanceOf(BodyByteLimitError);
    expect(body.pulls()).toBe(1);
    expect(body.wasCancelled()).toBe(true);
  });

  test("returns exact-boundary bytes and meters them once", async () => {
    const body = trackedBody(4);
    testFetch.set(
      asFetchMock(
        async () =>
          new Response(body.body, { headers: { "content-length": "4" } }),
      ),
    );
    await runWithQueryCounter(async () => {
      expect(
        await readS3BytesBounded({
          key: "user-files/exact-length",
          maxBytes: 4,
        }),
      ).toEqual(new Uint8Array(4).fill(42));
      expect(currentReadWork()?.storageReadBytes).toBe(4);
    });
  });
});

test("the presigned total deadline remains active after response headers", async () => {
  const clock = createTestClock();
  const deadline = new AbortController();
  const originalTimeout = AbortSignal.timeout;
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    if (ms !== OBJECT_READ_TIMEOUT_MS) {
      return originalTimeout(ms);
    }
    void clock
      .sleep(ms)
      .then(() =>
        deadline.abort(new DOMException("Read timed out", "TimeoutError")),
      );
    return deadline.signal;
  });
  const started = Promise.withResolvers<undefined>();
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const state = { settled: false };
  testFetch.set(
    asFetchMock(
      async (_input, init) =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              start(controller) {
                bodyController = controller;
                // The fake transport mirrors fetch: its response body follows the request signal.
                init?.signal?.addEventListener(
                  "abort",
                  () => controller.error(init.signal?.reason),
                  { once: true },
                );
              },
              pull() {
                started.resolve(undefined);
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-length": "4" } },
        ),
    ),
  );
  const reading = Result.tryPromise(
    async () =>
      await readS3BytesBounded({ key: "user-files/stalled", maxBytes: 4 }),
  ).then((result) => {
    state.settled = true;
    return result;
  });
  try {
    await started.promise;
    await clock.advance(OBJECT_READ_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);
    await clock.advance(1);
    expect(state.settled).toBe(true);
    const result = await reading;
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.cause).toBe(deadline.signal.reason);
    }
  } finally {
    if (!state.settled) {
      bodyController?.close();
    }
    await reading;
    timeout.mockRestore();
  }
});

test("ambient cancellation settles and cancels a presigned response body", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<undefined>();
  const reason = new DOMException("Public request ended", "AbortError");
  const state = { cancelled: false };
  const clock = createTestClock();
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  testFetch.set(
    asFetchMock(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              start(stream) {
                bodyController = stream;
              },
              pull() {
                started.resolve(undefined);
              },
              cancel() {
                state.cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-length": "4" } },
        ),
    ),
  );
  const reading = runWithPublicReadScope(
    { budgetMs: 1000, signal: controller.signal },
    async () =>
      await readS3BytesBounded({ key: "user-files/scoped", maxBytes: 4 }),
  );
  try {
    await started.promise;
    controller.abort(reason);
    await clock.advance(0);
    expect(state.cancelled).toBe(true);
    const result = await reading;
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBe(reason);
    }
  } finally {
    if (!state.cancelled) {
      bodyController?.close();
    }
    await reading;
  }
});
