import { expect, mock, test } from "bun:test";

import { REQUEST_RECEIPT_RETENTION_BATCH_SIZE } from "@/api/lib/idempotency/request-receipts";

import { drainRequestReceipts } from "./request-receipt-retention";

test("receipt retention stops at the batch budget and schedules continuation", async () => {
  const sweep = mock(async () => ({
    deleted: REQUEST_RECEIPT_RETENTION_BATCH_SIZE,
    hasMore: true,
  }));
  const scheduleContinuation = mock(() => {});
  const deleted = await drainRequestReceipts({
    paused: false,
    signal: new AbortController().signal,
    sweep,
    now: () => 0,
    scheduleContinuation,
  });
  expect(sweep).toHaveBeenCalledTimes(4);
  expect(deleted).toBe(4 * REQUEST_RECEIPT_RETENTION_BATCH_SIZE);
  expect(scheduleContinuation).toHaveBeenCalledTimes(1);
});

test("receipt retention observes its time budget between batches", async () => {
  let now = 0;
  const sweep = mock(async () => {
    now += 30_000;
    return { deleted: REQUEST_RECEIPT_RETENTION_BATCH_SIZE, hasMore: true };
  });
  const scheduleContinuation = mock(() => {});
  await drainRequestReceipts({
    paused: false,
    signal: new AbortController().signal,
    sweep,
    now: () => now,
    scheduleContinuation,
  });
  expect(sweep).toHaveBeenCalledTimes(1);
  expect(scheduleContinuation).toHaveBeenCalledTimes(1);
});

test("paused, drained, and cancelled receipt retention does not continue", async () => {
  const controller = new AbortController();
  const sweep = mock(async () => ({ deleted: 0, hasMore: false }));
  const scheduleContinuation = mock(() => {});
  const options = {
    paused: false,
    signal: controller.signal,
    sweep,
    now: () => 0,
    scheduleContinuation,
  };
  await drainRequestReceipts({ ...options, paused: true });
  expect(sweep).not.toHaveBeenCalled();
  await drainRequestReceipts(options);
  expect(sweep).toHaveBeenCalledTimes(1);
  controller.abort();
  await drainRequestReceipts(options);
  expect(sweep).toHaveBeenCalledTimes(1);
  expect(scheduleContinuation).not.toHaveBeenCalled();
});

test("cancelling a saturated batch prevents the next batch and continuation", async () => {
  const controller = new AbortController();
  const sweep = mock(async () => {
    controller.abort();
    return { deleted: REQUEST_RECEIPT_RETENTION_BATCH_SIZE, hasMore: true };
  });
  const scheduleContinuation = mock(() => {});
  await drainRequestReceipts({
    paused: false,
    signal: controller.signal,
    sweep,
    now: () => 0,
    scheduleContinuation,
  });
  expect(sweep).toHaveBeenCalledTimes(1);
  expect(scheduleContinuation).not.toHaveBeenCalled();
});

test("a partial receipt sweep continues even below the batch row limit", async () => {
  let now = 0;
  const sweep = mock(async (deadline: number) => {
    expect(deadline).toBe(30_000);
    now = deadline;
    return { deleted: 1, hasMore: true };
  });
  const scheduleContinuation = mock(() => {});
  expect(
    await drainRequestReceipts({
      paused: false,
      signal: new AbortController().signal,
      sweep,
      now: () => now,
      scheduleContinuation,
    }),
  ).toBe(1);
  expect(sweep).toHaveBeenCalledTimes(1);
  expect(scheduleContinuation).toHaveBeenCalledTimes(1);
});
