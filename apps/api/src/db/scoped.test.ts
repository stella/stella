import { Result, UnhandledException } from "better-result";
import { describe, expect, it, spyOn } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { WORKSPACE_ACCESS_MODE } from "@/api/db/rls";
import {
  createSafeDb,
  markRlsDatabase,
  reportOverDeadline,
  setScopedTransactionSettings,
  TRANSACTION_DEADLINE,
  TRANSACTION_DEADLINE_MODE,
} from "@/api/db/scoped";
import type { TransactionDeadline } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import {
  DatabaseError,
  DatabaseRlsError,
} from "@/api/lib/errors/tagged-errors";
import { errorSystemFields } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { PG_ERROR } from "@/api/lib/pg-error";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * A transaction that fails before its callback runs.
 *
 * Only a failure raised during prepared-query execution reaches the caller
 * inside a `DrizzleQueryError`; the transaction lifecycle surfaces the bare
 * driver error. `COMMIT` is part of that lifecycle, and it is where Postgres
 * reports deferred constraint violations and serialization failures.
 */
const rejectingTransaction = (error: unknown) => (): never => {
  throw error;
};

const rejectingDb = (error: unknown) =>
  markRlsDatabase({ transaction: rejectingTransaction(error) });

/** Runtime shape of a driver error, with no wrapper around it. */
const driverError = (fields: Record<string, string>): Error =>
  Object.assign(new Error("database error"), fields);

/** The transaction fails before the callback can run. */
const unreachableCallback = (): never => {
  throw new TypeError("The transaction callback must not run");
};

const failedTransaction = async (error: unknown) => {
  const outcome = await createSafeDb(
    rejectingDb(error),
    [createSafeId<"workspace">()],
    mintAuthProviderId<"organization">(),
    mintAuthProviderId<"user">(),
  )(unreachableCallback);

  if (!Result.isError(outcome)) {
    throw new TypeError("Expected the transaction to fail");
  }
  return outcome.error;
};

describe("createSafeDb failure classification", () => {
  it("classifies an unwrapped driver error by its SQLSTATE", async () => {
    const error = await failedTransaction(
      driverError({
        errno: PG_ERROR.SERIALIZATION_FAILURE,
        code: "ERR_POSTGRES_SERVER_ERROR",
      }),
    );

    // `defaultDatabaseRetry` retries a serialization failure, and can only see
    // one that arrives as a `DatabaseError` carrying its SQLSTATE.
    expect(DatabaseError.is(error)).toBe(true);
    if (!DatabaseError.is(error)) {
      throw new TypeError("Expected a DatabaseError");
    }
    expect(error.code).toBe(PG_ERROR.SERIALIZATION_FAILURE);
    expect(errorSystemFields(error)["error.cause.pg_driver_code"]).toBe(
      "ERR_POSTGRES_SERVER_ERROR",
    );
  });

  it("preserves a bare Bun idle code without SQLSTATE", async () => {
    const error = await failedTransaction(
      driverError({ code: "ERR_POSTGRES_IDLE_TIMEOUT" }),
    );

    expect(DatabaseError.is(error)).toBe(true);
    if (!DatabaseError.is(error)) {
      throw new TypeError("Expected a DatabaseError");
    }
    expect(error.code).toBeUndefined();
    expect(errorSystemFields(error)["error.cause.pg_driver_code"]).toBe(
      "ERR_POSTGRES_IDLE_TIMEOUT",
    );
  });

  it("classifies an unwrapped privilege rejection as an RLS failure", async () => {
    const error = await failedTransaction(
      driverError({ errno: PG_ERROR.INSUFFICIENT_PRIVILEGE }),
    );

    expect(DatabaseRlsError.is(error)).toBe(true);
  });

  it("classifies a query failure that carries no SQLSTATE", async () => {
    const error = await failedTransaction(
      new DrizzleQueryError("query failed", [], new Error("socket closed")),
    );

    expect(DatabaseError.is(error)).toBe(true);
    if (!DatabaseError.is(error)) {
      throw new TypeError("Expected a DatabaseError");
    }
    expect(error.code).toBeUndefined();
  });

  it("leaves a non-database failure unhandled", async () => {
    const error = await failedTransaction(new Error("not a database failure"));

    expect(UnhandledException.is(error)).toBe(true);
  });
});

type SettingsTransaction = Parameters<
  typeof setScopedTransactionSettings
>[0]["tx"];

describe("scoped transaction deadline", () => {
  const dialect = new PgDialect();
  /** A transaction that records the settings statements it is sent. */
  const recordingTransaction = () => {
    const statements: string[] = [];
    const tx = {
      execute: async (query: SQL) => {
        statements.push(dialect.sqlToQuery(query).sql);
        return await Promise.resolve([]);
      },
    };
    return { statements, tx: asTestRaw<SettingsTransaction>(tx) };
  };
  const settingsFor = async (deadline?: TransactionDeadline) => {
    const { statements, tx } = recordingTransaction();
    await setScopedTransactionSettings({
      tx,
      organizationId: mintAuthProviderId<"organization">(),
      userId: mintAuthProviderId<"user">(),
      workspaceScope: {
        type: WORKSPACE_ACCESS_MODE.explicit,
        workspaceIds: [createSafeId<"workspace">()],
      },
      featureIds: [],
      ...(deadline === undefined ? {} : { deadline }),
    });
    return statements;
  };

  const enforced: TransactionDeadline = {
    timeoutMs: TRANSACTION_DEADLINE.request.timeoutMs, // timeout under test
    mode: TRANSACTION_DEADLINE_MODE.enforce,
  };

  it("sets an enforced deadline in the same statement as its scope", async () => {
    const statements = await settingsFor(enforced);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("set_config('role'");
    expect(statements[0]).toContain("set_config('transaction_timeout'");
  });

  it("only observes a request's deadline, and sets none for background work", async () => {
    for (const deadline of [TRANSACTION_DEADLINE.request, undefined]) {
      const statements = await settingsFor(deadline);
      expect(statements.join("\n")).not.toContain("transaction_timeout");
    }
  });

  it("reports a transaction that ran past its deadline, and nothing else", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const { timeoutMs } = TRANSACTION_DEADLINE.request;
      reportOverDeadline({ deadline: undefined, elapsedMs: timeoutMs * 2 });
      reportOverDeadline({
        deadline: TRANSACTION_DEADLINE.request,
        elapsedMs: timeoutMs,
      });
      expect(warn).not.toHaveBeenCalled();
      reportOverDeadline({
        deadline: TRANSACTION_DEADLINE.request,
        elapsedMs: timeoutMs + 1,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toBe(
        "database.transaction_over_deadline",
      );
    } finally {
      warn.mockRestore();
    }
  });
});
