import { expect, test } from "bun:test";
import * as v from "valibot";

import {
  combine,
  decideStart,
  defaultConfig,
  initialBatchState,
  nextBatch,
} from "@stll/db-load-gate/health";
import { Temporal } from "@stll/time";

import { envBaseServerSchema } from "../../env-base-schema";
import {
  createEbsSignalReader,
  resolveEbsConfiguration,
  type EbsConfigurationEvent,
} from "./ebs-signal-reader";

const now = Temporal.Instant.from("2026-10-01T12:00:00Z").epochMilliseconds;
const clock = () => now;
const rows = [
  {
    name: "RDS identifier reads metrics",
    identifier: "test-instance",
    optOut: undefined,
    type: "enabled",
    kind: "normal",
    decision: "start",
    action: "run",
    readers: 1,
    logs: 0,
  },
  {
    name: "explicit non-RDS opt-out is nonblocking",
    identifier: undefined,
    optOut: "disabled",
    type: "disabled",
    kind: "not_configured",
    decision: "start",
    action: "run",
    readers: 0,
    logs: 0,
  },
  {
    name: "neither option holds and names missing configuration",
    identifier: undefined,
    optOut: undefined,
    type: "missing",
    kind: "unknown",
    decision: "wait",
    action: "hold",
    readers: 0,
    logs: 1,
  },
  {
    name: "identifier takes precedence over opt-out",
    identifier: "test-instance",
    optOut: "disabled",
    type: "enabled",
    kind: "normal",
    decision: "start",
    action: "run",
    readers: 1,
    logs: 0,
  },
  {
    name: "blank identifier without explicit opt-out remains missing",
    identifier: "  ",
    optOut: undefined,
    type: "missing",
    kind: "unknown",
    decision: "wait",
    action: "hold",
    readers: 0,
    logs: 1,
  },
] as const;

for (const row of rows) {
  test(row.name, async () => {
    const events: EbsConfigurationEvent[] = [];
    const readerInstances: string[] = [];
    let metricReads = 0;
    const configuration = resolveEbsConfiguration({
      DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER: row.identifier,
      DB_LOAD_GATE_EBS_SIGNAL: row.optOut,
    });
    expect(configuration.type).toBe(row.type);
    const read = createEbsSignalReader({
      configuration,
      clock,
      config: defaultConfig,
      log: (event) => events.push(event),
      createReader: ({
        instanceIdentifier,
        clock: readerClock,
        timeoutMs,
        maxStalenessMs,
      }) => {
        readerInstances.push(instanceIdentifier);
        expect(readerClock()).toBe(now);
        expect(timeoutMs).toBe(defaultConfig.readTimeoutMs);
        expect(maxStalenessMs).toBe(defaultConfig.maxStalenessMs);
        return async () => {
          metricReads++;
          return {
            byteBalancePct: 80,
            ioBalancePct: 90,
            observedAt: Temporal.Instant.fromEpochMilliseconds(now).toString(),
          };
        };
      },
    });
    for (let index = 0; index < 2; index++) {
      const signal = await read();
      expect(signal.kind).toBe(row.kind);
      const verdict = combine([signal]);
      const start = decideStart(verdict, "index_build");
      expect(start.decision).toBe(row.decision);
      const batch = nextBatch({
        state: initialBatchState(),
        verdict,
        lastDurationMs: null,
        clock,
      });
      expect(batch.action).toBe(row.action);
      const serialized = JSON.stringify(start);
      expect(JSON.parse(serialized).verdict.signals).toEqual([signal]);
      expect(start.config.startFloor).toBe(defaultConfig.startFloor);
      expect(batch.verdict.signals).toEqual([signal]);
    }
    expect(readerInstances).toHaveLength(row.readers);
    expect(metricReads).toBe(row.readers * 2);
    expect(events).toHaveLength(row.logs);
    if (row.logs === 1) {
      expect(events.at(0)).toMatchObject({
        event: "database_load_gate_ebs_configuration_missing",
        severity: "error",
        configurationKeys: [
          "DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER",
          "DB_LOAD_GATE_EBS_SIGNAL",
        ],
      });
      expect(events.at(0)?.message).toContain(
        "DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER",
      );
      expect(events.at(0)?.message).toContain(
        "DB_LOAD_GATE_EBS_SIGNAL=disabled",
      );
    }
  });
}

test("an enabled metric factory failure still produces an unknown blocking signal", async () => {
  const read = createEbsSignalReader({
    configuration: { type: "enabled", instanceIdentifier: "test-instance" },
    clock,
    config: defaultConfig,
    createReader: () => {
      throw new TypeError("metric initialization unavailable");
    },
  });
  const signal = await read();
  expect(signal.kind).toBe("unknown");
  expect(decideStart(combine([signal]), "index_build").decision).toBe("wait");
});

test("opt-out environment accepts only the explicit disabled value", () => {
  const schema = envBaseServerSchema.DB_LOAD_GATE_EBS_SIGNAL;
  expect(v.parse(schema, undefined)).toBeUndefined();
  expect(v.parse(schema, "disabled")).toBe("disabled");
  for (const value of ["enabled", "false", "true", "0", "disable"]) {
    expect(v.safeParse(schema, value).success).toBe(false);
  }
});

test("effective metric staleness reaches the CloudWatch factory", async () => {
  const customStalenessMs = 40 * 60_000;
  const windows: number[] = [];
  const read = createEbsSignalReader({
    configuration: { type: "enabled", instanceIdentifier: "test-instance" },
    clock,
    config: { ...defaultConfig, maxStalenessMs: customStalenessMs },
    createReader: ({ maxStalenessMs }) => {
      windows.push(maxStalenessMs);
      return async () => ({
        byteBalancePct: 90,
        ioBalancePct: 90,
        observedAt: Temporal.Instant.fromEpochMilliseconds(now).toString(),
      });
    },
  });
  expect((await read()).kind).toBe("normal");
  expect(windows).toEqual([customStalenessMs]);
});
