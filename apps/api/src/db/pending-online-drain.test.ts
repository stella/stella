import { describe, expect, test } from "bun:test";

import type { PendingOnlineUnitOutcome } from "./online-migrations";
import {
  drainPendingOnlineUnits,
  PENDING_ONLINE_RETRY_MS,
} from "./pending-online-drain";

const step = (name: string) =>
  ({
    kind: "index",
    name,
    introducedBy: "20261115000000_fixture",
  }) as const;

const COMPLETE = { type: "complete" } as const;

const ran = (
  name: string,
  outcome: Extract<PendingOnlineUnitOutcome, { type: "ran" }>["outcome"],
): PendingOnlineUnitOutcome => ({ type: "ran", step: step(name), outcome });

const drain = async (outcomes: readonly PendingOnlineUnitOutcome[]) => {
  const queue = [...outcomes];
  const sleeps: number[] = [];
  const emitted: PendingOnlineUnitOutcome[] = [];
  const units = await drainPendingOnlineUnits({
    runUnit: async () =>
      await Promise.resolve(
        queue.shift() ??
          (() => {
            throw new TypeError("Drain ran past idle");
          })(),
      ),
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      await Promise.resolve();
    },
    emit: (outcome) => {
      emitted.push(outcome);
    },
  });
  return { units, sleeps, emitted, left: queue.length };
};

describe("pending online drain", () => {
  test("stops at idle", async () => {
    expect(await drain([{ type: "idle" }])).toEqual({
      units: 0,
      sleeps: [],
      emitted: [{ type: "idle" }],
      left: 0,
    });
  });

  test("walks distinct units back to back", async () => {
    const result = await drain([
      ran("a", COMPLETE),
      ran("b", COMPLETE),
      { type: "idle" },
    ]);
    expect(result.units).toBe(2);
    expect(result.sleeps).toEqual([]);
  });

  test("waits out a migrate run that holds the online lock", async () => {
    const result = await drain([
      { type: "busy" },
      { type: "busy" },
      ran("a", COMPLETE),
      { type: "idle" },
    ]);
    expect(result.units).toBe(1);
    expect(result.sleeps).toEqual([
      PENDING_ONLINE_RETRY_MS,
      PENDING_ONLINE_RETRY_MS,
    ]);
  });

  test("waits a deferred build's delay and pauses before repeating a unit", async () => {
    const result = await drain([
      ran("a", { type: "deferred", step: "a", retryAfterMs: 60_000 }),
      ran("a", COMPLETE),
      ran("a", COMPLETE),
      { type: "idle" },
    ]);
    expect(result.units).toBe(3);
    expect(result.sleeps).toEqual([
      60_000,
      PENDING_ONLINE_RETRY_MS,
      PENDING_ONLINE_RETRY_MS,
    ]);
  });
});
