import { Result } from "better-result";
import { SQL } from "bun";
import { expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  BackfillFailedError,
  BackfillHeldError,
} from "@stll/db-load-gate/backfill-pass";
import type { Verdict } from "@stll/db-load-gate/health";
import { defaultConfig, initialBatchState } from "@stll/db-load-gate/health";

import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  createBackfillRuntime,
  createScriptBackfillRuntime,
  decodeCheckpoint,
} from "./backfill-runtime";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import type { Transaction } from "./root";

test.each([undefined, null, "unknown", {}, 4])(
  "an unrecognized checkpoint cause %p uses the legacy hold policy",
  (holdCause) => {
    const batch = { ...initialBatchState(defaultConfig), holdCause };
    expect(
      decodeCheckpoint({ cursor: "cursor", batch }).batch.holdCause,
    ).toBeNull();
    expect(
      decodeCheckpoint({ cursor: null, batch: { ...batch, heldSince: 10 } })
        .batch.holdCause,
    ).toBe("other");
  },
);

test.each([undefined, {}, 4, false])(
  "an invalid checkpoint cursor %p is rejected at the boundary",
  (cursor) => {
    expect(() =>
      decodeCheckpoint({ cursor, batch: initialBatchState(defaultConfig) }),
    ).toThrow("Invalid backfill checkpoint cursor");
  },
);

test.each(["load", "other"] as const)(
  "a recognized checkpoint cause %s is preserved",
  (holdCause) => {
    expect(
      decodeCheckpoint({
        cursor: "cursor",
        batch: {
          ...initialBatchState(defaultConfig),
          heldSince: 10,
          holdCause,
        },
      }),
    ).toMatchObject({
      cursor: "cursor",
      batch: { holdCause },
    });
  },
);

test.each([
  { size: 1, sleepMs: 1, expectedSize: 2, expectedSleepMs: 10 },
  { size: 20, sleepMs: 100, expectedSize: 10, expectedSleepMs: 20 },
])(
  "resuming size $size and sleep $sleepMs clamps the checkpoint before work",
  async ({ size, sleepMs, expectedSize, expectedSleepMs }) => {
    const config = {
      ...defaultConfig,
      minSize: 2,
      maxSize: 10,
      minSleepMs: 10,
      maxSleepMs: 20,
      busyWindows: [],
    };
    const records: unknown[] = [];
    let persisted: unknown;
    const checkpoint = {
      cursor: "resumed-cursor",
      batch: { ...initialBatchState(config), size, sleepMs },
    };
    const connection: OnlineMigrationConnection = {
      execute: async () => {},
      release: () => {},
      query: async (statement, parameters = []) => {
        if (statement.startsWith("SELECT cursor, batch")) {
          return [checkpoint];
        }
        if (statement.startsWith("UPDATE database_backfill_states")) {
          persisted = parameters.at(2);
        }
        return [{ acquired: true }];
      },
    };
    const runtime = createBackfillRuntime({
      connection,
      name: "resume-bounds",
      tableName: "rows",
      initialSize: 5,
      config,
      clock: () => 0,
      readVerdict: async () => ({ kind: "normal", signals: [] }),
      log: (record) => {
        records.push(record);
      },
    });
    try {
      const result = await runtime.step(async (batch) => {
        expect(batch.size).toBe(expectedSize);
        expect(batch.cursor).toBe("resumed-cursor");
        return { cursor: "next-cursor", done: false, value: batch.size };
      });
      expect(result.value).toBe(expectedSize);
      expect(result.cursor).toBe("next-cursor");
      expect(records).toContainEqual({
        action: "checkpoint_clamped",
        previous: { size, sleepMs },
        size: expectedSize,
        sleepMs: expectedSleepMs,
        config,
      });
      expect(typeof persisted).toBe("string");
      if (typeof persisted !== "string") {
        throw new TypeError("Expected a serialized persisted checkpoint");
      }
      expect(JSON.parse(persisted)).toMatchObject({
        size: expectedSize,
        sleepMs: config.minSleepMs,
      });
    } finally {
      await runtime.close();
    }
  },
);

test("observed completion clears a durable hold without reading load or running another batch", async () => {
  const config = { ...defaultConfig, minSize: 1, maxSize: 1, busyWindows: [] };
  const checkpoint = {
    cursor: "finished",
    batch: {
      ...initialBatchState(config),
      heldSince: 0,
      holdUntil: 30_000,
      holdCount: 1,
      holdCause: "load" as const,
    },
  };
  let persisted: unknown;
  const records: unknown[] = [];
  const runtime = createBackfillRuntime({
    name: "completed",
    reporting: "changes",
    tableName: "rows",
    initialSize: 1,
    config,
    clock: () => 60_000,
    readVerdict: async () => {
      throw new TypeError("completed work must not read load");
    },
    log: () => {},
    observeStatus: (record) => {
      records.push(record);
    },
    connection: {
      execute: async () => {},
      query: async (statement, parameters = []) => {
        if (statement.startsWith("SELECT cursor, batch")) {
          return [checkpoint];
        }
        if (statement.startsWith("UPDATE database_backfill_states")) {
          persisted = {
            cursor: parameters.at(1),
            batch: JSON.parse(String(parameters.at(2))),
          };
        }
        if (statement.includes("pg_try_advisory")) {
          throw new TypeError("completed work must not acquire a heavy slot");
        }
        return [];
      },
    },
  });
  try {
    await runtime.recordCompletion(async () => false);
    expect(persisted).toBeUndefined();
    expect(records).toEqual([]);
    await runtime.recordCompletion(async () => true);
    expect(persisted).toEqual({
      cursor: null,
      batch: initialBatchState(config),
    });
    expect(records).toEqual([]);
    await runtime.close();
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "backfill.resumed",
        BackfillYielded: 0,
        heldSince: null,
      }),
    );
  } finally {
    await runtime.close();
  }
});

test("a legacy checkpoint without a hold cause decodes without inventing a load latch", () => {
  const legacy = {
    size: 100,
    sleepMs: 100,
    smoothedDurationMs: null,
    stableBatches: 0,
    holdCount: 1,
    heldSince: 10,
    holdUntil: 20,
  };
  expect(legacy).not.toHaveProperty("holdCause");
  expect(decodeCheckpoint({ cursor: "legacy", batch: legacy })).toEqual({
    cursor: "legacy",
    batch: { ...legacy, holdCause: "other" },
  });
  expect(
    decodeCheckpoint({
      cursor: null,
      batch: { ...legacy, holdCount: 0, heldSince: null, holdUntil: null },
    }).batch.holdCause,
  ).toBeNull();
});

test.each(["default", "changes"] as const)(
  "%s reporting preserves its per-batch or quiet contract",
  async (reporting) => {
    const config = {
      ...defaultConfig,
      minSize: 1,
      maxSize: 2,
      busyWindows: [],
    };
    let checkpoint = decodeCheckpoint({
      cursor: null,
      batch: initialBatchState(config),
    });
    let now = 0;
    let verdict: Verdict = { kind: "normal", signals: [] };
    const decisions: unknown[] = [];
    const summaries: unknown[] = [];
    const runtime = createBackfillRuntime({
      name: "changing-policy",
      ...(reporting === "changes" ? { reporting } : {}),
      tableName: "rows",
      initialSize: 1,
      config,
      clock: () => now,
      readVerdict: async () => verdict,
      log: (record) => {
        decisions.push(record);
      },
      observeStatus: (record) => {
        summaries.push(record);
      },
      connection: {
        execute: async () => {},
        query: async (statement, parameters = []) => {
          if (statement.startsWith("SELECT cursor, batch")) {
            return [checkpoint];
          }
          if (statement.startsWith("UPDATE database_backfill_states")) {
            checkpoint = decodeCheckpoint({
              cursor: parameters.at(1),
              batch: JSON.parse(String(parameters.at(2))),
            });
          }
          return [{ acquired: true }];
        },
      },
    });
    const batch = async () => {
      now += 10;
      return { cursor: "next", done: false, value: 1 };
    };
    try {
      await runtime.step(batch);
      await runtime.step(batch);
      expect(decisions).toHaveLength(reporting === "changes" ? 1 : 6);
      if (reporting === "default") {
        expect(decisions).toContainEqual(
          expect.objectContaining({
            action: "run",
            lastDurationMs: 10,
            state: expect.objectContaining({
              size: 1,
              sleepMs: config.minSleepMs,
            }),
          }),
        );
      }
      verdict = { kind: "unknown", signals: [] };
      await expect(runtime.step(batch)).rejects.toBeInstanceOf(
        BackfillHeldError,
      );
      const held = checkpoint;
      await expect(runtime.step(batch)).rejects.toBeInstanceOf(
        BackfillHeldError,
      );
      expect(decisions).toHaveLength(reporting === "changes" ? 2 : 10);
      expect(summaries).toHaveLength(reporting === "changes" ? 0 : 4);
      await runtime.recordCompletion(async () => false);
      expect(checkpoint).toEqual(held);
      await runtime.recordCompletion(async () => true);
      expect(checkpoint.cursor).toBeNull();
      expect(checkpoint.batch.heldSince).toBeNull();
      await runtime.close();
      expect(summaries).toHaveLength(reporting === "changes" ? 1 : 5);
      expect(summaries.at(-1)).toMatchObject({
        BackfillYielded: 0,
        heldSince: null,
      });
      if (reporting === "changes") {
        expect(summaries.at(-1)).toMatchObject({
          transitionEvent: "backfill.yielded",
        });
      }
      await runtime.close();
      expect(summaries).toHaveLength(reporting === "changes" ? 1 : 5);
    } finally {
      await runtime.close();
    }
  },
);

test("a quiet multi-unit run retains its first resume transition in the final status", async () => {
  const config = { ...defaultConfig, minSize: 1, maxSize: 1, busyWindows: [] };
  let checkpoint = decodeCheckpoint({
    cursor: "held-cursor",
    batch: {
      ...initialBatchState(config),
      heldSince: 0,
      holdUntil: 1,
      holdCount: 1,
      holdCause: "other",
    },
  });
  const summaries: unknown[] = [];
  const runtime = createBackfillRuntime({
    name: "resuming-pass",
    tableName: "rows",
    initialSize: 1,
    reporting: "changes",
    config,
    clock: () => 100,
    readVerdict: async () => ({ kind: "normal", signals: [] }),
    log: () => {},
    observeStatus: (record) => {
      summaries.push(record);
    },
    connection: {
      execute: async () => {},
      query: async (statement, parameters = []) => {
        if (statement.startsWith("SELECT cursor, batch")) {
          return [checkpoint];
        }
        if (statement.startsWith("UPDATE database_backfill_states")) {
          checkpoint = decodeCheckpoint({
            cursor: parameters.at(1),
            batch: JSON.parse(String(parameters.at(2))),
          });
        }
        return [{ acquired: true }];
      },
    },
  });
  try {
    const batch = async () => ({ cursor: "continued", done: false, value: 1 });
    await runtime.step(batch);
    expect(checkpoint.batch.heldSince).toBeNull();
    await runtime.step(batch);
    await runtime.recordCompletion(async () => true);
    expect(summaries).toEqual([]);
    await runtime.close();
    expect(summaries).toEqual([
      expect.objectContaining({
        event: "backfill.resumed",
        transitionEvent: "backfill.resumed",
        BackfillYielded: 0,
        heldSince: null,
      }),
    ]);
  } finally {
    await runtime.close();
  }
});

for (const mode of ["database", "script"] as const) {
  test.each([undefined, "fail"] as const)(
    `${mode} timeout policy %p preserves its consumer contract`,
    async (statementTimeoutPolicy) => {
      const config = {
        ...defaultConfig,
        minSize: 1,
        maxSize: 1,
        busyWindows: [],
      };
      let checkpoint: unknown;
      const query = async (
        statement: string,
        parameters: readonly unknown[] = [],
      ) => {
        if (
          statement.startsWith("INSERT") ||
          statement.startsWith("UPDATE database_backfill_states")
        ) {
          const serialized = parameters.at(2);
          if (typeof serialized === "string") {
            const batch: unknown = JSON.parse(serialized);
            checkpoint = { cursor: parameters.at(1), batch };
          }
        }
        if (statement.startsWith("SELECT cursor, batch")) {return [checkpoint];}
        return [{ acquired: true }];
      };
      const options = {
        name: `timeout-contract-${mode}`,
        tableName: "rows",
        initialSize: 1,
        initialCursor: "saved",
        config,
        clock: () => 0,
        readVerdict: async () => ({ kind: "normal" as const, signals: [] }),
        log: () => undefined,
        ...(statementTimeoutPolicy === undefined
          ? {}
          : { statementTimeoutPolicy }),
      };
      const dialect = new PgDialect();
      const transaction = asTestRaw<Transaction>({
        execute: async (
          statement: Parameters<typeof dialect.sqlToQuery>[0],
        ) => {
          const rendered = dialect.sqlToQuery(statement);
          return await query(rendered.sql, rendered.params);
        },
      });
      const runtime =
        mode === "database"
          ? createBackfillRuntime({
              ...options,
              connection: { query, execute: async () => {} },
            })
          : createScriptBackfillRuntime({
              ...options,
              db: {
                transaction: async (work) => await work(transaction),
                execute: transaction.execute,
              },
              slot: { tryAcquire: async () => true, release: () => undefined },
            });
      const cause = new SQL.PostgresError("batch statement timeout", {
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "57014",
        detail: "",
        hint: "",
        severity: "ERROR",
      });
      try {
        const outcome = await Result.tryPromise({
          try: async () =>
            await runtime.step(async () => {
              throw cause;
            }),
          catch: (error: unknown) => error,
        });
        expect(outcome.isErr()).toBe(true);
        if (outcome.isErr()) {
          expect(outcome.error).toBeInstanceOf(
            statementTimeoutPolicy === "fail"
              ? BackfillFailedError
              : BackfillHeldError,
          );
          expect(outcome.error).toMatchObject({
            holdUntil: null,
            heldSince: null,
          });
          if (outcome.error instanceof BackfillFailedError)
            {expect(outcome.error.cause).toBe(cause);}
        }
        expect(checkpoint).toMatchObject({ cursor: "saved" });
      } finally {
        await runtime.close();
      }
    },
  );
}
