import { Result } from "better-result";
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
import { EbsBalanceReadError } from "./ebs-balance-reader";
import {
  createEbsReaderCache,
  createEbsSignalReader,
  EbsConfigurationMissingError,
  requireEbsConfiguration,
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
      log: (event) => {
        events.push(event);
      },
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
          return Result.ok({
            byteBalancePct: 80,
            ioBalancePct: 90,
            observedAt: Temporal.Instant.fromEpochMilliseconds(now).toString(),
          });
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
      return async () =>
        Result.ok({
          byteBalancePct: 90,
          ioBalancePct: 90,
          observedAt: Temporal.Instant.fromEpochMilliseconds(now).toString(),
        });
    },
  });
  expect((await read()).kind).toBe("normal");
  expect(windows).toEqual([customStalenessMs]);
});

test("an adapter Err remains an unknown blocking signal", async () => {
  const failure = new EbsBalanceReadError({ message: "provider unavailable" });
  const read = createEbsSignalReader({
    configuration: { type: "enabled", instanceIdentifier: "test-instance" },
    clock,
    config: defaultConfig,
    createReader: () => async () => Result.err(failure),
  });
  const signal = await read();
  expect(signal.kind).toBe("unknown");
  expect(decideStart(combine([signal]), "index_build").decision).toBe("wait");
});

test("the migrator requirement rejects only a missing configuration", () => {
  const missing = requireEbsConfiguration(resolveEbsConfiguration({}));
  expect(missing.isErr()).toBe(true);
  if (missing.isOk()) {
    throw new TypeError("A missing configuration must be rejected");
  }
  expect(missing.error).toBeInstanceOf(EbsConfigurationMissingError);
  expect(missing.error.configurationKeys).toEqual([
    "DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER",
    "DB_LOAD_GATE_EBS_SIGNAL",
  ]);
  expect(missing.error.message).toContain(
    "DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER",
  );
  expect(missing.error.message).toContain("DB_LOAD_GATE_EBS_SIGNAL=disabled");

  expect(
    requireEbsConfiguration(
      resolveEbsConfiguration({ DB_LOAD_GATE_EBS_SIGNAL: "disabled" }),
    ).unwrap(),
  ).toEqual({ type: "disabled" });
  expect(
    requireEbsConfiguration(
      resolveEbsConfiguration({
        DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER: " test-instance ",
      }),
    ).unwrap(),
  ).toEqual({ type: "enabled", instanceIdentifier: "test-instance" });
});

test("separate signal readers coalesce provider requests and refresh at exactly 120 seconds", async () => {
  let instant = now;
  let requests = 0;
  let factories = 0;
  const releases: (() => void)[] = [];
  const startedResolvers: (() => void)[] = [];
  const started = Array.from(
    { length: 2 },
    async () =>
      new Promise<void>((resolve) => {
        startedResolvers.push(resolve);
      }),
  );
  const shared = createEbsReaderCache({
    clock: () => instant,
    createReader: () => {
      factories++;
      return async () => {
        requests++;
        startedResolvers.at(requests - 1)?.();
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return Result.ok({
          byteBalancePct: 90,
          ioBalancePct: 85,
          observedAt: new Date(instant).toISOString(),
        });
      };
    },
  });
  const makeReader = (startFloor: number) =>
    createEbsSignalReader({
      configuration: { type: "enabled", instanceIdentifier: "shared-instance" },
      config: { ...defaultConfig, startFloor },
      clock: () => instant,
      createReader: shared,
    });
  const first = makeReader(70);
  const second = makeReader(90);
  const concurrent = [first(), second()];
  await started.at(0);
  expect(requests).toBe(1);
  releases.at(0)?.();
  expect((await Promise.all(concurrent)).map(({ kind }) => kind)).toEqual([
    "normal",
    "degraded",
  ]);
  expect(factories).toBe(1);
  instant += 119_999;
  expect((await makeReader(70)()).kind).toBe("normal");
  expect(requests).toBe(1);
  instant += 1;
  const refreshed = second();
  await started.at(1);
  expect(requests).toBe(2);
  releases.at(1)?.();
  expect((await refreshed).kind).toBe("degraded");
});

test("failed refreshes retain the real timestamp until the outer signal becomes stale", async () => {
  let instant = now;
  let requests = 0;
  const shared = createEbsReaderCache({
    clock: () => instant,
    createReader: () => async () => {
      requests++;
      if (requests > 1) {
        return Result.err(
          new EbsBalanceReadError({ message: "provider unavailable" }),
        );
      }
      return Result.ok({
        byteBalancePct: 80,
        ioBalancePct: 90,
        observedAt: new Date(now).toISOString(),
      });
    },
  });
  const read = createEbsSignalReader({
    configuration: { type: "enabled", instanceIdentifier: "retained-instance" },
    config: defaultConfig,
    clock: () => instant,
    createReader: shared,
  });
  expect((await read()).kind).toBe("normal");
  instant += 120_000;
  expect(await read()).toMatchObject({
    kind: "normal",
    observedAt: new Date(now).toISOString(),
  });
  expect(requests).toBe(2);
  instant = now + defaultConfig.maxStalenessMs;
  expect(await read()).toMatchObject({
    kind: "normal",
    observedAt: new Date(now).toISOString(),
  });
  expect(requests).toBe(3);
  instant += 1;
  expect((await read()).kind).toBe("unknown");
  expect(requests).toBe(3);
});

test.each(["factory", "reader"] as const)(
  "a thrown %s failure is cached as an error and retried after expiry",
  async (failureAt) => {
    let instant = now;
    let attempts = 0;
    const failure = new EbsBalanceReadError({ message: "provider threw" });
    const shared = createEbsReaderCache({
      clock: () => instant,
      createReader: () => {
        if (failureAt === "factory") {
          attempts++;
          throw failure;
        }
        return async () => {
          attempts++;
          throw failure;
        };
      },
    });
    const read = shared({
      instanceIdentifier: "throwing-instance",
      clock: () => instant,
      timeoutMs: defaultConfig.readTimeoutMs,
      maxStalenessMs: defaultConfig.maxStalenessMs,
    });
    expect((await read()).isErr()).toBe(true);
    expect((await read()).isErr()).toBe(true);
    expect(attempts).toBe(1);
    instant += 120_000;
    expect((await read()).isErr()).toBe(true);
    expect(attempts).toBe(2);
  },
);

test.each(["factory", "reader"] as const)(
  "a successful reading replaces a cached %s error after expiry",
  async (failureAt) => {
    let instant = now;
    let attempts = 0;
    const failure = new EbsBalanceReadError({
      message: "provider unavailable",
    });
    const shared = createEbsReaderCache({
      clock: () => instant,
      createReader: () => {
        if (failureAt === "factory" && attempts++ === 0) {
          throw failure;
        }
        return async () => {
          if (failureAt === "reader" && attempts++ === 0) {
            return Result.err(failure);
          }
          return Result.ok({
            byteBalancePct: 90,
            ioBalancePct: 85,
            observedAt:
              Temporal.Instant.fromEpochMilliseconds(instant).toString(),
          });
        };
      },
    });
    const read = createEbsSignalReader({
      configuration: {
        type: "enabled",
        instanceIdentifier: "recovering-instance",
      },
      config: defaultConfig,
      clock: () => instant,
      createReader: shared,
    });
    expect((await read()).kind).toBe("unknown");
    instant += 119_999;
    expect((await read()).kind).toBe("unknown");
    expect(attempts).toBe(1);
    instant += 1;
    expect(await read()).toMatchObject({
      kind: "normal",
      observedAt: Temporal.Instant.fromEpochMilliseconds(instant).toString(),
    });
    expect(attempts).toBe(2);
    expect((await read()).kind).toBe("normal");
    expect(attempts).toBe(2);
  },
);

test("unknown startup is cached without synthesizing a datapoint and raw reader configuration separates cache keys", async () => {
  let instant = now;
  let requests = 0;
  const configurations: {
    instanceIdentifier: string;
    timeoutMs: number;
    maxStalenessMs: number;
  }[] = [];
  const shared = createEbsReaderCache({
    clock: () => instant,
    createReader: (options) => {
      configurations.push(options);
      return async () => {
        requests++;
        return Result.err(
          new EbsBalanceReadError({ message: "no real reading" }),
        );
      };
    },
  });
  const options = {
    instanceIdentifier: "startup-instance",
    clock: () => instant,
    timeoutMs: defaultConfig.readTimeoutMs,
    maxStalenessMs: defaultConfig.maxStalenessMs,
  };
  const initial = shared(options);
  expect((await initial()).isErr()).toBe(true);
  expect((await shared({ ...options })()).isErr()).toBe(true);
  expect(requests).toBe(1);
  instant += 120_000;
  expect((await initial()).isErr()).toBe(true);
  expect(requests).toBe(2);
  for (const different of [
    { ...options, instanceIdentifier: "another-instance" },
    { ...options, timeoutMs: options.timeoutMs + 1 },
    { ...options, maxStalenessMs: options.maxStalenessMs + 1 },
  ]) {
    expect((await shared(different)()).isErr()).toBe(true);
  }
  expect(requests).toBe(5);
  expect(configurations).toHaveLength(4);
});
