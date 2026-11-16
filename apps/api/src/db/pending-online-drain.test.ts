import { describe, expect, test } from "bun:test";

import type { PendingOnlineUnitOutcome } from "./online-migrations";
import {
  drainPendingOnlineUnits,
  PENDING_ONLINE_HELD_RETRY_MS,
  PENDING_ONLINE_RETRY_MS,
  PENDING_ONLINE_YIELD_MS,
} from "./pending-online-drain";

const step = (name: string) =>
  ({
    kind: "repair",
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
  const skips: string[][] = [];
  const units = await drainPendingOnlineUnits({
    runUnit: async (skip) => {
      skips.push([...skip]);
      const next = queue.shift();
      if (next === undefined) {
        throw new TypeError("Drain ran past idle");
      }
      return await Promise.resolve(next);
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      await Promise.resolve();
    },
    emit: () => undefined,
  });
  return { units, sleeps, skips };
};

describe("pending online drain", () => {
  test("stops at idle", async () => {
    expect(await drain([{ type: "idle" }])).toEqual({
      units: 0,
      sleeps: [],
      skips: [[]],
    });
  });

  // A migrate run polls the lock every second; the pause outlasts a poll.
  test("pauses after every unit so a waiting migrate run takes the lock", async () => {
    const result = await drain([
      ran("a", COMPLETE),
      ran("b", COMPLETE),
      { type: "idle" },
    ]);
    expect(result.units).toBe(2);
    expect(result.sleeps).toEqual([
      PENDING_ONLINE_YIELD_MS,
      PENDING_ONLINE_YIELD_MS,
    ]);
  });

  test("waits out a migrate run that holds the online lock", async () => {
    const result = await drain([
      { type: "busy" },
      ran("a", COMPLETE),
      { type: "idle" },
    ]);
    expect(result.units).toBe(1);
    expect(result.sleeps).toEqual([
      PENDING_ONLINE_RETRY_MS,
      PENDING_ONLINE_YIELD_MS,
    ]);
  });

  test("waits a deferred build's delay", async () => {
    const result = await drain([
      ran("a", { type: "deferred", step: "a", retryAfterMs: 60_000 }),
      ran("a", COMPLETE),
      { type: "idle" },
    ]);
    expect(result.sleeps).toEqual([60_000, PENDING_ONLINE_YIELD_MS]);
  });

  test("sets a held repair aside, builds the rest, then retries it", async () => {
    const result = await drain([
      ran("a", { type: "held", reason: "database under pressure" }),
      ran("b", COMPLETE),
      { type: "idle" },
      ran("a", COMPLETE),
      { type: "idle" },
    ]);
    expect(result.units).toBe(3);
    expect(result.skips).toEqual([[], ["repair:a"], ["repair:a"], [], []]);
    expect(result.sleeps).toEqual([
      PENDING_ONLINE_YIELD_MS,
      PENDING_ONLINE_YIELD_MS,
      PENDING_ONLINE_HELD_RETRY_MS,
      PENDING_ONLINE_YIELD_MS,
    ]);
  });
});
