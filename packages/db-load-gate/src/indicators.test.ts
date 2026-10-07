import { expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import { defaultConfig, MAX_CLOCK_SKEW_MS } from "./health";
import {
  autovacuumOnTarget,
  busyWindow,
  ebsBalance,
  longTransaction,
} from "./indicators";

const instant = Temporal.Instant.from("2026-10-01T12:00:00Z").epochMilliseconds;
const options = { now: () => instant, config: defaultConfig };
const observedAt = new Date(instant).toISOString();
const valid = { byteBalancePct: 80, ioBalancePct: 90, observedAt };

for (const [name, read] of [
  ["empty", async () => null],
  [
    "throw",
    async () => {
      throw new TypeError("metric unavailable");
    },
  ],
  [
    "stale",
    async () => ({
      ...valid,
      observedAt: new Date(
        instant - defaultConfig.maxStalenessMs - 1,
      ).toISOString(),
    }),
  ],
  [
    "future",
    async () => ({
      ...valid,
      observedAt: new Date(instant + MAX_CLOCK_SKEW_MS + 1).toISOString(),
    }),
  ],
  ["non-finite", async () => ({ ...valid, byteBalancePct: Number.NaN })],
] as const) {
  test(`balance ${name} fails closed`, async () => {
    expect((await ebsBalance({ ...options, read })).kind).toBe("unknown");
  });
}

test("a reader that never settles times out without sleeping", async () => {
  const timeout = () => ({ expired: Promise.resolve(), cancel: () => {} });
  const read = async () => await new Promise<never>(() => {});
  expect((await ebsBalance({ ...options, read, timeout })).kind).toBe(
    "unknown",
  );
  expect((await longTransaction({ ...options, read, timeout })).kind).toBe(
    "unknown",
  );
  expect(
    (
      await autovacuumOnTarget({
        ...options,
        read,
        timeout,
        kind: "index_build",
      })
    ).kind,
  ).toBe("unknown");
});

for (const [balance, kind] of [
  [39, "stop"],
  [40, "degraded"],
  [69, "degraded"],
  [70, "normal"],
] as const) {
  test(`minimum balance ${balance} produces ${kind}`, async () => {
    const signal = await ebsBalance({
      ...options,
      read: async () => ({ ...valid, ioBalancePct: balance }),
    });
    expect(signal.kind).toBe(kind);
    expect(signal.value).toBe(balance);
    expect(signal.observedAt).toBe(observedAt);
    expect(signal.threshold).toBe(
      kind === "stop" ? defaultConfig.hardFloor : defaultConfig.startFloor,
    );
  });
}

test("transaction age and autovacuum severity depend on the supplied limits and work kind", async () => {
  expect(
    (
      await longTransaction({
        ...options,
        read: async () => ({
          ageMs: defaultConfig.longTxMaxAgeMs + 1,
          observedAt,
        }),
      })
    ).kind,
  ).toBe("stop");
  expect(
    (
      await longTransaction({
        ...options,
        read: async () => ({ ageMs: defaultConfig.longTxMaxAgeMs, observedAt }),
      })
    ).kind,
  ).toBe("normal");
  for (const kind of ["index_build", "backfill_batch"] as const) {
    expect(
      (
        await autovacuumOnTarget({
          ...options,
          kind,
          read: async () => ({ active: true, observedAt }),
        })
      ).kind,
    ).toBe(kind === "index_build" ? "stop" : "degraded");
    expect(
      (
        await autovacuumOnTarget({
          ...options,
          kind,
          read: async () => ({ active: false, observedAt }),
        })
      ).kind,
    ).toBe("normal");
  }
});

for (const day of ["2026-01-15", "2026-03-29", "2026-07-15", "2026-10-25"]) {
  const offset =
    day === "2026-01-15" || day === "2026-10-25" ? "+01:00" : "+02:00";
  for (const [time, kind] of [
    ["06:29:59", "normal"],
    ["06:30:00", "stop"],
    ["07:59:59", "stop"],
    ["08:00:00", "normal"],
  ] as const) {
    test(`Prague busy window ${day} ${time} is ${kind}`, () => {
      expect(
        busyWindow({
          ...options,
          now: () =>
            Temporal.Instant.from(`${day}T${time}${offset}`).epochMilliseconds,
        }).kind,
      ).toBe(kind);
    });
  }
}

test("overnight windows include midnight and exclude their end", () => {
  const config = {
    ...defaultConfig,
    busyWindows: [{ start: "23:00", end: "01:00", timeZone: "UTC" }],
  };
  for (const [time, kind] of [
    ["22:59:59", "normal"],
    ["23:00:00", "stop"],
    ["00:00:00", "stop"],
    ["01:00:00", "normal"],
  ] as const) {
    expect(
      busyWindow({
        config,
        now: () =>
          Temporal.Instant.from(`2026-01-01T${time}Z`).epochMilliseconds,
      }).kind,
    ).toBe(kind);
  }
});

for (const [name, reading] of [
  ["empty", null],
  [
    "stale",
    {
      ageMs: 0,
      active: false,
      observedAt: new Date(
        instant - defaultConfig.maxStalenessMs - 1,
      ).toISOString(),
    },
  ],
] as const) {
  test(`database indicators ${name} fail closed`, async () => {
    expect(
      (await longTransaction({ ...options, read: async () => reading })).kind,
    ).toBe("unknown");
    expect(
      (
        await autovacuumOnTarget({
          ...options,
          kind: "backfill_batch",
          read: async () => reading,
        })
      ).kind,
    ).toBe("unknown");
  });
}

// Readings can carry a small clock skew from the clock that stamped them.
for (const skewMs of [26, MAX_CLOCK_SKEW_MS]) {
  test(`readings stamped ${skewMs} ms ahead of the local clock are fresh`, async () => {
    const ahead = new Date(instant + skewMs).toISOString();
    expect(
      (
        await ebsBalance({
          ...options,
          read: async () => ({ ...valid, observedAt: ahead }),
        })
      ).kind,
    ).toBe("normal");
    const reading = { ageMs: 0, active: false, observedAt: ahead };
    expect(
      (await longTransaction({ ...options, read: async () => reading })).kind,
    ).toBe("normal");
    expect(
      (
        await autovacuumOnTarget({
          ...options,
          kind: "index_build",
          read: async () => reading,
        })
      ).kind,
    ).toBe("normal");
  });
}

test("database reader failures are surfaced as unknown signals", async () => {
  const read = async () => {
    throw new TypeError("database unavailable");
  };
  expect((await longTransaction({ ...options, read })).kind).toBe("unknown");
  expect(
    (await autovacuumOnTarget({ ...options, kind: "index_build", read })).kind,
  ).toBe("unknown");
});

test("throwing clocks and invalid clock values fail closed for every indicator", async () => {
  for (const now of [
    () => {
      throw new TypeError("clock unavailable");
    },
    () => Number.NaN,
    () => Infinity,
  ]) {
    expect(
      (await ebsBalance({ ...options, now, read: async () => valid })).kind,
    ).toBe("unknown");
    expect(
      (
        await longTransaction({
          ...options,
          now,
          read: async () => ({ ageMs: 0, observedAt }),
        })
      ).kind,
    ).toBe("unknown");
    expect(
      (
        await autovacuumOnTarget({
          ...options,
          now,
          kind: "index_build",
          read: async () => ({ active: false, observedAt }),
        })
      ).kind,
    ).toBe("unknown");
    expect(busyWindow({ ...options, now }).kind).toBe("unknown");
  }
  expect(
    busyWindow({
      ...options,
      now: () => Number.MAX_VALUE,
      config: { ...defaultConfig, busyWindows: [] },
    }).kind,
  ).toBe("unknown");
});

test("timeout setup and cleanup failures fail closed", async () => {
  const failure = () => {
    throw new TypeError("timer unavailable");
  };
  for (const timeout of [
    failure,
    () => ({ expired: new Promise<void>(() => {}), cancel: failure }),
  ]) {
    expect(
      (await ebsBalance({ ...options, read: async () => valid, timeout })).kind,
    ).toBe("unknown");
    expect(
      (
        await longTransaction({
          ...options,
          read: async () => ({ ageMs: 0, observedAt }),
          timeout,
        })
      ).kind,
    ).toBe("unknown");
    expect(
      (
        await autovacuumOnTarget({
          ...options,
          kind: "index_build",
          read: async () => ({ active: false, observedAt }),
          timeout,
        })
      ).kind,
    ).toBe("unknown");
  }
});

test("either balance metric can stop work and custom floors apply inclusively", async () => {
  const config = { ...defaultConfig, hardFloor: 60, startFloor: 90 };
  for (const lowMetric of ["byteBalancePct", "ioBalancePct"] as const) {
    for (const [value, kind] of [
      [59, "stop"],
      [60, "degraded"],
      [89, "degraded"],
      [90, "normal"],
    ] as const) {
      const reading = {
        ...valid,
        byteBalancePct: 100,
        ioBalancePct: 100,
        [lowMetric]: value,
      };
      const signal = await ebsBalance({
        ...options,
        config,
        read: async () => reading,
      });
      expect(signal.kind).toBe(kind);
      expect(signal.value).toBe(value);
    }
  }
});

test("staleness is inclusive at the configured boundary", async () => {
  const config = { ...defaultConfig, maxStalenessMs: 1000 };
  for (const [age, kind] of [
    [1000, "normal"],
    [1001, "unknown"],
  ] as const) {
    const reading = {
      ...valid,
      observedAt: new Date(instant - age).toISOString(),
    };
    expect(
      (await ebsBalance({ ...options, config, read: async () => reading }))
        .kind,
    ).toBe(kind);
  }
});

test("every configured busy window can stop work", () => {
  const config = {
    ...defaultConfig,
    busyWindows: [
      { start: "06:00", end: "07:00", timeZone: "UTC" },
      { start: "12:00", end: "13:00", timeZone: "UTC" },
    ],
  };
  for (const timestamp of ["2026-10-01T06:30:00Z", "2026-10-01T12:30:00Z"]) {
    const signal = busyWindow({
      now: () => Temporal.Instant.from(timestamp).epochMilliseconds,
      config,
    });
    expect(signal.kind).toBe("stop");
    expect(signal.value).toBe(1);
  }
});
