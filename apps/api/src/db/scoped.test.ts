import { Result, UnhandledException } from "better-result";
import { describe, expect, it } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";

import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import {
  DatabaseError,
  DatabaseRlsError,
} from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

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
