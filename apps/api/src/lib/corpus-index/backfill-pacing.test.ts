import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  BACKFILL_PACING_STATE,
  type BackfillPacingState,
  BackpressureSampleError,
  type BackpressureConfig,
  createBackfillPacer,
  nextPacingState,
  parseBackpressureDimensions,
  resolveBackpressureConfig,
} from "@/api/lib/corpus-index/backfill-pacing";
import type { LoggerAttributes } from "@/api/lib/observability/logger";

const WATERMARKS = { lowWatermark: 30, highWatermark: 50 };

describe("parseBackpressureDimensions", () => {
  test("absent or empty spec yields no dimensions", () => {
    expect(parseBackpressureDimensions(undefined)).toEqual([]);
    expect(parseBackpressureDimensions("")).toEqual([]);
  });

  test("parses Name=Value pairs in order", () => {
    expect(parseBackpressureDimensions("Role=writer,Tier=storage")).toEqual([
      { name: "Role", value: "writer" },
      { name: "Tier", value: "storage" },
    ]);
  });

  test("panics on a pair without a value", () => {
    expect(() => parseBackpressureDimensions("Role=")).toThrow(
      "Malformed backpressure dimension",
    );
    expect(() => parseBackpressureDimensions("=writer")).toThrow(
      "Malformed backpressure dimension",
    );
  });
});

describe("resolveBackpressureConfig", () => {
  const base = {
    CORPUS_INDEX_BACKPRESSURE_LOW_WATERMARK: 30,
    CORPUS_INDEX_BACKPRESSURE_HIGH_WATERMARK: 50,
    CORPUS_INDEX_BACKPRESSURE_SAMPLE_INTERVAL_MS: 60_000,
  };

  test("absent metric and namespace disable pacing", () => {
    expect(resolveBackpressureConfig(base)).toBeNull();
  });

  test("full group resolves to a config", () => {
    expect(
      resolveBackpressureConfig({
        ...base,
        CORPUS_INDEX_BACKPRESSURE_METRIC: "FreeStorageSpace",
        CORPUS_INDEX_BACKPRESSURE_NAMESPACE: "AWS/RDS",
        CORPUS_INDEX_BACKPRESSURE_DIMENSIONS: "Role=writer",
      }),
    ).toEqual({
      metric: "FreeStorageSpace",
      namespace: "AWS/RDS",
      dimensions: [{ name: "Role", value: "writer" }],
      lowWatermark: 30,
      highWatermark: 50,
      sampleIntervalMs: 60_000,
    });
  });

  test("half-configured group panics", () => {
    expect(() =>
      resolveBackpressureConfig({
        ...base,
        CORPUS_INDEX_BACKPRESSURE_METRIC: "FreeStorageSpace",
      }),
    ).toThrow("must be configured together");
  });
});

describe("nextPacingState", () => {
  const states: BackfillPacingState[] = [
    BACKFILL_PACING_STATE.paused,
    BACKFILL_PACING_STATE.running,
  ];

  test("below the low watermark is always paused", () => {
    for (const current of states) {
      expect(
        nextPacingState({ current, sample: 29.9, watermarks: WATERMARKS }),
      ).toBe(BACKFILL_PACING_STATE.paused);
    }
  });

  test("above the high watermark is always running", () => {
    for (const current of states) {
      expect(
        nextPacingState({ current, sample: 50.1, watermarks: WATERMARKS }),
      ).toBe(BACKFILL_PACING_STATE.running);
    }
  });

  test("the band between watermarks keeps the current state", () => {
    // Both boundaries are inside the band: pausing needs strictly below
    // low, resuming strictly above high.
    for (const sample of [30, 40, 50]) {
      for (const current of states) {
        expect(
          nextPacingState({ current, sample, watermarks: WATERMARKS }),
        ).toBe(current);
      }
    }
  });
});

type LogEvent = {
  level: "info" | "warn";
  message: string;
  attributes: LoggerAttributes;
};

const createHarness = ({
  samples,
  sampleIntervalMs = 1000,
  heartbeatIntervalMs = 60_000,
}: {
  samples: Result<number | null, BackpressureSampleError>[];
  sampleIntervalMs?: number;
  heartbeatIntervalMs?: number;
}) => {
  let clock = 0;
  const sampleTimes: number[] = [];
  const sleeps: number[] = [];
  const events: LogEvent[] = [];
  const config: BackpressureConfig = {
    metric: "FreeStorageSpace",
    namespace: "AWS/RDS",
    dimensions: [],
    lowWatermark: 30,
    highWatermark: 50,
    sampleIntervalMs,
  };
  const pacer = createBackfillPacer({
    generation: "case_law_v2",
    backpressure: {
      config,
      sample: async () => {
        sampleTimes.push(clock);
        return samples.shift() ?? Result.ok(null);
      },
    },
    heartbeatIntervalMs,
    log: {
      info: (message, attributes) => {
        events.push({ level: "info", message, attributes: attributes ?? {} });
      },
      warn: (message, attributes) => {
        events.push({ level: "warn", message, attributes: attributes ?? {} });
      },
    },
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return {
    pacer,
    advance: (ms: number) => {
      clock += ms;
    },
    events,
    heartbeats: () =>
      events.filter(
        (event) => event.message === "case_law.corpus_index.backfill_heartbeat",
      ),
    sampleTimes,
    sleeps,
  };
};

describe("createBackfillPacer", () => {
  test("pauses below the low watermark and resumes above the high one", async () => {
    const harness = createHarness({
      samples: [Result.ok(20), Result.ok(40), Result.ok(60)],
    });
    await harness.pacer.beforeBatch();
    // One pause for the low sample, one for the in-band sample.
    expect(harness.sleeps).toEqual([1000, 1000]);
    const messages = harness.events.map((event) => event.message);
    expect(messages).toContain("case_law.corpus_index.backfill_paused");
    expect(messages).toContain("case_law.corpus_index.backfill_resumed");
  });

  test("samples at most once per interval", async () => {
    const harness = createHarness({
      samples: [Result.ok(60), Result.ok(60)],
    });
    await harness.pacer.beforeBatch();
    await harness.pacer.beforeBatch();
    expect(harness.sampleTimes).toEqual([0]);
    harness.advance(1000);
    await harness.pacer.beforeBatch();
    expect(harness.sampleTimes).toEqual([0, 1000]);
  });

  test("a failed sample keeps the loop running", async () => {
    const harness = createHarness({
      samples: [
        Result.err(new BackpressureSampleError({ message: "unreachable" })),
      ],
    });
    await harness.pacer.beforeBatch();
    expect(harness.sleeps).toEqual([]);
    expect(
      harness.events.some(
        (event) =>
          event.message === "case_law.corpus_index.backpressure_sample_failed",
      ),
    ).toBe(true);
  });

  test("a failed sample while paused stays paused until a good sample recovers", async () => {
    const harness = createHarness({
      samples: [
        Result.ok(10),
        Result.err(new BackpressureSampleError({ message: "unreachable" })),
        Result.ok(60),
      ],
    });
    await harness.pacer.beforeBatch();
    expect(harness.sleeps).toEqual([1000, 1000]);
  });

  test("heartbeats keep their cadence through a pause longer than the sample interval", async () => {
    const harness = createHarness({
      // Pause immediately; recover on the second real sample.
      samples: [Result.ok(10), Result.ok(60)],
      sampleIntervalMs: 300_000,
      heartbeatIntervalMs: 60_000,
    });
    await harness.pacer.beforeBatch();
    // The paused wait is split at heartbeat boundaries: five 60s sleeps
    // reach the 300s sample interval, and each iteration heartbeats.
    expect(harness.sleeps).toEqual([60_000, 60_000, 60_000, 60_000, 60_000]);
    const paused = harness
      .heartbeats()
      .filter(
        (event) => event.attributes["state"] === BACKFILL_PACING_STATE.paused,
      );
    expect(paused.length).toBeGreaterThanOrEqual(4);
  });

  test("a sample without datapoints keeps the current state", async () => {
    const harness = createHarness({
      samples: [Result.ok(null)],
    });
    await harness.pacer.beforeBatch();
    expect(harness.sleeps).toEqual([]);
  });

  test("heartbeat carries totals and window rate at the configured cadence", async () => {
    const harness = createHarness({
      samples: [Result.ok(null)],
      heartbeatIntervalMs: 60_000,
      sampleIntervalMs: 3_600_000,
    });
    // First beforeBatch emits the liveness heartbeat immediately.
    await harness.pacer.beforeBatch();
    expect(harness.heartbeats()).toHaveLength(1);

    harness.pacer.recordBatch(50);
    harness.pacer.recordBatch(70);
    await harness.pacer.beforeBatch();
    // Within the cadence: no second heartbeat yet.
    expect(harness.heartbeats()).toHaveLength(1);

    harness.advance(60_000);
    await harness.pacer.beforeBatch();
    const second = harness.heartbeats().at(1);
    expect(second?.attributes).toMatchObject({
      generation: "case_law_v2",
      state: BACKFILL_PACING_STATE.running,
      totalIndexed: 120,
      batches: 2,
      windowIndexed: 120,
      docsPerSecond: 2,
      backpressureConfigured: true,
    });

    // The window resets after each heartbeat; finish reports the rest.
    harness.pacer.recordBatch(30);
    harness.advance(10_000);
    harness.pacer.finish();
    const last = harness.heartbeats().at(-1);
    expect(last?.attributes).toMatchObject({
      totalIndexed: 150,
      windowIndexed: 30,
      docsPerSecond: 3,
    });
  });

  test("unconfigured backpressure only heartbeats", async () => {
    const events: LogEvent[] = [];
    const pacer = createBackfillPacer({
      generation: "case_law_v2",
      backpressure: null,
      log: {
        info: (message, attributes) => {
          events.push({ level: "info", message, attributes: attributes ?? {} });
        },
        warn: (message, attributes) => {
          events.push({ level: "warn", message, attributes: attributes ?? {} });
        },
      },
      now: () => 0,
      sleep: async () => {},
    });
    await pacer.beforeBatch();
    expect(events.map((event) => event.message)).toEqual([
      "case_law.corpus_index.backfill_heartbeat",
    ]);
    expect(events.at(0)?.attributes).toMatchObject({
      backpressureConfigured: false,
    });
  });
});
