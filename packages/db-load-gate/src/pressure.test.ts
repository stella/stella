import { expect, test } from "bun:test";

import {
  combine,
  decideStart,
  decideWhileRunning,
  defaultConfig,
  defaultPressureThresholds,
  initialBatchState,
  nextBatch,
  PRESSURE_INDICATORS,
} from "./health";
import { pressureSignal } from "./indicators";

const now = Date.parse("2026-10-27T12:00:00Z");
const observedAt = new Date(now).toISOString();
const config = { ...defaultConfig, busyWindows: [] };
for (const indicator of PRESSURE_INDICATORS) {
  const threshold = defaultPressureThresholds[indicator];
  for (const [value, kind] of [
    [0, "normal"],
    [threshold.throttle, "degraded"],
    [threshold.pause, "stop"],
  ] as const) {
    test(`${indicator} pressure ${value} is ${kind}`, async () => {
      const signal = await pressureSignal({
        indicator,
        config,
        now: () => now,
        read: async () => ({ value, observedAt }),
      });
      expect(signal.kind).toBe(kind);
      expect(
        decideStart(combine([signal]), "index_build", config).decision,
      ).toBe(kind === "normal" ? "start" : "wait");
    });
  }
  for (const [description, reading] of [
    ["missing", null],
    ["negative", { value: -1, observedAt }],
    ["nonfinite", { value: Number.NaN, observedAt }],
    [
      "stale",
      {
        value: 0,
        observedAt: new Date(now - config.maxStalenessMs - 1).toISOString(),
      },
    ],
  ] as const) {
    test(`${indicator} ${description} holds maintenance`, async () => {
      const signal = await pressureSignal({
        indicator,
        config,
        now: () => now,
        read: async () => reading,
      });
      expect(signal.kind).toBe("unknown");
      expect(
        nextBatch({
          state: initialBatchState(config),
          config,
          clock: () => now,
          lastDurationMs: null,
          verdict: combine([signal]),
        }).action,
      ).toBe("hold");
    });
  }
  test(`${indicator} backs off, cancels consecutive pressure and resumes when pressure clears`, async () => {
    const read = async (value: number) =>
      combine([
        await pressureSignal({
          indicator,
          config,
          now: () => now,
          read: async () => ({ value, observedAt }),
        }),
      ]);
    const pressured = await read(threshold.pause);
    const clear = await read(0);
    const first = nextBatch({
      state: initialBatchState(config),
      config,
      clock: () => now,
      lastDurationMs: null,
      verdict: pressured,
    });
    const second = nextBatch({
      state: first.state,
      config,
      clock: () => now + config.holdBackoffMs,
      lastDurationMs: null,
      verdict: pressured,
    });
    expect(first.action).toBe("hold");
    expect(second.action).toBe("hold");
    expect(second.state.holdCount).toBe(2);
    expect(decideWhileRunning([pressured, pressured], config).decision).toBe(
      "cancel",
    );
    expect(decideWhileRunning([pressured, clear], config).decision).toBe(
      "continue",
    );
    const resumed = nextBatch({
      state: second.state,
      config,
      clock: () => now + config.holdBackoffCapMs,
      lastDurationMs: 100,
      verdict: clear,
    });
    expect(resumed.action).toBe("run");
    expect(resumed.state.heldSince).toBeNull();
  });
}

for (const indicator of PRESSURE_INDICATORS) {
  for (const threshold of [
    { throttle: -1, pause: 10 },
    { throttle: 10, pause: 10 },
    { throttle: 10, pause: Number.POSITIVE_INFINITY },
    { throttle: Number.NaN, pause: 20 },
  ]) {
    test(`${indicator} rejects invalid threshold ${JSON.stringify(threshold)}`, () => {
      const invalid = {
        ...config,
        pressure: { ...defaultPressureThresholds, [indicator]: threshold },
      };
      expect(() => decideStart(combine([]), "index_build", invalid)).toThrow(
        "Pressure thresholds must be finite, nonnegative and ordered",
      );
    });
  }
}
