import { expect, test } from "bun:test";

import { defaultConfig, initialBatchState } from "@stll/db-load-gate/health";

import { createBackfillRuntime, decodeCheckpoint } from "./backfill-runtime";
import type { OnlineMigrationConnection } from "./online-migration-connection";

test.each([undefined, null, "unknown", {}, 4])(
  "an unrecognized checkpoint cause %p uses the legacy hold policy",
  (holdCause) => {
    const batch = { ...initialBatchState(defaultConfig), holdCause };
    expect(
      decodeCheckpoint({ cursor: "cursor", batch }).batch.holdCause,
    ).toBeNull();
    expect(
      decodeCheckpoint({ cursor: null, batch: { ...batch, heldSince: 10 } })
        .batch.holdCause,
    ).toBe("other");
  },
);

test.each([undefined, {}, 4, false])(
  "an invalid checkpoint cursor %p is rejected at the boundary",
  (cursor) => {
    expect(() =>
      decodeCheckpoint({ cursor, batch: initialBatchState(defaultConfig) }),
    ).toThrow("Invalid backfill checkpoint cursor");
  },
);

test.each(["load", "other"] as const)(
  "a recognized checkpoint cause %s is preserved",
  (holdCause) => {
    expect(
      decodeCheckpoint({
        cursor: "cursor",
        batch: {
          ...initialBatchState(defaultConfig),
          heldSince: 10,
          holdCause,
        },
      }),
    ).toMatchObject({
      cursor: "cursor",
      batch: { holdCause },
    });
  },
);

test.each([
  { size: 1, sleepMs: 1, expectedSize: 2, expectedSleepMs: 10 },
  { size: 20, sleepMs: 100, expectedSize: 10, expectedSleepMs: 20 },
])(
  "resuming size $size and sleep $sleepMs clamps the checkpoint before work",
  async ({ size, sleepMs, expectedSize, expectedSleepMs }) => {
    const config = {
      ...defaultConfig,
      minSize: 2,
      maxSize: 10,
      minSleepMs: 10,
      maxSleepMs: 20,
      busyWindows: [],
    };
    const records: unknown[] = [];
    let persisted: unknown;
    const checkpoint = {
      cursor: "resumed-cursor",
      batch: { ...initialBatchState(config), size, sleepMs },
    };
    const connection: OnlineMigrationConnection = {
      execute: async () => {},
      release: () => {},
      query: async (statement, parameters = []) => {
        if (statement.startsWith("SELECT cursor, batch")) {
          return [checkpoint];
        }
        if (statement.startsWith("UPDATE database_backfill_states")) {
          persisted = parameters.at(2);
        }
        return [{ acquired: true }];
      },
    };
    const runtime = createBackfillRuntime({
      connection,
      name: "resume-bounds",
      tableName: "rows",
      initialSize: 5,
      config,
      clock: () => 0,
      readVerdict: async () => ({ kind: "normal", signals: [] }),
      log: (record) => {
        records.push(record);
      },
    });
    try {
      const result = await runtime.step(async (batch) => {
        expect(batch.size).toBe(expectedSize);
        expect(batch.cursor).toBe("resumed-cursor");
        return { cursor: "next-cursor", done: false, value: batch.size };
      });
      expect(result.value).toBe(expectedSize);
      expect(result.cursor).toBe("next-cursor");
      expect(records).toContainEqual({
        action: "checkpoint_clamped",
        previous: { size, sleepMs },
        size: expectedSize,
        sleepMs: expectedSleepMs,
        config,
      });
      expect(typeof persisted).toBe("string");
      if (typeof persisted !== "string") {
        throw new TypeError("Expected a serialized persisted checkpoint");
      }
      expect(JSON.parse(persisted)).toMatchObject({
        size: expectedSize,
        sleepMs: config.minSleepMs,
      });
    } finally {
      await runtime.close();
    }
  },
);
