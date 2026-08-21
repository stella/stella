/**
 * A sweep that records the wrong thing is silent: a failed probe stored as
 * a total looks exactly like a publisher whose corpus shrank, and a sweep
 * that stops after one failure looks exactly like a corpus already fresh.
 * Both are pinned here, along with the gate that keeps a restart from
 * re-asking every publisher.
 *
 * Waits are sliced to stay interruptible, so assertions read the summed gap
 * between sweeps, never individual sleeps.
 */

import { describe, expect, test } from "bun:test";

import { SOURCE_TOTAL_ORIGIN } from "@/api/db/schema";
import type { SourceReportedTotal } from "@/api/handlers/case-law/ingestion/source-totals";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import type { SourceAdapter } from "@/api/lib/legal-search/ingestion-types";

import {
  type RecordSourceTotalOptions,
  type SourceTotalPollSummary,
  type SourceTotalPollTiming,
  runSourceTotalPoll,
} from "./source-total-poll";

const DAY_IN_MS = 24 * 60 * 60 * 1000;

const TIMING = {
  wakeIntervalMs: 4000,
  staleAfterMs: 6 * DAY_IN_MS,
  probeTimeoutMs: 1000,
} as const satisfies SourceTotalPollTiming;

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);

const adapter = (
  key: SourceAdapter["key"],
  getTotalCount: SourceAdapter["getTotalCount"] = async () => ({
    type: "no-count-endpoint",
  }),
): SourceAdapter => ({
  key,
  name: `${key} fixture`,
  country: "CZE",
  language: "cs",
  minRequestIntervalMs: 1000,
  fetchPage: () => {
    throw new Error("fetchPage is not exercised by the poll");
  },
  getTotalCount,
  reconciliation: {
    firstSlice: "1970-01-01",
    sliceOf: () => "1970-01-01",
    nextSlice: () => null,
    previousSlice: () => null,
    tipWindowDays: 1,
    listSlicePage: async () => {
      throw new Error("the totals poll must never list a source");
    },
    buildDecision: async () => {
      throw new Error("the totals poll must never build a decision");
    },
  },
});

const unmeasured = (adapterKey: SourceAdapter["key"]): SourceReportedTotal => ({
  adapterKey,
  reportedTotal: null,
  reportedTotalAsOf: null,
  reportedTotalOrigin: null,
});

const measuredAt = (
  adapterKey: SourceAdapter["key"],
  reportedTotalAsOf: Date,
): SourceReportedTotal => ({
  adapterKey,
  reportedTotal: 10,
  reportedTotalAsOf,
  reportedTotalOrigin: SOURCE_TOTAL_ORIGIN.ADAPTER_POLL,
});

type HarnessOptions = {
  adapters: readonly SourceAdapter[];
  readTotals?: () => Promise<readonly SourceReportedTotal[]>;
  recordTotal?: (options: RecordSourceTotalOptions) => Promise<boolean>;
  /** Sweeps to run before the harness drains. */
  sweeps: number;
  totals?: readonly SourceReportedTotal[];
};

type HarnessResult = {
  reports: SourceTotalPollSummary[];
  slept: number[];
  written: RecordSourceTotalOptions[];
};

/**
 * Run the loop for a fixed number of sweeps, then drain. The clock only
 * advances through the sleeps the loop itself asks for, so the drain lands
 * between sweeps rather than inside one, and the staleness gate sees
 * exactly the time the pacing produced.
 */
const runHarness = async ({
  adapters,
  readTotals,
  recordTotal,
  sweeps,
  totals = [],
}: HarnessOptions): Promise<HarnessResult> => {
  const reports: SourceTotalPollSummary[] = [];
  const slept: number[] = [];
  const written: RecordSourceTotalOptions[] = [];
  const drainAt = NOW + sweeps * TIMING.wakeIntervalMs;
  let clock = NOW;

  await runSourceTotalPoll({
    adapters,
    isDraining: () => clock >= drainAt,
    now: () => clock,
    readTotals: readTotals ?? (async () => totals),
    recordTotal:
      recordTotal ??
      (async (options) => {
        written.push(options);
        return true;
      }),
    report: (summary) => {
      reports.push(summary);
    },
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    timing: TIMING,
  });

  return { reports, slept, written };
};

describe("runSourceTotalPoll", () => {
  test("records what a publisher states, once, and stays quiet while it is fresh", async () => {
    const sweeps = 3;
    const { reports, slept, written } = await runHarness({
      adapters: [
        adapter(ADAPTER_KEYS.CZ_US, async () => ({
          type: "count",
          total: 8000,
        })),
      ],
      sweeps,
      totals: [unmeasured(ADAPTER_KEYS.CZ_US)],
    });

    // The read keeps answering "never measured", so only the ask gate stops
    // the later sweeps: one write across three wakes, not one per wake.
    expect(written).toEqual([
      {
        adapterKey: ADAPTER_KEYS.CZ_US,
        asOf: new Date(NOW),
        total: 8000,
      },
    ]);
    expect(reports).toEqual([
      {
        polled: 1,
        recorded: 1,
        noCount: 0,
        failed: 0,
        unknownSource: 0,
        lastErrorTag: undefined,
      },
    ]);
    // Sliced pacing: the gap between sweeps is the interval, not one sleep.
    expect(slept.reduce((sum, ms) => sum + ms, 0)).toBe(
      TIMING.wakeIntervalMs * sweeps,
    );
  });

  test("a source that answers nothing is not re-asked on the next wake", async () => {
    let probes = 0;
    const { reports, written } = await runHarness({
      adapters: [
        adapter(ADAPTER_KEYS.CZ_US, async () => {
          probes += 1;
          // A publisher that exposes no count: nothing is persisted, so only
          // the ask gate can stop the next wake re-probing it.
          return { type: "no-count-endpoint" };
        }),
      ],
      sweeps: 4,
      totals: [unmeasured(ADAPTER_KEYS.CZ_US)],
    });

    expect(probes).toBe(1);
    expect(written).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports.at(0)).toMatchObject({ polled: 1, noCount: 1 });
  });

  test("a fresh total asks nobody and reports nothing", async () => {
    const { reports, written } = await runHarness({
      adapters: [
        adapter(ADAPTER_KEYS.CZ_US, async () => ({
          type: "count",
          total: 8000,
        })),
      ],
      sweeps: 2,
      totals: [measuredAt(ADAPTER_KEYS.CZ_US, new Date(NOW - DAY_IN_MS))],
    });

    expect(written).toEqual([]);
    expect(reports).toEqual([]);
  });

  test("a probe that fails or states no count records nothing", async () => {
    const { reports, written } = await runHarness({
      adapters: [
        adapter(ADAPTER_KEYS.CZ_US, async () => {
          throw new Error("publisher unreachable");
        }),
        adapter(ADAPTER_KEYS.CZ_REGIONAL, async () => ({
          type: "no-count-endpoint",
        })),
      ],
      sweeps: 1,
      totals: [
        unmeasured(ADAPTER_KEYS.CZ_US),
        unmeasured(ADAPTER_KEYS.CZ_REGIONAL),
      ],
    });

    // The stored total is the last figure a publisher actually stated; a
    // failed probe is not evidence that it changed.
    expect(written).toEqual([]);
    expect(reports.at(0)).toMatchObject({
      polled: 2,
      recorded: 0,
      noCount: 1,
      failed: 1,
      unknownSource: 0,
    });
    expect(reports.at(0)?.lastErrorTag).toBe("Error");
  });

  test("one publisher's failure does not lose another's answer", async () => {
    const { reports, written } = await runHarness({
      adapters: [
        adapter(ADAPTER_KEYS.CZ_US, async () => {
          throw new Error("publisher unreachable");
        }),
        adapter(ADAPTER_KEYS.CZ_REGIONAL, async () => ({
          type: "count",
          total: 4321,
        })),
      ],
      sweeps: 1,
      totals: [
        unmeasured(ADAPTER_KEYS.CZ_US),
        unmeasured(ADAPTER_KEYS.CZ_REGIONAL),
      ],
    });

    expect(written.map(({ adapterKey }) => adapterKey)).toEqual([
      ADAPTER_KEYS.CZ_REGIONAL,
    ]);
    expect(reports.at(0)).toMatchObject({ recorded: 1, failed: 1 });
  });

  test("a write rejection is counted, not thrown, and the loop continues", async () => {
    const sweeps = 2;
    const { reports, slept } = await runHarness({
      adapters: [
        adapter(ADAPTER_KEYS.CZ_US, async () => ({
          type: "count",
          total: 8000,
        })),
      ],
      recordTotal: async () => {
        throw new TypeError("reported total must be a positive integer");
      },
      sweeps,
      totals: [unmeasured(ADAPTER_KEYS.CZ_US)],
    });

    expect(reports.at(0)).toMatchObject({ polled: 1, failed: 1, recorded: 0 });
    // The rejection reached the tally instead of the loop: it kept pacing
    // every wake rather than unwinding on the first bad write.
    expect(slept.reduce((sum, ms) => sum + ms, 0)).toBe(
      TIMING.wakeIntervalMs * sweeps,
    );
  });

  test("an adapter with no source row is counted as registry drift", async () => {
    const { reports } = await runHarness({
      adapters: [
        adapter(ADAPTER_KEYS.CZ_US, async () => ({
          type: "count",
          total: 8000,
        })),
      ],
      recordTotal: async () => false,
      sweeps: 1,
      totals: [unmeasured(ADAPTER_KEYS.CZ_US)],
    });

    expect(reports.at(0)).toMatchObject({
      polled: 1,
      recorded: 0,
      unknownSource: 1,
    });
  });

  test("a failed read is reported rather than read as a fresh corpus", async () => {
    let reads = 0;
    const { reports } = await runHarness({
      adapters: [
        adapter(ADAPTER_KEYS.CZ_US, async () => ({
          type: "count",
          total: 8000,
        })),
      ],
      readTotals: async () => {
        reads += 1;
        throw new Error("database unreachable");
      },
      sweeps: 1,
    });

    expect(reads).toBeGreaterThan(0);
    expect(reports.at(0)).toMatchObject({ polled: 0, failed: 0 });
    expect(reports.at(0)?.lastErrorTag).toBe("Error");
  });

  test("a draining process is not asked for a sweep", async () => {
    let reads = 0;

    await runSourceTotalPoll({
      adapters: [
        adapter(ADAPTER_KEYS.CZ_US, async () => ({
          type: "count",
          total: 8000,
        })),
      ],
      isDraining: () => true,
      now: () => NOW,
      readTotals: async () => {
        reads += 1;
        return [];
      },
      recordTotal: async () => true,
      report: () => undefined,
      sleep: async () => undefined,
      timing: TIMING,
    });

    expect(reads).toBe(0);
  });
});
