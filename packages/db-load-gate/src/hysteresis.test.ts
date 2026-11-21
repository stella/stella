import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  backfillHeartbeat,
  combine,
  defaultConfig,
  initialBatchState,
  MAX_CLOCK_SKEW_MS,
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
    [-MAX_CLOCK_SKEW_MS, "run"],
    [-MAX_CLOCK_SKEW_MS - 1, "hold"],
  ] as const) {
    expect(step(held, await read(75, age)).action).toBe(expected);
  }
  for (const readValue of [
    async () => null,
    async () => {
      throw new TypeError("metric unavailable");
    },
  ]) {
    const signal = await ebsBalance({
      config,
      now: () => now,
      read: readValue,
      timeout: () => ({
        expired: new Promise<void>(() => {}),
        cancel: () => {},
      }),
    });
    expect(signal.reason).toContain("Missing, failed");
    expect(step(held, combine([signal])).action).toBe("hold");
  }
  const timeoutSignal = await ebsBalance({
    config,
    now: () => now,
    read: async () => await new Promise<null>(() => {}),
    timeout: () => ({ expired: Promise.resolve(), cancel: () => {} }),
  });
  expect(step(held, combine([timeoutSignal])).action).toBe("hold");
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
    Array.from({ length: 13 }, async (_, offset) => await read(64 + offset)),
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

for (const observedAt of [
  null,
  "invalid",
  new Date(now + MAX_CLOCK_SKEW_MS + 1).toISOString(),
]) {
  test(`held work rejects a purported healthy reading with timestamp ${String(observedAt)}`, async () => {
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

test("held work resumes on a healthy reading stamped slightly ahead of the local clock", async () => {
  const held = step(initialBatchState(config), await read(64)).state;
  expect(step(held, await read(80, -26)).action).toBe("run");
  expect(step(held, await read(80, -MAX_CLOCK_SKEW_MS)).action).toBe("run");
});

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

for (const indicator of ["busy_window", "long_transaction"] as const) {
  test(`a ${indicator} hold can resume below the EBS resume floor`, async () => {
    const healthy = await read(70);
    for (const kind of ["stop", "unknown"] as const) {
      const held = step(
        initialBatchState(config),
        combine([
          ...healthy.signals,
          {
            indicator,
            kind,
            value: null,
            threshold: null,
            observedAt: null,
            reason: "unavailable",
          },
        ]),
      ).state;
      expect(held.holdCause).toBe("other");
      const resumed = step(held, healthy);
      expect(resumed.action).toBe("run");
      expect(resumed.state).toMatchObject({
        holdCause: null,
        heldSince: null,
        holdUntil: null,
        holdCount: 0,
      });
    }
  });
}

test("disabled EBS never applies hysteresis to any prior hold", async () => {
  const disabled = combine([
    {
      indicator: "ebs_balance",
      kind: "not_configured",
      value: null,
      threshold: null,
      observedAt: null,
      reason: "operator disabled EBS",
    },
  ]);
  for (const verdict of [await read(64), combine([])]) {
    const held = step(initialBatchState(config), verdict).state;
    expect(step(held, disabled).action).toBe("run");
  }
});

for (const resumeFloor of [config.hardFloor, config.startFloor]) {
  test(`resume floor ${resumeFloor} accepts equality with a configured boundary`, async () => {
    const boundaryConfig = { ...config, resumeFloor };
    validateConfig(boundaryConfig);
    const held = step(initialBatchState(config), await read(64)).state;
    const result = nextBatch({
      state: held,
      verdict: await read(resumeFloor),
      config: boundaryConfig,
      clock: () => now,
      lastDurationMs: null,
    });
    expect(result.action).toBe("run");
    expect(
      nextBatch({
        state: held,
        verdict: await read(resumeFloor - 1),
        config: boundaryConfig,
        clock: () => now,
        lastDurationMs: null,
      }).action,
    ).toBe("hold");
  });
}

test("heartbeat transitions are emitted once and unknown cannot hide them", async () => {
  const heldSince = now - 60_000;
  const verdict = await read(70);
  const held = backfillHeartbeat({
    name: "test",
    state: { heldSince },
    previousHeldSince: null,
    verdict,
    now,
    config,
  });
  expect(held).toMatchObject({
    event: "backfill.yielded",
    BackfillYielded: 1,
    heldTooLong: false,
    band: "degraded",
    class: "deferrable",
    reason: "Minimum byte and IO balance",
    heldSince,
    verdict,
  });
  expect(
    backfillHeartbeat({
      name: "test",
      state: { heldSince },
      previousHeldSince: heldSince,
      verdict,
      now,
      config,
    }).event,
  ).toBeNull();
  for (const [state, previousHeldSince, event] of [
    [{ heldSince }, null, "backfill.yielded"],
    [{ heldSince: null }, heldSince, "backfill.resumed"],
  ] as const) {
    expect(
      backfillHeartbeat({
        name: "test",
        state,
        previousHeldSince,
        verdict: combine([]),
        now,
        config,
      }),
    ).toMatchObject({ event, signalEvent: "backfill.signal_unknown" });
  }
  expect(
    backfillHeartbeat({
      name: "test",
      state: { heldSince: now - config.maxHeldMs },
      previousHeldSince: null,
      verdict,
      now,
      config: {
        ...config,
        busyWindows: [{ start: "04:00", end: "05:00", timeZone: "UTC" }],
      },
    }).heldTooLong,
  ).toBe(false);
});

test("changing clocks and signal ages preserve causal hysteresis and reset resume state", () => {
  assertProperty(
    "changing clocks and signal ages preserve causal hysteresis and reset resume state",
    fc.property(
      fc.array(
        fc.record({
          value: fc.integer({ min: 64, max: 80 }),
          age: fc.oneof(
            fc.constantFrom(
              -1,
              0,
              config.maxStalenessMs,
              config.maxStalenessMs + 1,
            ),
            fc.integer({ min: -1, max: config.maxStalenessMs + 1 }),
          ),
          elapsed: fc.integer({ min: 1, max: 60_000 }),
        }),
        { minLength: 1, maxLength: 100 },
      ),
      (sequence) => {
        let state = initialBatchState(config);
        let instant = now;
        let cause: "load" | "other" | null = null;
        for (const { value, age, elapsed } of sequence) {
          instant += elapsed;
          const clockInstant = instant;
          const fresh = age >= 0 && age <= config.maxStalenessMs;
          if (!fresh) {
            cause = cause === "load" ? "load" : "other";
          } else if (value < config.hardFloor) {
            cause = "load";
          } else if (cause !== "load" || value >= config.resumeFloor) {
            cause = null;
          }
          const kind = (() => {
            if (!fresh) {
              return "unknown";
            }
            if (value < config.hardFloor) {
              return "stop";
            }
            return value < config.startFloor ? "degraded" : "normal";
          })();
          const result = nextBatch({
            state,
            verdict: combine([
              {
                indicator: "ebs_balance",
                kind,
                value: fresh ? value : null,
                threshold: config.hardFloor,
                observedAt: new Date(instant - age).toISOString(),
                reason: "sequence",
              },
            ]),
            config,
            clock: () => clockInstant,
            lastDurationMs: null,
          });
          expect(result.action).toBe(cause === null ? "run" : "hold");
          expect(result.state.holdCause).toBe(cause);
          if (result.action === "run") {
            expect(result.state).toMatchObject({
              holdCount: 0,
              heldSince: null,
              holdUntil: null,
            });
          }
          state = result.state;
        }
      },
    ),
  );
});

test("an unrelated hold upgrades to a load hold when a later reading falls below the hard floor", async () => {
  const unrelated = step(initialBatchState(config), combine([])).state;
  expect(unrelated.holdCause).toBe("other");
  const loadHeld = step(unrelated, await read(64)).state;
  expect(loadHeld.holdCause).toBe("load");
  expect(loadHeld.heldSince).toBe(unrelated.heldSince);
  expect(step(loadHeld, await read(74)).action).toBe("hold");
  expect(step(loadHeld, await read(75)).action).toBe("run");
});
