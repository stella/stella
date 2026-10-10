import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { Signal } from "@stll/db-load-gate/health";
import {
  AUTOVACUUM_SQL,
  ebsBalance,
  LONG_TRANSACTION_SQL,
} from "@stll/db-load-gate/indicators";
import { propertyConfig } from "@stll/property-testing";

import { readOnlineIndexConfig } from "../env-online-index";
import {
  createOnlineIndexGate,
  createOnlineIndexHold,
  type OnlineIndexEbsSource,
  type OnlineIndexHoldRef,
} from "./online-index-gate";
import type { OnlineMigrationConnection } from "./online-migration-connection";

const EXPECTED_WAITING_PHASES = [
  "waiting for writers before build",
  "waiting for writers before validation",
  "waiting for old snapshots",
  "waiting for readers before marking dead",
  "waiting for readers before dropping",
  "waiting for concurrent index lock",
  "waiting for a future PostgreSQL phase",
] as const;

const config = (
  overrides: Partial<ReturnType<typeof readOnlineIndexConfig>> = {},
) => ({
  ...readOnlineIndexConfig({ DB_LOAD_GATE_BUSY_WINDOWS: "[]" }),
  ...overrides,
});

const ebs = (
  value: number | null,
  kind: Signal["kind"] = "normal",
): Signal => ({
  indicator: "ebs_balance",
  kind,
  value,
  threshold: 70,
  observedAt: kind === "unknown" ? null : "2026-10-02T12:00:00.000Z",
  reason: kind === "unknown" ? "Unavailable" : "Injected reading",
});

type HarnessOptions = {
  readings: readonly Signal[];
  phases?: readonly string[];
  tickMs?: number;
  config?: ReturnType<typeof config>;
  finishAfterPolls?: number;
  workSlotAvailable?: boolean;
  deferBuild?: boolean;
  observerFailure?: Error;
  observerDatabase?: string;
  autovacuumActive?: boolean;
  onObserverFailure?: () => void;
  cancelBackend?: (pid: number) => Promise<boolean>;
  onCancel?: () => void;
  hold?: OnlineIndexHoldRef;
  ebsSource?: OnlineIndexEbsSource;
};

const makeHarness = ({
  readings,
  phases = [],
  tickMs = 30,
  config: gateConfig = config(),
  finishAfterPolls = 1,
  workSlotAvailable = true,
  deferBuild = true,
  observerFailure,
  observerDatabase = "test",
  autovacuumActive = false,
  onObserverFailure,
  cancelBackend,
  onCancel,
  hold = createOnlineIndexHold(),
  ebsSource,
}: HarnessOptions) => {
  let now = Date.parse("2026-10-02T12:00:00.000Z");
  let readingOffset = 0;
  let phaseOffset = 0;
  let polls = 0;
  let finishBuild: (() => void) | undefined;
  let rejectBuild: ((error: unknown) => void) | undefined;
  const records: unknown[] = [];
  const statements: string[] = [];
  const queryCalls: { statement: string; parameters: unknown[] }[] = [];
  const cancelHookPids: number[] = [];
  let terminated = false;
  let terminateCount = 0;
  let settleBuild: (() => void) | undefined;
  const buildSettled = new Promise<void>((resolve) => {
    settleBuild = resolve;
  });
  const observerQueries: string[] = [];
  const takeReading = () => {
    const reading = readings.at(readingOffset) ?? readings.at(-1);
    readingOffset += 1;
    if (!reading) {
      throw new TypeError("Harness requires at least one injected EBS reading");
    }
    return reading;
  };
  const connection: OnlineMigrationConnection = {
    execute: async (statement) => {
      statements.push(statement);
      if (terminated) {
        throw new Error("session terminated");
      }
      if (
        deferBuild &&
        statement ===
          "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)"
      ) {
        try {
          await new Promise<void>((resolve, reject) => {
            finishBuild = resolve;
            rejectBuild = reject;
          });
        } finally {
          settleBuild?.();
        }
      }
    },
    query: async (statement, parameters = []) => {
      statements.push(statement);
      queryCalls.push({ statement, parameters: [...parameters] });
      if (terminated) {
        throw new Error("session terminated");
      }
      if (statement.includes("pg_try_advisory_lock($1::int, $2::int)")) {
        return [{ acquired: workSlotAvailable }];
      }
      if (statement.includes("advisory")) {
        return [{ acquired: true }];
      }
      if (statement.includes("pg_backend_pid")) {
        return [{ pid: 101, database: "test" }];
      }
      if (statement.includes("set_config")) {
        return [];
      }
      throw new TypeError(`Unexpected build connection query: ${statement}`);
    },
    terminate: async () => {
      terminateCount += 1;
      terminated = true;
      rejectBuild?.(new Error("builder physical session terminated"));
    },
    release: () => undefined,
  };
  const observer: OnlineMigrationConnection = {
    execute: async () => undefined,
    query: async (statement, parameters = []) => {
      observerQueries.push(statement);
      if (statement === LONG_TRANSACTION_SQL) {
        return [{ ageMs: 0, observedAt: new Date(now).toISOString() }];
      }
      if (statement === AUTOVACUUM_SQL) {
        return [
          {
            active: autovacuumActive && parameters.at(0) === "test_table",
            observedAt: new Date(now).toISOString(),
          },
        ];
      }
      if (statement.includes("pg_backend_pid")) {
        return [{ pid: 202, database: observerDatabase }];
      }
      if (statement.includes("pg_stat_progress_create_index")) {
        if (observerFailure) {
          onObserverFailure?.();
          throw observerFailure;
        }
        polls += 1;
        const phase =
          phases.at(phaseOffset) ??
          phases.at(-1) ??
          "building index: scanning table";
        phaseOffset += 1;
        return [{ phase, blocksDone: polls * 10, blocksTotal: 100 }];
      }
      if (statement.includes("pg_cancel_backend")) {
        onCancel?.();
        rejectBuild?.(
          Object.assign(new Error("query canceled"), { code: "57014" }),
        );
        return [{ cancelled: true }];
      }
      throw new TypeError(`Unexpected observer query: ${statement}`);
    },
    release: () => undefined,
  };
  const gate = createOnlineIndexGate({
    connection,
    observer,
    tableName: "test_table",
    name: "test_idx",
    kind: "index_build",
    config: gateConfig,
    hold,
    clock: () => now,
    ebs: ebsSource ?? { type: "reader", read: async () => takeReading() },
    wait: async (_milliseconds, signal) => {
      now += tickMs;
      if (polls >= finishAfterPolls && !signal.aborted) {
        finishBuild?.();
      }
    },
    log: (record) => {
      records.push(record);
    },
    cancelBackend: async (pid) => {
      cancelHookPids.push(pid);
      if (cancelBackend) {
        return await cancelBackend(pid);
      }
      rejectBuild?.(
        Object.assign(new Error("query canceled"), { code: "57014" }),
      );
      return true;
    },
  });
  return {
    gate,
    records,
    statements,
    queryCalls,
    cancelHookPids,
    isTerminated: () => terminated,
    terminateCount: () => terminateCount,
    buildSettled,
    finishBuild: () => finishBuild?.(),
    observerQueries,
    pollCount: () => polls,
    advanceClock: (milliseconds: number) => {
      now += milliseconds;
    },
  };
};

const loggedRecords = (records: readonly unknown[]) =>
  records.map((record) => {
    if (
      typeof record !== "object" ||
      record === null ||
      !("record" in record)
    ) {
      throw new TypeError("Expected structured online-index decision log");
    }
    return record.record;
  });

describe("online index gate", () => {
  test("rejects an observer connected to a different database before building", async () => {
    const harness = makeHarness({
      readings: [ebs(90)],
      observerDatabase: "another_database",
    });

    const rejection: unknown = await harness.gate
      .attempt("CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)")
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(rejection).toMatchObject({
      message: expect.stringContaining(
        "Online index observer must use a separate physical session in the same database",
      ),
    });
    expect(harness.statements).not.toContain(
      "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
    );
    expect(harness.statements).not.toContain("SET lock_timeout = '0'");
  });

  test("waits for unavailable, stale, unknown, and below-floor starting readings", async () => {
    const health = config().health;
    const missing = await ebsBalance({
      read: async () => null,
      now: () => Date.parse("2026-10-02T12:00:00.000Z"),
      config: health,
    });
    const stale = await ebsBalance({
      read: async () => ({
        byteBalancePct: 90,
        ioBalancePct: 90,
        observedAt: "2026-10-02T11:00:00.000Z",
      }),
      now: () => Date.parse("2026-10-02T12:00:00.000Z"),
      config: health,
    });
    const unavailable = await ebsBalance({
      read: async () => {
        throw new Error("reader unavailable");
      },
      now: () => Date.parse("2026-10-02T12:00:00.000Z"),
      config: health,
    });
    const belowFloor = await ebsBalance({
      read: async () => ({
        byteBalancePct: 69,
        ioBalancePct: 90,
        observedAt: "2026-10-02T12:00:00.000Z",
      }),
      now: () => Date.parse("2026-10-02T12:00:00.000Z"),
      config: health,
    });
    const cases = [
      { label: "missing metric", signal: missing },
      { label: "stale metric", signal: stale },
      { label: "unknown metric", signal: unavailable },
      { label: "below configured floor", signal: belowFloor },
    ];
    for (const { label, signal } of cases) {
      const harness = makeHarness({ readings: [signal] });
      expect(
        await harness.gate.attempt(
          "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
        ),
      ).toBe("wait");
      expect(harness.statements).not.toContain(
        "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
      );
      expect(JSON.stringify(harness.records), label).toContain(
        '"decision":"wait"',
      );
      await harness.gate.close();
    }
  });

  test("active target autovacuum prevents a healthy disk from starting an index", async () => {
    const statement =
      "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)";
    for (const autovacuumActive of [true, false]) {
      const harness = makeHarness({
        readings: [ebs(90)],
        autovacuumActive,
      });
      try {
        expect(await harness.gate.attempt(statement)).toBe(
          autovacuumActive ? "wait" : "done",
        );
        expect(harness.statements.includes(statement)).toBe(!autovacuumActive);
        expect(loggedRecords(harness.records)).toContainEqual(
          expect.objectContaining({
            decision: autovacuumActive ? "wait" : "start",
            verdict: expect.objectContaining({
              signals: expect.arrayContaining([
                expect.objectContaining({
                  indicator: "autovacuum_on_target",
                  kind: autovacuumActive ? "stop" : "normal",
                }),
              ]),
            }),
          }),
        );
      } finally {
        await harness.gate.close();
      }
    }
  });

  test("builds on an explicitly disabled EBS signal without reading metrics", async () => {
    const harness = makeHarness({
      readings: [],
      ebsSource: { type: "disabled" },
    });

    expect(
      await harness.gate.attempt(
        "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
      ),
    ).toBe("done");
    expect(harness.statements).toContain(
      "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
    );
    expect(JSON.stringify(harness.records)).toContain(
      '"kind":"not_configured"',
    );
    await harness.gate.close();
  });

  test("starts at the configured floor and logs the values and effective thresholds", async () => {
    const gateConfig = config({
      health: { ...config().health, startFloor: 80, hardFloor: 30 },
      parallelWorkers: 0,
      maintenanceWorkMemMb: 96,
    });
    const harness = makeHarness({
      readings: [ebs(80), ebs(90)],
      config: gateConfig,
    });
    const outcome = await harness.gate.attempt(
      "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
    );
    expect(outcome).toBe("done");
    expect(harness.statements).toContain(
      "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
    );
    expect(JSON.stringify(harness.records)).toContain('"value":80');
    expect(JSON.stringify(harness.records)).toContain('"startFloor":80');
    expect(harness.statements).toContain("SET lock_timeout = '0'");
    expect(harness.statements).toContain("SET statement_timeout = '0'");
    const settingsQuery =
      "SELECT set_config('max_parallel_maintenance_workers', $1, false), set_config('maintenance_work_mem', $2, false)";
    expect(harness.statements).toContain(settingsQuery);
    expect(
      harness.queryCalls.find(({ statement }) => statement === settingsQuery)
        ?.parameters,
    ).toEqual(["0", "96MB"]);
    await harness.gate.close();
  });

  test("never starts below the configured floor and cancels within one poll after two real low readings", async () => {
    const metric = fc.oneof(
      fc.integer({ min: 0, max: 39 }).map((value) => ebs(value, "stop")),
      fc.integer({ min: 40, max: 69 }).map((value) => ebs(value, "degraded")),
      fc.integer({ min: 70, max: 100 }).map((value) => ebs(value, "normal")),
      fc.constant(ebs(null, "unknown")),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(metric, { minLength: 3, maxLength: 12 }),
        async (sequence) => {
          const gateConfig = config();
          const pollReadings = sequence.slice(1);
          const harness = makeHarness({
            readings: sequence,
            finishAfterPolls: pollReadings.length,
          });
          const outcome = await harness.gate.attempt(
            "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
          );
          const didStart = harness.statements.includes(
            "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
          );
          const start = sequence.at(0);
          const mayStart =
            start?.kind === "normal" &&
            start.value !== null &&
            start.value >= gateConfig.health.startFloor;
          expect(didStart).toBe(mayStart);
          if (!didStart) {
            expect(outcome).toBe("wait");
            await harness.gate.close();
            return true;
          }
          let consecutiveLow = 0;
          let firstCancelPoll: number | undefined;
          for (const [index, reading] of pollReadings.entries()) {
            consecutiveLow =
              reading.indicator === "ebs_balance" &&
              reading.kind !== "unknown" &&
              reading.value !== null &&
              reading.value < gateConfig.health.hardFloor
                ? consecutiveLow + 1
                : 0;
            if (consecutiveLow === 2) {
              firstCancelPoll = index + 1;
              break;
            }
          }
          if (firstCancelPoll !== undefined) {
            expect(outcome).toBe("retry");
            expect(harness.pollCount()).toBeLessThanOrEqual(firstCancelPoll);
          } else {
            expect(outcome).toBe("done");
          }
          await harness.gate.close();
          return true;
        },
      ),
      propertyConfig({ numRuns: 60 }),
    );
  });

  test("unknown readings reset the two-reading cancellation streak", async () => {
    const harness = makeHarness({
      readings: [
        ebs(90),
        ebs(20, "stop"),
        ebs(null, "unknown"),
        ebs(20, "stop"),
        ebs(20, "stop"),
      ],
      finishAfterPolls: 4,
    });
    expect(
      await harness.gate.attempt(
        "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
      ),
    ).toBe("retry");
    expect(harness.pollCount()).toBe(4);
    expect(JSON.stringify(harness.records)).toContain('"value":20');
    await harness.gate.close();
  });

  test("cancels each known PostgreSQL waiting phase and future wait phases", async () => {
    expect(new Set(EXPECTED_WAITING_PHASES).size).toBe(
      EXPECTED_WAITING_PHASES.length,
    );
    for (const phase of EXPECTED_WAITING_PHASES) {
      const gateConfig = config({ maxSnapshotWaitMs: 60 });
      const harness = makeHarness({
        readings: [ebs(90), ebs(90), ebs(90)],
        phases: [phase, phase],
        tickMs: 30,
        config: gateConfig,
        finishAfterPolls: 4,
      });
      expect(
        await harness.gate.attempt(
          "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
        ),
      ).toBe("retry");
      const output = JSON.stringify(harness.records);
      expect(output).toContain("Snapshot wait watchdog");
      expect(output).toContain('"waitingMs":60');
      expect(output).toContain('"maxSnapshotWaitMs":60');
      await harness.gate.close();
    }
  });

  test("records a slot refusal without a start decision", async () => {
    const harness = makeHarness({
      readings: [ebs(90)],
      workSlotAvailable: false,
    });
    expect(
      await harness.gate.attempt(
        "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
      ),
    ).toBe("wait");
    expect(harness.statements).not.toContain(
      "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
    );
    const decisions = loggedRecords(harness.records);
    expect(decisions).not.toContainEqual(
      expect.objectContaining({ decision: "start" }),
    );
    expect(decisions).toContainEqual(
      expect.objectContaining({
        decision: "wait",
        reason: "Heavy-work slot unavailable",
      }),
    );
    await harness.gate.close();
  });

  test("logs numeric metric readings and configured floors with every decision", async () => {
    const harness = makeHarness({
      readings: [ebs(90), ebs(88)],
    });
    expect(
      await harness.gate.attempt(
        "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
      ),
    ).toBe("done");
    const decisions = loggedRecords(harness.records);
    expect(decisions.length).toBeGreaterThanOrEqual(3);
    for (const decision of decisions) {
      expect(decision).toMatchObject({
        verdict: {
          signals: expect.arrayContaining([
            expect.objectContaining({
              indicator: "ebs_balance",
              value: expect.any(Number),
              threshold: expect.any(Number),
            }),
          ]),
        },
        config: { startFloor: 70, hardFloor: 40 },
      });
    }
    await harness.gate.close();
  });

  test("alerts once after a health hold exceeds its configured duration", async () => {
    const gateConfig = config({
      health: { ...config().health, maxHeldMs: 100 },
    });
    const harness = makeHarness({
      readings: [ebs(69, "degraded")],
      config: gateConfig,
    });
    const statement =
      "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)";
    expect(await harness.gate.attempt(statement)).toBe("wait");
    harness.advanceClock(101);
    expect(await harness.gate.attempt(statement)).toBe("wait");
    expect(await harness.gate.attempt(statement)).toBe("wait");
    const alerts = harness.records.filter(
      (record) =>
        typeof record === "object" &&
        record !== null &&
        "event" in record &&
        record.event === "database_load_gate_held_too_long",
    );
    expect(alerts).toHaveLength(1);
    await harness.gate.close();
  });

  test("a held index excludes busy-window time from its single alert", async () => {
    const gateConfig = config({
      health: {
        ...config().health,
        maxHeldMs: 60_000,
        busyWindows: [{ start: "12:00", end: "12:30", timeZone: "UTC" }],
      },
    });
    const harness = makeHarness({
      readings: [ebs(69, "degraded")],
      config: gateConfig,
    });
    const statement =
      "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)";
    const alerts = () =>
      harness.records.filter(
        (record) =>
          typeof record === "object" &&
          record !== null &&
          "event" in record &&
          record.event === "database_load_gate_held_too_long",
      );
    try {
      expect(await harness.gate.attempt(statement)).toBe("wait");
      harness.advanceClock(15 * 60_000);
      expect(await harness.gate.attempt(statement)).toBe("wait");
      expect(alerts()).toEqual([]);
      harness.advanceClock(15 * 60_000);
      expect(await harness.gate.attempt(statement)).toBe("wait");
      expect(alerts()).toEqual([]);
      harness.advanceClock(60_000);
      expect(await harness.gate.attempt(statement)).toBe("wait");
      expect(alerts()).toHaveLength(1);
      harness.advanceClock(60_000);
      expect(await harness.gate.attempt(statement)).toBe("wait");
      expect(alerts()).toHaveLength(1);
      expect(harness.statements).not.toContain(statement);
    } finally {
      await harness.gate.close();
    }
  });

  /**
   * A held build ends its migrator run so the schema lane is released, and
   * the next run creates a new gate. The hold must outlive the gate, or it
   * would restart with every run and never alert.
   */
  test("a hold shared across gates alerts once, measured from the first gate", async () => {
    const gateConfig = config({
      health: { ...config().health, maxHeldMs: 100 },
    });
    const statement =
      "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)";
    const hold = createOnlineIndexHold();
    const heldGate = () =>
      makeHarness({
        readings: [ebs(69, "degraded")],
        config: gateConfig,
        hold,
      });
    const alertsOf = (records: readonly unknown[]) =>
      records.filter(
        (record) =>
          typeof record === "object" &&
          record !== null &&
          "event" in record &&
          record.event === "database_load_gate_held_too_long",
      );

    const first = heldGate();
    expect(await first.gate.attempt(statement)).toBe("wait");
    await first.gate.close();
    expect(alertsOf(first.records)).toEqual([]);
    const heldSince = Date.parse("2026-10-02T12:00:00.000Z");
    expect(hold.current).toEqual({ type: "held", since: heldSince });

    const second = heldGate();
    second.advanceClock(101);
    expect(await second.gate.attempt(statement)).toBe("wait");
    await second.gate.close();
    expect(alertsOf(second.records)).toEqual([
      expect.objectContaining({ heldSince, now: heldSince + 101 }),
    ]);

    const third = heldGate();
    third.advanceClock(202);
    expect(await third.gate.attempt(statement)).toBe("wait");
    await third.gate.close();
    expect(alertsOf(third.records)).toEqual([]);

    const healthy = makeHarness({
      readings: [ebs(90), ebs(90)],
      config: gateConfig,
      hold,
    });
    expect(await healthy.gate.attempt(statement)).toBe("done");
    await healthy.gate.close();
    expect(hold.current).toEqual({ type: "clear" });
  });

  test("prevents the next repair statement when cancellation lands between statements", async () => {
    const reachedGap = Promise.withResolvers<undefined>();
    const resumeGap = Promise.withResolvers<undefined>();
    let callbackSettled = false;
    const harness = makeHarness({
      readings: [ebs(90), ebs(20, "stop"), ebs(20, "stop")],
      finishAfterPolls: 100,
      deferBuild: false,
      onCancel: () => resumeGap.resolve(undefined),
    });
    const attempt = harness.gate.attempt(async (guardedConnection) => {
      try {
        await guardedConnection.execute("DROP INDEX CONCURRENTLY test_idx");
        reachedGap.resolve(undefined);
        await resumeGap.promise;
        await guardedConnection.execute(
          "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
        );
      } finally {
        callbackSettled = true;
      }
    });
    await reachedGap.promise;
    expect(await attempt).toBe("retry");
    expect(harness.statements).toContain("DROP INDEX CONCURRENTLY test_idx");
    expect(harness.statements).not.toContain(
      "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
    );
    expect(callbackSettled).toBe(true);
    await harness.gate.close();
  });

  test("uses independent cancellation and settles the build after observer loss", async () => {
    const failure = new Error("progress observer disconnected");
    const observerFailed = Promise.withResolvers<undefined>();
    const harness = makeHarness({
      readings: [ebs(90), ebs(90)],
      observerFailure: failure,
      onObserverFailure: () => observerFailed.resolve(undefined),
      finishAfterPolls: 100,
    });
    const attempt = harness.gate.attempt(
      "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
    );
    await observerFailed.promise;
    if (harness.cancelHookPids.length === 0) {
      harness.finishBuild();
    }
    const rejection = await attempt.then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({
      message: "progress observer disconnected",
    });
    await harness.buildSettled;
    expect(harness.cancelHookPids).toEqual([101]);
    expect(harness.statements).toContain(
      "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
    );
    await harness.gate.close();
  });

  test("terminates the physical builder session when monitoring and cancellation both fail", async () => {
    const failure = new Error("progress observer disconnected");
    const cancellationFailure = new Error("independent cancel failed");
    const cancelAttempted = Promise.withResolvers<undefined>();
    let callbackSettled = false;
    const harness = makeHarness({
      readings: [ebs(90)],
      observerFailure: failure,
      cancelBackend: async () => {
        cancelAttempted.resolve(undefined);
        throw cancellationFailure;
      },
      finishAfterPolls: 100,
    });
    const attempt = harness.gate.attempt(async (guardedConnection) => {
      try {
        await guardedConnection.execute(
          "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
        );
      } finally {
        callbackSettled = true;
      }
    });

    await cancelAttempted.promise;
    if (!harness.isTerminated()) {
      harness.finishBuild();
    }
    const rejection = await attempt.then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message:
        "Online index monitoring and independent cancellation failed; build session terminated",
    });
    expect(harness.terminateCount()).toBe(1);
    expect(harness.isTerminated()).toBe(true);
    expect(callbackSettled).toBe(true);
    await harness.buildSettled;
    expect(harness.queryCalls.map(({ statement }) => statement)).not.toContain(
      "SELECT pg_advisory_unlock($1::int, $2::int)",
    );
    expect(harness.statements).not.toContain("SET lock_timeout = '1s'");
    await harness.gate.close();
    expect(harness.terminateCount()).toBe(1);
  });

  test("holds builds at the local busy-window boundary and resumes at its end", async () => {
    const busyHealth = {
      ...config().health,
      busyWindows: [{ start: "12:00", end: "12:30", timeZone: "UTC" }],
    };
    const busyConfig = config({ health: busyHealth });
    const statement =
      "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)";
    const atStart = makeHarness({
      readings: [ebs(90)],
      config: busyConfig,
    });
    expect(await atStart.gate.attempt(statement)).toBe("wait");
    expect(atStart.statements).not.toContain(statement);
    await atStart.gate.close();

    const afterEnd = makeHarness({
      readings: [ebs(90), ebs(90)],
      config: busyConfig,
      finishAfterPolls: 1,
    });
    afterEnd.advanceClock(30 * 60_000);
    expect(await afterEnd.gate.attempt(statement)).toBe("done");
    expect(afterEnd.statements).toContain(statement);
    await afterEnd.gate.close();
  });

  test("resets the watchdog when the PostgreSQL waiting phase changes", async () => {
    const gateConfig = config({ maxSnapshotWaitMs: 60 });
    const harness = makeHarness({
      readings: [ebs(90), ebs(90), ebs(90), ebs(90)],
      phases: [
        EXPECTED_WAITING_PHASES[0],
        EXPECTED_WAITING_PHASES[1],
        EXPECTED_WAITING_PHASES[1],
        "building index: scanning table",
      ],
      tickMs: 30,
      config: gateConfig,
      finishAfterPolls: 4,
    });
    expect(
      await harness.gate.attempt(
        "CREATE INDEX CONCURRENTLY test_idx ON public.test_table (id)",
      ),
    ).toBe("done");
    expect(JSON.stringify(harness.records)).not.toContain(
      "Snapshot wait watchdog",
    );
    await harness.gate.close();
  });
});

describe("online index configuration", () => {
  test("reads the build floors and resource settings from the supplied environment", () => {
    const actual = readOnlineIndexConfig({
      DB_LOAD_GATE_START_FLOOR: "82",
      DB_LOAD_GATE_HARD_FLOOR: "35",
      ONLINE_INDEX_POLL_MS: "1500",
      ONLINE_INDEX_RETRY_MS: "2500",
      ONLINE_INDEX_MAX_SNAPSHOT_WAIT_MS: "6000",
      ONLINE_INDEX_CLIENT_CHECK_MS: "2000",
      ONLINE_INDEX_PARALLEL_WORKERS: "0",
      ONLINE_INDEX_MAINTENANCE_WORK_MEM_MB: "96",
      DB_LOAD_GATE_BUSY_WINDOWS: "[]",
    });
    expect(actual.health.startFloor).toBe(82);
    expect(actual.health.hardFloor).toBe(35);
    expect(actual.pollMs).toBe(1500);
    expect(actual.retryMs).toBe(2500);
    expect(actual.maxSnapshotWaitMs).toBe(6000);
    expect(actual.clientConnectionCheckMs).toBe(2000);
    expect(actual.parallelWorkers).toBe(0);
    expect(actual.maintenanceWorkMemMb).toBe(96);
  });

  test("rejects invalid values and floors that are out of order", () => {
    expect(() => readOnlineIndexConfig({ ONLINE_INDEX_POLL_MS: "0" })).toThrow(
      "Invalid",
    );
    expect(() =>
      readOnlineIndexConfig({
        DB_LOAD_GATE_START_FLOOR: "30",
        DB_LOAD_GATE_HARD_FLOOR: "40",
      }),
    ).toThrow("Health floors must be ordered percentages");
  });
});
