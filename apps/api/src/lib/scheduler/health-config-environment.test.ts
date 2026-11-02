import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { ValiError } from "valibot";

import { BackfillHeldError } from "@stll/db-load-gate/backfill-pass";
import { initialBatchState } from "@stll/db-load-gate/health";
import type { HealthConfig, Signal } from "@stll/db-load-gate/health";
import {
  AUTOVACUUM_SQL,
  LONG_TRANSACTION_SQL,
} from "@stll/db-load-gate/indicators";
import { Temporal } from "@stll/time";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import type { Transaction } from "@/api/db/root";
import {
  loadGateHealthConfig,
  readOnlineIndexConfig,
} from "@/api/env-online-index";
import { schedulerBackfillConfig } from "@/api/lib/scheduler/backfill-config";
import { caseLawCoverageRefreshConfig } from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const pragueInstant = (time: string) =>
  Temporal.PlainDateTime.from(`2026-01-15T${time}`)
    .toZonedDateTime("Europe/Prague")
    .toInstant().epochMilliseconds;

/** Inside the default 06:30-08:00 Prague busy window. */
const IN_DEFAULT_BUSY_WINDOW = pragueInstant("07:15");
const OUTSIDE_DEFAULT_BUSY_WINDOW = pragueInstant("12:00");

/** One batch on a quiet database and table, so only the busy windows can hold it. */
const runOneBatch = async (config: HealthConfig, now: number) => {
  const observedAt = new Date(now).toISOString();
  const query = async (statement: string) => {
    if (statement === LONG_TRANSACTION_SQL) {
      return await Promise.resolve([{ ageMs: 0, observedAt }]);
    }
    if (statement === AUTOVACUUM_SQL) {
      return await Promise.resolve([{ active: false, observedAt }]);
    }
    if (statement.startsWith("SELECT cursor, batch")) {
      return await Promise.resolve([
        { cursor: null, batch: initialBatchState(config) },
      ]);
    }
    return await Promise.resolve([{ acquired: true }]);
  };
  const dialect = new PgDialect();
  const transaction = asTestRaw<Transaction>({
    execute: async (statement: Parameters<typeof dialect.sqlToQuery>[0]) =>
      await query(dialect.sqlToQuery(statement).sql),
  });
  const ioBalance: Signal = {
    indicator: "ebs_balance",
    kind: "normal",
    value: 100,
    threshold: config.hardFloor,
    observedAt,
    reason: "Minimum byte and IO balance",
  };
  const runtime = createScriptBackfillRuntime({
    name: "health-config-environment",
    tableName: "rows",
    initialSize: 1,
    config,
    clock: () => now,
    readEbsSignal: async () => await Promise.resolve(ioBalance),
    log: () => undefined,
    db: {
      transaction: async (work) => await work(transaction),
      execute: transaction.execute,
    },
    slot: { tryAcquire: async () => true, release: () => undefined },
  });
  try {
    const outcome = await Result.tryPromise({
      try: async () =>
        await runtime.step(
          async () =>
            await Promise.resolve({ cursor: null, done: true, value: "ran" }),
        ),
      catch: (error: unknown) => error,
    });
    if (outcome.isOk()) {
      return outcome.value.value;
    }
    return outcome.error instanceof BackfillHeldError
      ? "held"
      : panic("The batch failed instead of running or holding", outcome.error);
  } finally {
    await runtime.close();
  }
};

const runtimeConfigs = [
  ["scheduler backfill", schedulerBackfillConfig],
  ["coverage refresh", caseLawCoverageRefreshConfig],
] as const;

test.each(runtimeConfigs)(
  "an empty busy-window setting lets a %s run inside the default window",
  async (_name, runtimeConfig) => {
    const environment = { DB_LOAD_GATE_BUSY_WINDOWS: "[]" };
    expect(
      await runOneBatch(
        runtimeConfig(loadGateHealthConfig(environment)),
        IN_DEFAULT_BUSY_WINDOW,
      ),
    ).toBe("ran");
  },
);

test.each(runtimeConfigs)(
  "without a busy-window setting, the default window holds a %s",
  async (_name, runtimeConfig) => {
    const config = runtimeConfig(loadGateHealthConfig({}));
    expect(await runOneBatch(config, IN_DEFAULT_BUSY_WINDOW)).toBe("held");
    expect(await runOneBatch(config, OUTSIDE_DEFAULT_BUSY_WINDOW)).toBe("ran");
  },
);

test("an invalid online-index setting leaves the health config readable", () => {
  const environment = {
    DB_LOAD_GATE_BUSY_WINDOWS: "[]",
    ONLINE_INDEX_PARALLEL_WORKERS: "9",
  };
  expect(loadGateHealthConfig(environment).busyWindows).toEqual([]);
  expect(() => readOnlineIndexConfig(environment)).toThrow(ValiError);
});
