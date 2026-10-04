import { expect, mock, test } from "bun:test";

import { WEBHOOK_RETENTION_BATCH_SIZE } from "@/api/lib/hosted-usage-provider/webhook-retention";

import { drainWebhookEvents } from "./hosted-usage-webhook-retention";

test("unset retention performs no redaction or continuation", async () => {
  const redact = mock(async () => 0);
  const scheduleContinuation = mock((_at: Date) => {});
  await drainWebhookEvents({
    signal: new AbortController().signal,
    retentionDays: undefined,
    redact,
    scheduleContinuation,
  });
  expect(redact).not.toHaveBeenCalled();
  expect(scheduleContinuation).not.toHaveBeenCalled();
});

test("saturated redaction is bounded and durably continues", async () => {
  const redact = mock(async (_days: number) => WEBHOOK_RETENTION_BATCH_SIZE);
  const scheduleContinuation = mock((_at: Date) => {});
  const before = Date.now();
  await drainWebhookEvents({
    signal: new AbortController().signal,
    retentionDays: 17,
    redact,
    scheduleContinuation,
  });
  expect(redact).toHaveBeenCalledTimes(16);
  expect(redact).toHaveBeenCalledWith(17);
  expect(scheduleContinuation).toHaveBeenCalledTimes(1);
  const nextRunAt = scheduleContinuation.mock.calls.at(0)?.at(0);
  expect(nextRunAt?.getTime()).toBeGreaterThanOrEqual(before);
  expect(nextRunAt?.getTime()).toBeLessThanOrEqual(Date.now());
});

test("drained or cancelled redaction schedules no continuation", async () => {
  const redact = mock(async () => WEBHOOK_RETENTION_BATCH_SIZE - 1);
  const scheduleContinuation = mock((_at: Date) => {});
  await drainWebhookEvents({
    signal: new AbortController().signal,
    retentionDays: 17,
    redact,
    scheduleContinuation,
  });
  const controller = new AbortController();
  controller.abort();
  await drainWebhookEvents({
    signal: controller.signal,
    retentionDays: 17,
    redact,
    scheduleContinuation,
  });
  expect(redact).toHaveBeenCalledTimes(1);
  expect(scheduleContinuation).not.toHaveBeenCalled();
});

test("cancellation during redaction stops the bounded drain", async () => {
  const controller = new AbortController();
  const redact = mock(async () => {
    controller.abort();
    return WEBHOOK_RETENTION_BATCH_SIZE;
  });
  const scheduleContinuation = mock((_at: Date) => {});
  await drainWebhookEvents({
    signal: controller.signal,
    retentionDays: 17,
    redact,
    scheduleContinuation,
  });
  expect(redact).toHaveBeenCalledTimes(1);
  expect(scheduleContinuation).not.toHaveBeenCalled();
});
