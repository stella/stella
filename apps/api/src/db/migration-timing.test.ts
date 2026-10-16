import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { timed } from "./migration-timing";
import type {
  MigrationTiming,
  MigrationTimingRecord,
} from "./migration-timing";

const step = {
  event: "migrate.online_step_duration",
  kind: "index",
  name: "probe_idx",
} as const;

const recordingTiming = (readings: number[]) => {
  const records: MigrationTimingRecord[] = [];
  const timing: MigrationTiming = {
    clock: () => {
      const reading = readings.shift();
      if (reading === undefined) {
        throw new Error("clock read more often than expected");
      }
      return reading;
    },
    emit: (record) => {
      records.push(record);
    },
  };
  return { records, timing };
};

describe("timed", () => {
  test("reports the duration with the outcome the result describes, and returns the result", async () => {
    const { records, timing } = recordingTiming([100, 1350.6]);
    const result = await timed({
      timing,
      work: async () => await Promise.resolve({ type: "deferred" as const }),
      describe: ({ type }) => ({ ...step, outcome: type }),
      failure: { ...step, outcome: "failed" },
    });
    expect(result).toEqual({ type: "deferred" });
    expect(records).toEqual([
      { ...step, outcome: "deferred", durationMs: 1251 },
    ]);
  });

  test("a failing step reports its duration as failed and rethrows the same error", async () => {
    const { records, timing } = recordingTiming([5, 905]);
    const failure = new Error("step failed");
    expect(
      await rejectionOf(
        timed({
          timing,
          work: async () => {
            await Promise.resolve();
            throw failure;
          },
          describe: () => ({ ...step, outcome: "complete" }),
          failure: { ...step, outcome: "failed" },
        }),
      ),
    ).toBe(failure);
    expect(records).toEqual([{ ...step, outcome: "failed", durationMs: 900 }]);
  });

  test("a clock that steps back never reports a negative duration", async () => {
    const { records, timing } = recordingTiming([500, 400]);
    await timed({
      timing,
      work: async () => await Promise.resolve(null),
      describe: () => ({ ...step, outcome: "complete" }),
      failure: { ...step, outcome: "failed" },
    });
    expect(records.at(0)?.durationMs).toBe(0);
  });
});
