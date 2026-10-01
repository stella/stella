import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import {
  combine,
  decideStart,
  decideWhileRunning,
  defaultConfig,
  initialBatchState,
  isHeldTooLong,
  nextBatch,
  type BatchState,
  type Signal,
  type HealthSignalKind,
  validateConfig,
} from "./health";

const classifyReading = (value: number | null): HealthSignalKind => {
  if (value === null) {
    return "unknown";
  }
  if (value < 40) {
    return "stop";
  }
  if (value < 70) {
    return "degraded";
  }
  return "normal";
};
const reading = (
  value: number | null,
  kind: HealthSignalKind = classifyReading(value),
): Signal => ({
  indicator: "ebs_balance",
  kind,
  value,
  threshold: 40,
  observedAt: value === null ? null : "2026-01-01T00:00:00.000Z",
  reason: "test reading",
});
const valueByKind = {
  normal: 100,
  degraded: 50,
  stop: 10,
  unknown: null,
  not_configured: null,
} as const satisfies Record<HealthSignalKind, number | null>;
const verdict = (kind: HealthSignalKind) =>
  combine([reading(valueByKind[kind], kind)]);
const state = (): BatchState => ({
  ...initialBatchState(),
  size: 1000,
  sleepMs: 1000,
});
const clock = () => 100_000;
const advance = (kind: HealthSignalKind, duration: number | null = 1000) =>
  nextBatch({
    state: state(),
    verdict: verdict(kind),
    lastDurationMs: duration,
    clock,
  });
const kinds = ["normal", "degraded", "unknown", "stop"] as const;

// Every decision is a record the caller can log without losing metric numbers.
const expectLogged = (
  record:
    | ReturnType<typeof decideStart>
    | ReturnType<typeof decideWhileRunning>
    | ReturnType<typeof nextBatch>,
) => {
  expect(record.config.hardFloor).toBeNumber();
  expect(record.config.startFloor).toBeNumber();
  for (const signal of record.verdict.signals) {
    expect(signal).toHaveProperty("value");
    expect(signal).toHaveProperty("threshold");
    expect(signal).toHaveProperty("observedAt");
    expect(signal.reason.length).toBeGreaterThan(0);
  }
  const serialized = JSON.stringify(record);
  expect(JSON.parse(serialized)).toEqual(record);
};

describe("fail-closed start decisions", () => {
  test("empty indicators cannot start", () => {
    const result = decideStart(combine([]), "index_build");
    expect(result.decision).toBe("wait");
    expectLogged(result);
  });
  for (const kind of kinds) {
    for (const work of ["index_build", "backfill_batch"] as const) {
      test(`${work} with ${kind}`, () => {
        const result = decideStart(verdict(kind), work);
        expect(result.decision).toBe(
          kind === "normal" ||
            (kind === "degraded" && work === "backfill_batch")
            ? "start"
            : "wait",
        );
        expectLogged(result);
      });
    }
  }
  test("combination is permutation independent and worst wins", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...kinds)), (sequence) => {
        const signals = sequence.map((kind) => reading(50, kind));
        const result = combine(signals);
        expect(result.kind).toBe(combine(signals.toReversed()).kind);
        let expected: HealthSignalKind = "normal";
        if (sequence.includes("degraded")) {
          expected = "degraded";
        }
        if (sequence.includes("unknown") || sequence.length === 0) {
          expected = "unknown";
        }
        if (sequence.includes("stop")) {
          expected = "stop";
        }
        expect(result.kind).toBe(expected);
      }),
      propertyConfig(),
    );
  });
  test("any index metric sequence starts only above the configured floor", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.array(fc.option(fc.integer({ min: 0, max: 100 }), { nil: null })),
        (floor, values) => {
          const config = { ...defaultConfig, startFloor: floor, hardFloor: 0 };
          for (const value of values) {
            let kind: HealthSignalKind = "normal";
            if (value === null) {
              kind = "unknown";
            } else if (value < floor) {
              kind = "degraded";
            }
            const signal = reading(value, kind);
            const result = decideStart(
              combine([signal]),
              "index_build",
              config,
            );
            expect(result.decision).toBe(
              value !== null && value >= floor ? "start" : "wait",
            );
            expectLogged(result);
          }
        },
      ),
      propertyConfig(),
    );
  });
});

describe("critical readings cancel only consecutively", () => {
  const cases = [
    { values: [], expected: "continue" },
    { values: [10], expected: "continue" },
    { values: [10, 20], expected: "cancel" },
    { values: [10, null], expected: "continue" },
    { values: [null, 10], expected: "continue" },
    { values: [10, 40], expected: "continue" },
    { values: [10, 90, 10], expected: "continue" },
    { values: [90, 10, 20], expected: "cancel" },
  ] as const;
  for (const { values, expected } of cases) {
    test(`${values.join(",")} => ${expected}`, () => {
      const result = decideWhileRunning(values.map((value) => reading(value)));
      expect(result.decision).toBe(expected);
      expectLogged(result);
    });
  }
  test("configured hard floor uses a strict comparison", () => {
    const config = { ...defaultConfig, hardFloor: 65 };
    for (const [value, expected] of [
      [64, "cancel"],
      [65, "continue"],
      [66, "continue"],
    ] as const) {
      const result = decideWhileRunning([reading(64), reading(value)], config);
      expect(result.decision).toBe(expected);
      expectLogged(result);
    }
  });
  test("unknown resets the critical streak", () => {
    expect(
      decideWhileRunning([reading(10), reading(null), reading(20)]).decision,
    ).toBe("continue");
    expect(
      decideWhileRunning([reading(10), reading(null), reading(20), reading(30)])
        .decision,
    ).toBe("cancel");
  });
  test("unknown, non-EBS and non-finite observations cannot cancel", () => {
    for (const signal of [
      reading(10, "unknown"),
      reading(Number.NaN),
      reading(Infinity),
      { ...reading(10), indicator: "long_transaction" as const },
    ]) {
      expect(decideWhileRunning([reading(10), signal]).decision).toBe(
        "continue",
      );
    }
  });
  test("for every history cancellation happens on the second real hard-floor reading, independently of progress", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.array(fc.option(fc.integer({ min: 0, max: 100 }), { nil: null })),
        fc.record({
          phase: fc.string(),
          blocksDone: fc.nat(),
          blocksTotal: fc.nat(),
        }),
        (floor, values, progress) => {
          const history: Signal[] = [];
          let previousLow = false;
          for (const value of values) {
            history.push(reading(value));
            const config = {
              ...defaultConfig,
              hardFloor: floor,
              startFloor: Math.max(defaultConfig.startFloor, floor),
            };
            const result = decideWhileRunning(history, config, progress);
            const low = value !== null && value < floor;
            expect(result.decision).toBe(
              previousLow && low ? "cancel" : "continue",
            );
            expect(result.decision).toBe(
              decideWhileRunning(history, config).decision,
            );
            expect(result.progress).toEqual(progress);
            expectLogged(result);
            previousLow = low;
          }
        },
      ),
      propertyConfig(),
    );
  });
});

describe("adaptive batch bounds and durable hold", () => {
  test("normal duration smooths and halves sleep", () => {
    const result = nextBatch({
      state: { ...state(), smoothedDurationMs: 1000 },
      verdict: verdict("normal"),
      lastDurationMs: 2000,
      clock,
    });
    expect(result.state.smoothedDurationMs).toBe(1400);
    expect(result.size).toBe(715);
    expect(result.sleepMs).toBe(500);
    expectLogged(result);
  });
  test("slow durations shrink at most by half, degraded shrinks once and doubles sleep", () => {
    for (const kind of ["normal", "degraded"] as const) {
      const result = advance(kind, 1_000_000);
      expect(result.size).toBe(500);
      expect(result.sleepMs).toBe(kind === "degraded" ? 2000 : 500);
      expectLogged(result);
    }
  });
  test("growth waits for stable completed batches", () => {
    let current = state();
    for (
      let index = 1;
      index <= defaultConfig.stableBatchesBeforeGrow;
      index++
    ) {
      const result = nextBatch({
        state: current,
        verdict: verdict("normal"),
        lastDurationMs: 1,
        clock,
      });
      expect(result.size).toBe(
        index < defaultConfig.stableBatchesBeforeGrow ? 1000 : 1200,
      );
      expectLogged(result);
      current = result.state;
    }
  });
  test("timeouts shrink 0.75 and retry without recording a stable success", () => {
    const result = nextBatch({
      state: state(),
      verdict: verdict("normal"),
      lastDurationMs: 5000,
      clock,
      outcome: "statement_timeout",
    });
    expect(result.size).toBe(750);
    expect(result.state.stableBatches).toBe(0);
    expectLogged(result);
  });
  test("holds retain the first timestamp, grow backoff to its cap, and run resets the streak", () => {
    let current = state();
    for (let index = 0; index < 10; index++) {
      const now = 100_000 + index * 1000;
      const result = nextBatch({
        state: current,
        verdict: verdict(index % 2 === 0 ? "stop" : "unknown"),
        lastDurationMs: null,
        clock: () => now,
      });
      expect(result.action).toBe("hold");
      expect(result.size).toBe(current.size);
      expect(result.state.heldSince).toBe(100_000);
      expect(result.state.holdUntil).toBe(
        now + Math.min(30_000 * 2 ** index, 1_800_000),
      );
      expectLogged(result);
      current = result.state;
    }
    const resumed = nextBatch({
      state: current,
      verdict: verdict("normal"),
      lastDurationMs: null,
      clock,
    });
    expect(resumed.state.heldSince).toBeNull();
    expect(resumed.state.holdUntil).toBeNull();
    expect(resumed.state.holdCount).toBe(0);
    expectLogged(resumed);
  });
  test("batch size and step ratio stay bounded through any health/duration sequence and configured bounds", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 100, max: 20_000 }),
        fc.array(
          fc.record({
            kind: fc.constantFrom(...kinds),
            duration: fc.integer({ min: 1, max: 10_000_000 }),
            timeout: fc.boolean(),
          }),
        ),
        (minSize, maxSize, sequence) => {
          const config = { ...defaultConfig, minSize, maxSize };
          let current = initialBatchState(config);
          for (const input of sequence) {
            const result = nextBatch({
              state: current,
              verdict: verdict(input.kind),
              lastDurationMs: input.duration,
              config,
              clock,
              outcome: input.timeout ? "statement_timeout" : "success",
            });
            expect(result.size).toBeGreaterThanOrEqual(minSize);
            expect(result.size).toBeLessThanOrEqual(maxSize);
            expect(result.size / current.size).toBeGreaterThanOrEqual(0.5);
            expect(result.size / current.size).toBeLessThanOrEqual(1.2);
            if (result.action === "hold") {
              expect(result.size).toBe(current.size);
            }
            expectLogged(result);
            current = result.state;
          }
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });
  test("missing duration cannot create evidence of a stable completed batch", () => {
    for (const duration of [null, 0, -1]) {
      const result = advance("normal", duration);
      expect(result.size).toBe(1000);
      expect(result.state.stableBatches).toBe(0);
      expect(result.state.smoothedDurationMs).toBeNull();
      expectLogged(result);
    }
  });
  test("sleep bounds apply at both ends", () => {
    expect(
      nextBatch({
        state: { ...state(), sleepMs: defaultConfig.minSleepMs },
        verdict: verdict("normal"),
        lastDurationMs: null,
        clock,
      }).sleepMs,
    ).toBe(defaultConfig.minSleepMs);
    expect(
      nextBatch({
        state: { ...state(), sleepMs: defaultConfig.maxSleepMs },
        verdict: verdict("degraded"),
        lastDurationMs: null,
        clock,
      }).sleepMs,
    ).toBe(defaultConfig.maxSleepMs);
  });
  test("held budget excludes busy windows, overlaps, overnight and DST elapsed time", () => {
    const cases = [
      {
        from: "2026-10-01T04:30:00Z",
        to: "2026-10-01T10:30:00Z",
        windows: defaultConfig.busyWindows,
        eligible: 4.5 * 3_600_000,
      },
      {
        from: "2026-10-01T05:00:00Z",
        to: "2026-10-01T09:00:00Z",
        windows: [
          { start: "06:00", end: "08:00", timeZone: "UTC" },
          { start: "07:00", end: "09:00", timeZone: "UTC" },
        ],
        eligible: 3_600_000,
      },
      {
        from: "2026-10-01T21:00:00Z",
        to: "2026-10-02T03:00:00Z",
        windows: [{ start: "22:00", end: "02:00", timeZone: "UTC" }],
        eligible: 2 * 3_600_000,
      },
      {
        from: "2026-03-29T00:00:00Z",
        to: "2026-03-29T03:00:00Z",
        windows: [{ start: "01:30", end: "03:30", timeZone: "Europe/Prague" }],
        eligible: 2 * 3_600_000,
      },
      {
        from: "2026-10-25T00:00:00Z",
        to: "2026-10-25T03:00:00Z",
        windows: [{ start: "02:15", end: "02:30", timeZone: "Europe/Prague" }],
        eligible: 2.5 * 3_600_000,
      },
    ];
    for (const { from, to, windows, eligible } of cases) {
      const heldSince = Temporal.Instant.from(from).epochMilliseconds;
      const now = Temporal.Instant.from(to).epochMilliseconds;
      const config = {
        ...defaultConfig,
        busyWindows: windows,
        maxHeldMs: eligible,
      };
      expect(isHeldTooLong({ heldSince }, now, config)).toBe(true);
      expect(
        isHeldTooLong({ heldSince }, now, {
          ...config,
          maxHeldMs: eligible + 1,
        }),
      ).toBe(false);
    }
    expect(isHeldTooLong({ heldSince: null }, 1000)).toBe(false);
    expect(isHeldTooLong({ heldSince: 1000 }, 999)).toBe(false);
  });
  test("busy-only extension and duplicated windows never consume held budget", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 90 * 60_000 }), (extension) => {
        const heldSince = Temporal.Instant.from(
          "2026-10-01T04:30:00Z",
        ).epochMilliseconds;
        const config = {
          ...defaultConfig,
          maxHeldMs: 1,
          busyWindows: [
            ...defaultConfig.busyWindows,
            ...defaultConfig.busyWindows,
          ],
        };
        expect(
          isHeldTooLong({ heldSince }, heldSince + extension, config),
        ).toBe(false);
        expect(
          isHeldTooLong({ heldSince }, heldSince + 90 * 60_000 + 1, config),
        ).toBe(true);
      }),
      propertyConfig(),
    );
  });
  test("held budget matches elapsed nonbusy minutes for arbitrary hold ranges", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1439 }),
        fc.integer({ min: 1, max: 2880 }),
        (startMinute, durationMinutes) => {
          const epoch = Temporal.Instant.from(
            "2026-10-01T00:00:00Z",
          ).epochMilliseconds;
          let eligibleMinutes = 0;
          for (
            let minute = startMinute;
            minute < startMinute + durationMinutes;
            minute++
          ) {
            const localMinute = minute % 1440;
            if (localMinute < 360 || localMinute >= 480) {
              eligibleMinutes++;
            }
          }
          const heldSince = epoch + startMinute * 60_000;
          const now = heldSince + durationMinutes * 60_000;
          const config = {
            ...defaultConfig,
            busyWindows: [{ start: "06:00", end: "08:00", timeZone: "UTC" }],
          };
          expect(
            isHeldTooLong({ heldSince }, now, {
              ...config,
              maxHeldMs: eligibleMinutes * 60_000 + 1,
            }),
          ).toBe(false);
          if (eligibleMinutes > 0) {
            expect(
              isHeldTooLong({ heldSince }, now, {
                ...config,
                maxHeldMs: eligibleMinutes * 60_000,
              }),
            ).toBe(true);
          }
        },
      ),
      propertyConfig(),
    );
  });
  test("effective growth streak and upper clamp apply to fast healthy batches", () => {
    for (const [required, completed, expected] of [
      [1, 0, 1200],
      [5, 2, 1000],
    ] as const) {
      const result = nextBatch({
        state: { ...state(), stableBatches: completed },
        verdict: verdict("normal"),
        lastDurationMs: 1,
        clock,
        config: { ...defaultConfig, stableBatchesBeforeGrow: required },
      });
      expect(result.size).toBe(expected);
      expectLogged(result);
    }
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 20_000 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 0, max: 10 }),
        (maxSize, required, distance) => {
          const config = {
            ...defaultConfig,
            maxSize,
            stableBatchesBeforeGrow: required,
          };
          let current = {
            ...initialBatchState(config),
            size: Math.max(config.minSize, maxSize - distance),
            stableBatches: required,
          };
          for (let index = 0; index < 12; index++) {
            const result = nextBatch({
              state: current,
              verdict: verdict("normal"),
              lastDurationMs: 1,
              clock,
              config,
            });
            expect(result.size).toBeLessThanOrEqual(maxSize);
            expect(result.size).toBeGreaterThanOrEqual(current.size);
            expect(result.size / current.size).toBeLessThanOrEqual(1.2);
            expectLogged(result);
            current = result.state;
          }
          expect(current.size).toBe(maxSize);
        },
      ),
      propertyConfig(),
    );
  });
});

test("invalid configuration fails before a decision can authorize work", () => {
  const cases = [
    { patch: { targetDurationMs: 0 }, reason: "Health durations" },
    { patch: { maxHeldMs: Number.NaN }, reason: "Health durations" },
    { patch: { startFloor: 39 }, reason: "Health floors" },
    { patch: { hardFloor: -1 }, reason: "Health floors" },
    { patch: { startFloor: 101 }, reason: "Health floors" },
    { patch: { minSize: 0 }, reason: "Batch size bounds" },
    { patch: { minSize: 101, maxSize: 100 }, reason: "Batch size bounds" },
    { patch: { maxSize: 100.5 }, reason: "Batch size bounds" },
    { patch: { minSleepMs: -1 }, reason: "Batch sleep bounds" },
    {
      patch: { minSleepMs: 101, maxSleepMs: 100 },
      reason: "Batch sleep bounds",
    },
    { patch: { stableBatchesBeforeGrow: 0 }, reason: "Stable batch count" },
    { patch: { holdBackoffCapMs: 1 }, reason: "Hold backoff cap" },
    {
      patch: {
        busyWindows: [
          { start: "25:00", end: "08:00", timeZone: "Europe/Prague" },
        ],
      },
      reason: "Busy windows",
    },
    ...["", "Europe/Invalid", "Invalid/Zone"].map((timeZone) => ({
      patch: {
        busyWindows: [
          { start: "06:00", end: "08:00", timeZone: "UTC" },
          { start: "08:00", end: "09:00", timeZone },
        ],
      },
      reason: `Busy windows require a valid time zone: ${timeZone}`,
    })),
  ];
  for (const { patch, reason } of cases) {
    const config = { ...defaultConfig, ...patch };
    expect(() => validateConfig(config)).toThrow(reason);
    expect(() => decideStart(verdict("normal"), "index_build", config)).toThrow(
      reason,
    );
    expect(() => decideWhileRunning([], config)).toThrow(reason);
    expect(() => isHeldTooLong({ heldSince: 0 }, 1000, config)).toThrow(reason);
    expect(() =>
      nextBatch({
        state: state(),
        verdict: verdict("normal"),
        lastDurationMs: null,
        clock,
        config,
      }),
    ).toThrow(reason);
  }
});

test("valid busy-window time zones authorize work and support held-budget decisions", () => {
  for (const timeZone of [
    "UTC",
    "Europe/Prague",
    "America/New_York",
    "Asia/Kolkata",
  ]) {
    const config = {
      ...defaultConfig,
      busyWindows: [{ start: "00:00", end: "01:00", timeZone }],
      maxHeldMs: 1000,
    };
    const decision = decideStart(verdict("normal"), "index_build", config);
    expect(decision.decision).toBe("start");
    expectLogged(decision);
    expect(
      isHeldTooLong(
        { heldSince: Date.parse("2026-01-01T12:00:00Z") },
        Date.parse("2026-01-01T12:00:01Z"),
        config,
      ),
    ).toBe(true);
  }
});

test("explicitly unconfigured signals are logged and neutral for all other health kinds", () => {
  const disabled = reading(null, "not_configured");
  const onlyDisabled = combine([disabled]);
  expect(onlyDisabled.kind).toBe("normal");
  const start = decideStart(onlyDisabled, "index_build");
  expect(start.decision).toBe("start");
  expect(start.verdict.signals).toEqual([disabled]);
  expectLogged(start);
  for (const kind of kinds) {
    const healthyOrBlocking = reading(valueByKind[kind], kind);
    const combined = combine([disabled, healthyOrBlocking]);
    expect(combined.kind).toBe(kind);
    expect(combine([healthyOrBlocking, disabled]).kind).toBe(kind);
    expectLogged(decideStart(combined, "index_build"));
    expect(combined.signals).toEqual([disabled, healthyOrBlocking]);
  }
  expect(decideWhileRunning([disabled, disabled]).decision).toBe("continue");
});
