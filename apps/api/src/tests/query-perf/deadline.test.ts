import { expect, jest, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createQueryPerfDeadline } from "./deadline";
import { QUERY_PERF_OWNER_DEADLINES } from "./owner-deadlines";
import { SERVER_STATEMENT_TIMEOUT_MS } from "./plan-analyzer";

test("every measured owner deadline is within the server statement bound", () => {
  for (const deadlineMs of Object.values(QUERY_PERF_OWNER_DEADLINES)) {
    if (deadlineMs !== undefined) {
      expect(deadlineMs).toBeLessThanOrEqual(SERVER_STATEMENT_TIMEOUT_MS);
    }
  }
});

test("profile phases share a deadline and expired phases never start", async () => {
  let now = 0;
  const deadline = createQueryPerfDeadline({
    profileId: "small",
    timeoutMs: 100, // timeout under test
    now: () => now,
  });
  expect(
    await deadline.run("seed", async () => {
      now = 60;
      return "seeded";
    }),
  ).toBe("seeded");
  expect(
    await deadline.run("measure", async () => {
      now = 100;
      return "measured";
    }),
  ).toBe("measured");
  let started = false;
  expect(
    await rejectionOf(
      deadline.run("CREATE POLICY", async () => {
        started = true;
      }),
    ),
  ).toMatchObject({
    message: "query perf small: CREATE POLICY exceeded profile deadline 100ms",
  });
  expect(started).toBe(false);
});

test("a stalled phase rejects at the remaining profile deadline", async () => {
  jest.useFakeTimers();
  try {
    let now = 0;
    const deadline = createQueryPerfDeadline({
      profileId: "growth",
      timeoutMs: 100, // timeout under test
      now: () => now,
    });
    await deadline.run("seed", async () => {
      now = 60;
    });
    const pending = deadline.run(
      "measure document-search",
      async () => await new Promise<never>(() => {}),
    );
    const rejection = rejectionOf(pending);
    jest.advanceTimersByTime(40);
    expect(await rejection).toMatchObject({
      message: "query perf growth: measure document-search exceeded 40ms",
    });
  } finally {
    jest.useRealTimers();
  }
});
