import { expect, mock, test } from "bun:test";

import { dispatchDocumentOcrBatches } from "@/api/lib/scheduler/tasks/document-processing-ocr";

test("drains queued OCR in bounded batches", async () => {
  const batchSizes = [100, 100, 17];
  const dispatch = mock(async ({ limit }: { limit?: number } = {}) => {
    expect(limit).toBe(100);
    return batchSizes.shift() ?? 0;
  });

  const dispatched = await dispatchDocumentOcrBatches({
    dispatch,
    signal: new AbortController().signal,
  });

  expect(dispatched).toBe(217);
  expect(dispatch).toHaveBeenCalledTimes(3);
});

test("does not dispatch after scheduler cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const dispatch = mock(async () => 0);

  const dispatched = await dispatchDocumentOcrBatches({
    dispatch,
    signal: controller.signal,
  });

  expect(dispatched).toBe(0);
  expect(dispatch).not.toHaveBeenCalled();
});

test("caps each scheduler tick at ten thousand OCR runs", async () => {
  const dispatch = mock(async () => 100);

  const dispatched = await dispatchDocumentOcrBatches({
    dispatch,
    signal: new AbortController().signal,
  });

  expect(dispatched).toBe(10_000);
  expect(dispatch).toHaveBeenCalledTimes(100);
});
