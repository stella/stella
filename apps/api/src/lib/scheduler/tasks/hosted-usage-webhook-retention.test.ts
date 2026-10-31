import { expect, mock, test } from "bun:test";

import { WEBHOOK_RETENTION_BATCH_SIZE } from "@/api/lib/hosted-usage-provider/webhook-retention";

import { drainWebhookEvents } from "./hosted-usage-webhook-retention";

test("unset retention performs no redaction or continuation", async () => {
  const redact = mock(async () => 0);
  const hasMore = await drainWebhookEvents({
    signal: new AbortController().signal,
    retentionDays: undefined,
    redact,
  });
  expect(redact).not.toHaveBeenCalled();
  expect(hasMore).toBe(false);
});

test("saturated redaction is bounded and durably continues", async () => {
  const redact = mock(async (_days: number) => WEBHOOK_RETENTION_BATCH_SIZE);
  const hasMore = await drainWebhookEvents({
    signal: new AbortController().signal,
    retentionDays: 17,
    redact,
  });
  expect(redact).toHaveBeenCalledTimes(16);
  expect(redact).toHaveBeenCalledWith(17);
  expect(hasMore).toBe(true);
});

test("drained or cancelled redaction schedules no continuation", async () => {
  const redact = mock(async () => WEBHOOK_RETENTION_BATCH_SIZE - 1);
  const drainedHasMore = await drainWebhookEvents({
    signal: new AbortController().signal,
    retentionDays: 17,
    redact,
  });
  const controller = new AbortController();
  controller.abort();
  const cancelledHasMore = await drainWebhookEvents({
    signal: controller.signal,
    retentionDays: 17,
    redact,
  });
  expect(redact).toHaveBeenCalledTimes(1);
  expect(drainedHasMore).toBe(false);
  expect(cancelledHasMore).toBe(false);
});

test("cancellation during redaction stops the bounded drain", async () => {
  const controller = new AbortController();
  const redact = mock(async () => {
    controller.abort();
    return WEBHOOK_RETENTION_BATCH_SIZE;
  });
  const hasMore = await drainWebhookEvents({
    signal: controller.signal,
    retentionDays: 17,
    redact,
  });
  expect(redact).toHaveBeenCalledTimes(1);
  expect(hasMore).toBe(false);
});
