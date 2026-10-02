import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  backfillHeartbeat,
  combine,
  defaultConfig,
  initialBatchState,
  nextBatch,
  validateConfig,
} from "./health";
import { ebsBalance } from "./indicators";

const config = {
  ...defaultConfig,
  hardFloor: 65,
  resumeFloor: 75,
  startFloor: 80,
  busyWindows: [],
};
const now = Date.parse("2026-10-02T10:00:00Z");
const read = async (value: number, age = 0) =>
  combine([
    await ebsBalance({
      config,
      now: () => now,
      read: async () => ({
        byteBalancePct: 99,
        ioBalancePct: value,
        observedAt: new Date(now - age).toISOString(),
      }),
    }),
  ]);
const step = (
  state: ReturnType<typeof initialBatchState>,
  verdict: Awaited<ReturnType<typeof read>>,
) =>
  nextBatch({ state, verdict, config, clock: () => now, lastDurationMs: null });

for (const [value, expected] of [
  [64, "hold"],
  [65, "hold"],
  [74, "hold"],
  [75, "run"],
  [76, "run"],
  [80, "run"],
] as const) {
  test(`held work at ${value} chooses ${expected}`, async () => {
    const held = step(initialBatchState(config), await read(64)).state;
    const result = step(held, await read(value));
    expect(result.action).toBe(expected);
    expect(result.state.heldSince).toBe(expected === "hold" ? now : null);
  });
}

test("omitting resume floor preserves degraded resume", async () => {
  const held = step(initialBatchState(config), await read(64)).state;
  expect(
    nextBatch({
      state: held,
      verdict: await read(65),
      config: { ...defaultConfig, hardFloor: 65, startFloor: 80 },
      clock: () => now,
      lastDurationMs: null,
    }).action,
  ).toBe("run");
});

test("resume requires a real fresh reading, including the exact fifteen minute boundary", async () => {
  const held = step(initialBatchState(config), await read(64)).state;
  for (const [age, expected] of [
    [900_000, "run"],
    [900_001, "hold"],
    [-1, "hold"],
  ] as const) {
    expect(step(held, await read(75, age)).action).toBe(expected);
  }
  for (const readValue of [
    async () => null,
    async () => {
      throw new TypeError("metric unavailable");
    },
    async () => await new Promise<null>(() => {}),
  ]) {
    const signal = await ebsBalance({
      config,
      now: () => now,
      read: readValue,
      timeout: () => ({ expired: Promise.resolve(), cancel: () => {} }),
    });
    expect(step(held, combine([signal])).action).toBe("hold");
  }
  expect(step(held, combine([])).action).toBe("hold");
  expect(
    step(
      held,
      combine([
        {
          indicator: "ebs_balance",
          kind: "normal",
          value: 90,
          threshold: 80,
          observedAt: new Date(now - 900_001).toISOString(),
          reason: "cached",
        },
      ]),
    ).action,
  ).toBe("hold");
});

test("hysteresis follows full band crossings for every flapping sequence", async () => {
  const signals = await Promise.all(
    Array.from({ length: 13 }, (_, offset) => read(64 + offset)),
  );
  assertProperty(
    "hysteresis follows full band crossings for every flapping sequence",
    fc.property(
      fc.array(fc.integer({ min: 64, max: 76 }), {
        minLength: 1,
        maxLength: 100,
      }),
      (values) => {
        let state = initialBatchState(config);
        let held = false;
        for (const value of values) {
          const signal = signals.at(value - 64);
          if (signal === undefined) {
            throw new TypeError("missing reading");
          }
          const wasHeld = held;
          if (value < 65) {
            held = true;
          }
          if (value >= 75) {
            held = false;
          }
          const result = step(state, signal);
          expect(result.action).toBe(held ? "hold" : "run");
          if (wasHeld && result.action === "run") {
            expect(value).toBeGreaterThanOrEqual(75);
          }
          if (result.action === "run") {
            expect(value).toBeGreaterThanOrEqual(65);
          }
          state = result.state;
        }
      },
    ),
  );
});

for (const resumeFloor of [64, 81, Number.NaN, Infinity]) {
  test(`invalid resume floor ${resumeFloor} is rejected`, () => {
    expect(() => validateConfig({ ...config, resumeFloor })).toThrow(
      "Resume floor must lie between hard and start floors",
    );
  });
}

test("heartbeat emits the gauge, transitions and held-duration boundary", async () => {
  const held = { heldSince: now - config.maxHeldMs };
  const verdict = await read(74);
  const record = backfillHeartbeat({
    name: "test",
    state: held,
    previousHeldSince: null,
    verdict,
    now,
    config,
  });
  expect(record.BackfillYielded).toBe(1);
  expect(record.heldTooLong).toBe(true);
  expect(record.event).toBe("backfill.yielded");
  expect(record._aws.CloudWatchMetrics).toEqual([
    {
      Namespace: "Stella/Backfill",
      Dimensions: [["Backfill"]],
      Metrics: [{ Name: "BackfillYielded", Unit: "Count" }],
    },
  ]);
  expect(record.Backfill).toBe("test");
  expect(record._aws.Timestamp).toBe(now);
  expect(
    backfillHeartbeat({
      name: "test",
      state: held,
      previousHeldSince: null,
      verdict,
      now: now - 1,
      config,
    }).heldTooLong,
  ).toBe(false);
  for (const [state, previousHeldSince, verdictValue, event, gauge] of [
    [
      { heldSince: null },
      held.heldSince,
      await read(75),
      "backfill.resumed",
      0,
    ],
    [{ heldSince: null }, null, await read(75), "backfill.throttled", 0],
    [held, held.heldSince, combine([]), "backfill.signal_unknown", 1],
    [{ heldSince: null }, null, await read(80), null, 0],
  ] as const) {
    const heartbeat = backfillHeartbeat({
      name: "test",
      state,
      previousHeldSince,
      verdict: verdictValue,
      now,
      config,
    });
    expect(heartbeat.event).toBe(event);
    expect(heartbeat.BackfillYielded).toBe(gauge);
  }
});

test("repeated holds preserve the original timestamp as time advances", async () => {
  const initial = step(initialBatchState(config), await read(64)).state;
  const subsequent = nextBatch({
    state: initial,
    verdict: await read(74),
    config,
    clock: () => now + 60_000,
    lastDurationMs: null,
  });
  expect(subsequent.action).toBe("hold");
  expect(subsequent.state.heldSince).toBe(now);
  expect(subsequent.state.holdUntil).toBe(
    now + 60_000 + config.holdBackoffMs * 2,
  );
  expect(subsequent.state.holdCount).toBe(2);
});

for (const observedAt of [null, "invalid", new Date(now + 1).toISOString()]) {
  test(`held work rejects a purported healthy reading with timestamp ${observedAt}`, async () => {
    const held = step(initialBatchState(config), await read(64)).state;
    expect(
      step(
        held,
        combine([
          {
            indicator: "ebs_balance",
            kind: "normal",
            value: 90,
            threshold: 80,
            observedAt,
            reason: "cached",
          },
        ]),
      ).action,
    ).toBe("hold");
  });
}

test("other holds override a healthy resume reading", async () => {
  const held = step(initialBatchState(config), await read(64)).state;
  const healthy = await read(80);
  for (const kind of ["stop", "unknown"] as const) {
    expect(
      step(
        held,
        combine([
          ...healthy.signals,
          {
            indicator: "busy_window",
            kind,
            value: 1,
            threshold: 0,
            observedAt: new Date(now).toISOString(),
            reason: "busy",
          },
        ]),
      ).action,
    ).toBe("hold");
  }
});
