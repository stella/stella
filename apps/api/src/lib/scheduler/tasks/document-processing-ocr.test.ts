import { expect, mock, test } from "bun:test";

import {
  dispatchDocumentOcrBatches,
  nextDocumentOcrDispatchAt,
} from "@/api/lib/scheduler/tasks/document-processing-ocr";

test("drains queued OCR in bounded batches", async () => {
  const batchSizes = [100, 100, 17];
  const dispatch = mock(async ({ limit }: { limit?: number } = {}) => {
    expect(limit).toBe(100);
    const attempted = batchSizes.shift() ?? 0;
    return { attempted, hasMore: attempted === limit, retryAt: null };
  });

  const result = await dispatchDocumentOcrBatches({
    dispatch,
    signal: new AbortController().signal,
  });

  expect(result).toEqual({
    dispatched: 217,
    reachedLimit: false,
    retryAt: null,
  });
  expect(dispatch).toHaveBeenCalledTimes(3);
});

test("does not dispatch after scheduler cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const dispatch = mock(async () => ({
    attempted: 0,
    hasMore: false,
    retryAt: null,
  }));

  const result = await dispatchDocumentOcrBatches({
    dispatch,
    signal: controller.signal,
  });

  expect(result).toEqual({
    dispatched: 0,
    reachedLimit: false,
    retryAt: null,
  });
  expect(dispatch).not.toHaveBeenCalled();
});

test("caps each scheduler tick at ten thousand OCR runs", async () => {
  const dispatch = mock(async () => ({
    attempted: 100,
    hasMore: true,
    retryAt: null,
  }));

  const result = await dispatchDocumentOcrBatches({
    dispatch,
    signal: new AbortController().signal,
  });

  expect(result).toEqual({
    dispatched: 10_000,
    reachedLimit: true,
    retryAt: null,
  });
  expect(dispatch).toHaveBeenCalledTimes(100);
});

test("preserves the earliest failed handoff retry across batches", async () => {
  const laterRetry = new Date("2030-01-01T00:01:00.000Z");
  const earlierRetry = new Date("2030-01-01T00:00:30.000Z");
  const batches = [
    { attempted: 100, hasMore: true, retryAt: laterRetry },
    { attempted: 17, hasMore: false, retryAt: earlierRetry },
  ];

  const result = await dispatchDocumentOcrBatches({
    dispatch: mock(
      async () =>
        batches.shift() ?? { attempted: 0, hasMore: false, retryAt: null },
    ),
    signal: new AbortController().signal,
  });

  expect(result).toEqual({
    dispatched: 117,
    reachedLimit: false,
    retryAt: earlierRetry,
  });
});

test("continues at a failed handoff retry before the configured interval", () => {
  const now = new Date("2030-01-01T00:00:00.000Z");
  const retryAt = new Date("2030-01-01T00:00:30.000Z");

  expect(
    nextDocumentOcrDispatchAt({ now, reachedLimit: false, retryAt }),
  ).toEqual(retryAt);
  expect(
    nextDocumentOcrDispatchAt({ now, reachedLimit: true, retryAt }),
  ).toEqual(retryAt);
  expect(
    nextDocumentOcrDispatchAt({ now, reachedLimit: false, retryAt: null }),
  ).toBeUndefined();
});
