import { expect, test } from "bun:test";

import { defaultConfig } from "@stll/db-load-gate/health";

import {
  createHostPressureProvider,
  createPressureReader,
  type HostPressureSnapshot,
} from "./pressure-reader";

const now = Date.parse("2026-10-27T12:00:00Z");
const snapshot = {
  cpu_percent: 20,
  read_iops: 100,
  write_iops: 200,
  read_bytes_per_second: 1000,
  write_bytes_per_second: 2000,
  observedAt: new Date(now).toISOString(),
} satisfies HostPressureSnapshot;

for (const freePi of [true, false]) {
  test(`host pressure selects ${freePi ? "free PI" : "CloudWatch fallback"} after read-only configuration discovery`, async () => {
    const calls: string[] = [];
    const read = createHostPressureProvider({
      instanceIdentifier: "fixture",
      clock: () => now,
      timeoutMs: 1000,
      clients: {
        rds: {
          send: async () => {
            calls.push("describe");
            return {
              $metadata: {},
              DBInstances: [
                {
                  DBInstanceIdentifier: "fixture",
                  PerformanceInsightsEnabled: freePi,
                  PerformanceInsightsRetentionPeriod: 7,
                  DbiResourceId: "db-fixture",
                },
              ],
            };
          },
        },
        pi: {
          send: async (command) => {
            calls.push("pi");
            return {
              $metadata: {},
              MetricList: command.input.MetricQueries?.map(({ Metric }) => ({
                Key: { Metric },
                DataPoints: [{ Timestamp: new Date(now), Value: 1 }],
              })),
            };
          },
        },
        cloudwatch: {
          send: async (command) => {
            calls.push("cloudwatch");
            expect(command.input.MetricDataQueries).toHaveLength(5);
            return {
              $metadata: {},
              MetricDataResults: command.input.MetricDataQueries?.map(
                ({ Id }) => ({
                  Id,
                  StatusCode: "Complete",
                  Timestamps: [new Date(now)],
                  Values: [1],
                }),
              ),
            };
          },
        },
      },
    });
    const result = await read();
    expect(calls).toEqual(["describe", freePi ? "pi" : "cloudwatch"]);
    expect(result?.cpu_percent).toBe(1);
    expect(result?.read_bytes_per_second).toBe(freePi ? 1024 : 1);
  });
}

test("source discovery expires before the next host refresh and cannot retain a paid PI mode", async () => {
  let clock = now;
  let discoveries = 0;
  const sources: string[] = [];
  const read = createHostPressureProvider({
    instanceIdentifier: "fixture",
    clock: () => clock,
    timeoutMs: 1000,
    clients: {
      rds: {
        send: async () => ({
          $metadata: {},
          DBInstances: [
            {
              DBInstanceIdentifier: "fixture",
              PerformanceInsightsEnabled: true,
              PerformanceInsightsRetentionPeriod: ++discoveries === 1 ? 7 : 31,
              DbiResourceId: "db-fixture",
            },
          ],
        }),
      },
      pi: {
        send: async (command) => {
          sources.push("pi");
          return {
            $metadata: {},
            MetricList: command.input.MetricQueries?.map(({ Metric }) => ({
              Key: { Metric },
              DataPoints: [{ Timestamp: new Date(clock), Value: 1 }],
            })),
          };
        },
      },
      cloudwatch: {
        send: async (command) => {
          sources.push("cloudwatch");
          return {
            $metadata: {},
            MetricDataResults: command.input.MetricDataQueries?.map(
              ({ Id }) => ({
                Id,
                StatusCode: "Complete",
                Timestamps: [new Date(clock)],
                Values: [1],
              }),
            ),
          };
        },
      },
    },
  });
  await read();
  clock += 10 * 60_000;
  await read();
  expect(discoveries).toBe(2);
  expect(sources).toEqual(["pi", "cloudwatch"]);
});

test("fleet cache coalesces readers, retains real timestamps after failure and holds once stale", async () => {
  let clock = now;
  let nextRefresh = 0;
  let stored: HostPressureSnapshot | null = null;
  let providerCalls = 0;
  const query = async (
    statement: string,
    parameters?: readonly (string | number | null)[],
  ) => {
    if (statement.includes("pressure_indicators")) {
      return [
        {
          active_sessions: 1,
          replication_lag_ms: 0,
          observedAt: new Date(clock).toISOString(),
        },
      ];
    }
    if (statement.includes("cache_claim")) {
      const claimed = clock >= nextRefresh;
      if (claimed) {
        nextRefresh = clock + 10 * 60_000;
      }
      return [{ claimed, snapshot: stored }];
    }
    if (statement.includes("cache_publish")) {
      const text = parameters?.at(2);
      expect(typeof text).toBe("string");
      stored = snapshot;
      return [];
    }
    throw new TypeError("Unexpected pressure query");
  };
  const options = {
    query,
    configuration: { type: "enabled", instanceIdentifier: "fixture" },
    config: defaultConfig,
    clock: () => clock,
    readHost: async () => (++providerCalls === 1 ? snapshot : null),
  } as const;
  const readers = Array.from({ length: 10 }, () =>
    createPressureReader(options),
  );
  const initial = await Promise.all(readers.map(async (read) => await read()));
  expect(providerCalls).toBe(1);
  expect(initial).toHaveLength(10);
  expect(initial.every((signals) => signals.length === 7)).toBe(true);
  const first = readers.at(0);
  if (first === undefined) {
    throw new TypeError("Fixture requires a reader");
  }
  clock += 1001;
  const settled = await first();
  expect(settled.every(({ kind }) => kind === "normal")).toBe(true);
  clock += 10 * 60_000;
  const retained = await first();
  expect(providerCalls).toBe(2);
  expect(
    retained.find(({ indicator }) => indicator === "cpu_percent")?.observedAt,
  ).toBe(snapshot.observedAt);
  clock = now + defaultConfig.maxStalenessMs + 1;
  const stale = await first();
  expect(stale.filter(({ kind }) => kind === "unknown")).toHaveLength(5);
});
