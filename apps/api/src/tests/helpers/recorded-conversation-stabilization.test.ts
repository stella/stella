import { expect, test } from "bun:test";

import { stabilizeRecordedConversation } from "./recorded-conversation-stabilization";

test("repeated timing observations retain identity across JSON and SSE", () => {
  const first = "2026-10-09T11:00:00.000Z";
  const second = "2026-10-09T11:00:01.000Z";
  expect(first).not.toBe(second);
  const normalized = stabilizeRecordedConversation({
    first: { observedAt: first },
    body: `data: ${JSON.stringify({ observedAt: first })}\n\ndata: ${JSON.stringify({ observedAt: second })}\n\n`,
    second: { observedAt: second },
  });
  expect(normalized).toBe(
    `${JSON.stringify(
      {
        first: { observedAt: "2026-01-01T00:00:01.000Z" },
        body: 'data: {"observedAt":"2026-01-01T00:00:01.000Z"}\n\ndata: {"observedAt":"2026-01-01T00:00:02.000Z"}\n\n',
        second: { observedAt: "2026-01-01T00:00:02.000Z" },
      },
      null,
      2,
    )}\n`,
  );
});

test("observation normalization is independent of source clocks and elapsed durations", () => {
  const recording = (observedAt: string, elapsedMs: number) => ({
    timing: {
      observedAt,
      elapsedMs,
      durationMs: elapsedMs,
      duration: elapsedMs,
    },
    body: `data: ${JSON.stringify({ observedAt, elapsedMs, durationMs: elapsedMs, duration: elapsedMs })}`,
  });
  const first = recording("2026-10-09T11:00:00.000Z", 123);
  const second = recording("2026-10-10T15:00:00.000Z", 456);
  expect(first).not.toEqual(second);
  expect(stabilizeRecordedConversation(first)).toBe(
    stabilizeRecordedConversation(second),
  );
  expect(stabilizeRecordedConversation(first)).toBe(
    `${JSON.stringify(
      {
        timing: {
          observedAt: "2026-01-01T00:00:01.000Z",
          elapsedMs: 0,
          durationMs: 0,
          duration: 0,
        },
        body: 'data: {"observedAt":"2026-01-01T00:00:01.000Z","elapsedMs":0,"durationMs":0,"duration":0}',
      },
      null,
      2,
    )}\n`,
  );
});

test("other instants retain occurrence normalization and generated ids retain identity", () => {
  const instant = "2026-10-09T11:00:00.000Z";
  const id = "12345678-1234-1234-1234-123456789abc";
  expect(
    stabilizeRecordedConversation({
      id,
      repeatedId: id,
      createdAt: instant,
      startedAt: instant,
      timestamp: Date.parse(instant),
      body: `data: ${JSON.stringify({ createdAt: instant, timestamp: Date.parse(instant) })}`,
    }),
  ).toBe(
    `${JSON.stringify(
      {
        id: "00000000-0000-7000-8000-000000000001",
        repeatedId: "00000000-0000-7000-8000-000000000001",
        createdAt: "2026-01-01T00:00:01.000Z",
        startedAt: "2026-01-01T00:00:02.000Z",
        timestamp: Date.UTC(2026, 0, 1, 0, 0, 4),
        body: `data: ${JSON.stringify({ createdAt: "2026-01-01T00:00:03.000Z", timestamp: Date.UTC(2026, 0, 1, 0, 0, 5) })}`,
      },
      null,
      2,
    )}\n`,
  );
});
