import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
import { integer, pgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  PUBLIC_READ_STATEMENT_TIMEOUT_MS,
  setSharedTransactionTimeouts,
  withSharedStatementTimeout,
  withSharedTransactionTimeoutRestoration,
} from "@/api/db/shared-pool-timeouts";
import { executedRows } from "@/api/lib/db/executed-rows";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { PublicLawStatementError } from "@/api/lib/legal-search/public-law-statement-error";
import { publicReadTimeoutError } from "@/api/lib/legal-search/public-read-timeout";
import { runWithPublicReadStatementTimeout } from "@/api/lib/legal-search/public-read-timeout-context";
import { getPgErrorCode } from "@/api/lib/pg-error";
import {
  configureReadTransaction,
  EXTERNAL_PUBLIC_LAW_READ_GUARDS,
  observePublicLawReadTransaction,
} from "@/api/lib/public-law-read-db";
import { isRecord } from "@/api/lib/type-guards";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/** The real PostgreSQL settings must match the public-read transaction guard. */

const readSetting = async (
  tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
  setting: string,
): Promise<string> => {
  const [row] = executedRows(
    await tx.execute(sql`SELECT current_setting(${setting}) AS value`),
  );
  return isRecord(row) ? String(row["value"]) : "";
};

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
const observationProbe = pgTable("public_law_observation_probe", {
  value: integer("value"),
});

beforeAll(async () => {
  client = await createTestPglite();
  await client.exec(
    "CREATE TABLE public_law_observation_probe (value integer NOT NULL)",
  );
  await client.exec(
    "INSERT INTO public_law_observation_probe (value) VALUES (1)",
  );
  db = drizzle({ client });
});

afterAll(async () => {
  await client.close();
});

test("the public read is read-only and bounded", async () => {
  const settings = await db.transaction(async (tx) => {
    await configureReadTransaction(
      tx,
      "read-committed",
      EXTERNAL_PUBLIC_LAW_READ_GUARDS,
    );
    return {
      readOnly: await readSetting(tx, "transaction_read_only"),
      statementTimeout: await readSetting(tx, "statement_timeout"),
      lockTimeout: await readSetting(tx, "lock_timeout"),
      idleTimeout: await readSetting(tx, "idle_in_transaction_session_timeout"),
    };
  });

  expect(settings).toEqual({
    readOnly: "on",
    statementTimeout: "30s",
    lockTimeout: "1s",
    idleTimeout: "30s",
  });
});

test("an awaited select builder returns its query rows", async () => {
  const rows = await db.transaction(
    async (tx) =>
      await observePublicLawReadTransaction(asTestRaw<Transaction>(tx))
        .select({ value: observationProbe.value })
        .from(observationProbe),
  );

  expect(rows).toEqual([{ value: 1 }]);
});

test("a select builder finally handler preserves its resolved rows", async () => {
  const rows = await db.transaction(async (transaction) => {
    const query = observePublicLawReadTransaction(
      asTestRaw<Transaction>(transaction),
    )
      .select({ value: observationProbe.value })
      .from(observationProbe);
    return await query.finally(() => undefined);
  });

  expect(rows).toEqual([{ value: 1 }]);
});

test("a slow select logs its source callsite and duration", async () => {
  const now = spyOn(performance, "now");
  const logs = installRecordingLogger();
  try {
    now.mockReturnValueOnce(0).mockReturnValueOnce(1001);
    const rows = await db.transaction(
      async (transaction) =>
        await observePublicLawReadTransaction(
          asTestRaw<Transaction>(transaction),
        )
          .select({ value: observationProbe.value })
          .from(observationProbe),
    );

    expect(rows).toEqual([{ value: 1 }]);
    const slow = logs
      .at("WARN")
      .find(({ message }) =>
        message.includes("public_law.read_statement_slow"),
      );
    expect(slow?.attributes).toEqual(
      expect.objectContaining({
        "statement.callsite": expect.stringContaining(
          "public-law-read-db.db.test.ts",
        ),
        durationMs: expect.any(Number),
      }),
    );
  } finally {
    now.mockRestore();
    logs.restore();
  }
});

test("a prepared select executes through the observation wrapper", async () => {
  const rows = await db.transaction(
    async (transaction) =>
      await observePublicLawReadTransaction(asTestRaw<Transaction>(transaction))
        .select({ value: observationProbe.value })
        .from(observationProbe)
        .prepare("public_law_observation_probe")
        .execute(),
  );

  expect(rows).toEqual([{ value: 1 }]);
});

test("raw execution preserves getSQL and execute methods", async () => {
  const rows = await db.transaction(async (transaction) => {
    const raw = observePublicLawReadTransaction(
      asTestRaw<Transaction>(transaction),
    ).execute(sql`SELECT 1 AS value`);
    expect(raw.getSQL()).toBeDefined();
    return await raw.execute();
  });

  expect(executedRows(rows)).toEqual([{ value: 1 }]);
});

test.each(["await", "execute", "catch", "finally"] as const)(
  "raw statement failures retain public provenance through %s",
  async (entry) => {
    const outcome = await Result.tryPromise(() =>
      db.transaction(async (transaction) => {
        const query = observePublicLawReadTransaction(
          asTestRaw<Transaction>(transaction),
        ).execute(sql`SELECT missing_column FROM public_law_observation_probe`);
        switch (entry) {
          case "await":
            return await query;
          case "execute":
            return await query.execute();
          case "catch":
            return await query.catch((error: unknown) =>
              abortTransaction(error),
            );
          case "finally":
            return await query.finally(() => undefined);
          default:
            entry satisfies never;
            panic("Unexpected statement entry", entry);
        }
      }),
    );
    expect(Result.isError(outcome)).toBe(true);
    if (Result.isError(outcome)) {
      expect(outcome.error.cause).toBeInstanceOf(PublicLawStatementError);
      expect(getPgErrorCode(outcome.error)).toBe("42703");
    }
  },
);

test("a caught select cancellation is logged", async () => {
  const logs = installRecordingLogger();
  const cancelled = Object.assign(new Error("cancelled"), { code: "57014" });
  try {
    const result = await db.transaction(async (transaction) => {
      const selection = transaction.select({ value: observationProbe.value });
      const query = selection.from(observationProbe);
      const executeSpy = spyOn(query, "execute").mockRejectedValue(cancelled);
      const fromSpy = spyOn(selection, "from").mockReturnValue(query);
      const selectSpy = spyOn(transaction, "select").mockReturnValue(selection);
      try {
        const observedQuery = observePublicLawReadTransaction(
          asTestRaw<Transaction>(transaction),
        )
          .select({ value: observationProbe.value })
          .from(observationProbe);
        return await observedQuery.catch((error: unknown) => error);
      } finally {
        executeSpy.mockRestore();
        fromSpy.mockRestore();
        selectSpy.mockRestore();
      }
    });

    expect(result).toMatchObject({
      _tag: "PublicLawStatementError",
      message: "Public-law statement failed",
      cause: cancelled,
    });
    expect(getPgErrorCode(result)).toBe("57014");
    const timeout = runWithPublicReadStatementTimeout(
      PUBLIC_READ_STATEMENT_TIMEOUT_MS.browse,
      () => publicReadTimeoutError(result),
    );
    expect(timeout).toMatchObject({ status: 503, code: "PUBLIC_READ_TIMEOUT" });
    expect(publicReadTimeoutError(result)).toBeNull();
    const cancellation = logs
      .at("WARN")
      .find(({ message }) =>
        message.includes("public_law.read_statement_cancelled"),
      );
    expect(cancellation?.attributes).toEqual(
      expect.objectContaining({
        "statement.callsite": expect.stringContaining(
          "public-law-read-db.db.test.ts",
        ),
        durationMs: expect.any(Number),
      }),
    );
  } finally {
    logs.restore();
  }
});

test("nested query budgets restore the prior tighter budget", async () => {
  await db.transaction(async (tx) => {
    await configureReadTransaction(
      tx,
      "read-committed",
      EXTERNAL_PUBLIC_LAW_READ_GUARDS,
    );
    expect(await readSetting(tx, "statement_timeout")).toBe("30s");
    await withSharedStatementTimeout(tx, 3000, async () => {
      expect(await readSetting(tx, "statement_timeout")).toBe("3s");
      await withSharedStatementTimeout(tx, 10_000, async () => {
        expect(await readSetting(tx, "statement_timeout")).toBe("3s");
      });
      expect(await readSetting(tx, "statement_timeout")).toBe("3s");
    });
    expect(await readSetting(tx, "statement_timeout")).toBe("30s");
  });
});

test.each([
  { statementTimeoutMs: 0, lockTimeoutMs: 0 },
  { statementTimeoutMs: 2000, lockTimeoutMs: 1000 },
  { statementTimeoutMs: 0, lockTimeoutMs: 1000 },
  { statementTimeoutMs: 2000, lockTimeoutMs: 0 },
])(
  "combined query budgets restore captured settings $statementTimeoutMs/$lockTimeoutMs",
  async (previous) => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT
      set_config('statement_timeout', ${`${previous.statementTimeoutMs}ms`}, true),
      set_config('lock_timeout', ${`${previous.lockTimeoutMs}ms`}, true)`);
      const statementTimeout = await readSetting(tx, "statement_timeout");
      const lockTimeout = await readSetting(tx, "lock_timeout");
      await withSharedTransactionTimeoutRestoration(tx, async (captured) => {
        expect(captured).toEqual(previous);
        await setSharedTransactionTimeouts(tx, {
          statementTimeoutMs: 100,
          lockTimeoutMs: 50,
        });
        expect(await readSetting(tx, "statement_timeout")).toBe("100ms");
        expect(await readSetting(tx, "lock_timeout")).toBe("50ms");
      });
      expect(await readSetting(tx, "statement_timeout")).toBe(statementTimeout);
      expect(await readSetting(tx, "lock_timeout")).toBe(lockTimeout);
    });
  },
);

test("a failed nested read restores its budget when the transaction remains usable", async () => {
  await db.transaction(async (tx) => {
    await configureReadTransaction(
      tx,
      "read-committed",
      EXTERNAL_PUBLIC_LAW_READ_GUARDS,
    );
    const rejection: unknown = await withSharedStatementTimeout(
      tx,
      3000,
      async () => {
        expect(await readSetting(tx, "statement_timeout")).toBe("3s");
        throw new Error("nested read failed");
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection instanceof Error ? rejection.message : rejection).toBe(
      "nested read failed",
    );
    expect(await readSetting(tx, "statement_timeout")).toBe("30s");
  });
});

test("a cancelled statement keeps its original error if its transaction rejects restoration", async () => {
  const timeout = new Error("statement timed out");
  let executions = 0;
  const transaction = {
    execute: async () => {
      executions += 1;
      if (executions === 1) {
        return [{ statement_timeout: "30s" }];
      }
      if (executions === 2) {
        return [];
      }
      throw new Error("transaction is aborted");
    },
  };
  const rejection: unknown = await withSharedStatementTimeout(
    transaction,
    3000,
    async () => {
      throw timeout;
    },
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection).toBe(timeout);
  expect(executions).toBe(3);
});

test("repeatable read binds the snapshot and stays read-only", async () => {
  const isolation = await db.transaction(async (tx) => {
    await configureReadTransaction(
      tx,
      "repeatable-read",
      EXTERNAL_PUBLIC_LAW_READ_GUARDS,
    );
    return {
      level: await readSetting(tx, "transaction_isolation"),
      readOnly: await readSetting(tx, "transaction_read_only"),
    };
  });

  expect(isolation).toEqual({ level: "repeatable read", readOnly: "on" });
});

test("a configured transaction refuses to write", async () => {
  const write = db.transaction(async (tx) => {
    await configureReadTransaction(
      tx,
      "read-committed",
      EXTERNAL_PUBLIC_LAW_READ_GUARDS,
    );
    await tx.execute(
      sql`CREATE TEMPORARY TABLE public_law_write_probe (id int)`,
    );
  });

  const failure = await write.then(
    () => null,
    (error: unknown) => error,
  );

  expect(isRecord(failure)).toBe(true);
  expect(String(isRecord(failure) ? failure["cause"] : "")).toContain(
    "read-only transaction",
  );
});

test("the guards last no longer than the transaction", async () => {
  await db.transaction(async (tx) => {
    await configureReadTransaction(
      tx,
      "read-committed",
      EXTERNAL_PUBLIC_LAW_READ_GUARDS,
    );
  });

  expect(await readSetting(db, "transaction_read_only")).toBe("off");
  expect(await readSetting(db, "statement_timeout")).not.toBe("30s");
});
