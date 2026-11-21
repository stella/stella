import { expect, test } from "bun:test";

import {
  DOCUMENT_PROCESSING_MAX_ATTEMPTS,
  documentProcessingRetryDelayMs,
  documentProcessingSleepMs,
  shouldRetryDocumentProcessing,
} from "@/api/lib/document-processing-retry";

test("document processing retries stop at the attempt bound", () => {
  for (let attemptCount = 0; attemptCount < 100; attemptCount += 1) {
    expect(shouldRetryDocumentProcessing(attemptCount, true)).toBe(
      attemptCount < DOCUMENT_PROCESSING_MAX_ATTEMPTS,
    );
  }
  expect(
    shouldRetryDocumentProcessing(DOCUMENT_PROCESSING_MAX_ATTEMPTS - 1, false),
  ).toBe(false);
});

test("document processing retry delays grow monotonically and stop at the cap", () => {
  const delays = Array.from({ length: 100 }, (_, index) =>
    documentProcessingRetryDelayMs(index + 1),
  );
  expect(delays.at(0)).toBe(30_000);
  expect(delays.at(1)).toBe(60_000);
  expect(delays.at(2)).toBe(120_000);
  for (const [index, delay] of delays.entries()) {
    expect(delay).toBeGreaterThanOrEqual(30_000);
    expect(delay).toBeLessThanOrEqual(30 * 60_000);
    const previous = delays.at(index - 1);
    if (index > 0 && previous !== undefined) {
      expect(delay).toBeGreaterThanOrEqual(previous);
    }
  }
  expect(delays.at(-1)).toBe(30 * 60_000);
  expect(documentProcessingRetryDelayMs(Number.MAX_SAFE_INTEGER)).toBe(
    30 * 60_000,
  );
});

test("the idle worker sleeps until the earliest retry within its polling bounds", () => {
  const now = new Date("2030-01-01T00:00:00.000Z");
  expect(documentProcessingSleepMs(new Date(now.getTime() + 12_000), now)).toBe(
    12_000,
  );
  expect(documentProcessingSleepMs(new Date(now.getTime() + 60_000), now)).toBe(
    30_000,
  );
  expect(documentProcessingSleepMs(new Date(now.getTime() - 1000), now)).toBe(
    1000,
  );
  expect(documentProcessingSleepMs(null, now)).toBe(30_000);
});
