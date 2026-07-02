import { describe, expect, it } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";

import { getPgErrorCode, isPgError, PG_ERROR, pgErrorFields } from "./pg-error";

const drizzleError = (cause: { errno?: string; code?: string }) =>
  new DrizzleQueryError(
    "query failed",
    [],
    Object.assign(new Error("pg"), cause),
  );

describe("getPgErrorCode", () => {
  it("reads SQLSTATE from `errno` (Bun.sql convention)", () => {
    const cause = {
      errno: "23505",
      code: "ERR_POSTGRES_SERVER_ERROR",
    };
    expect(getPgErrorCode(drizzleError(cause))).toBe("23505");
  });

  it("falls back to `code` (pg/PGlite convention)", () => {
    const cause = { code: "23505" };
    expect(getPgErrorCode(drizzleError(cause))).toBe("23505");
  });

  it("returns undefined when neither field is set", () => {
    expect(getPgErrorCode(drizzleError({}))).toBeUndefined();
  });

  it("returns undefined when error is not a DrizzleQueryError", () => {
    expect(getPgErrorCode(new Error("plain"))).toBeUndefined();
  });
});

describe("isPgError", () => {
  it("matches UNIQUE_VIOLATION via Bun's `errno`", () => {
    const cause = {
      errno: PG_ERROR.UNIQUE_VIOLATION,
      code: "ERR_POSTGRES_SERVER_ERROR",
    };
    expect(isPgError(drizzleError(cause), PG_ERROR.UNIQUE_VIOLATION)).toBe(
      true,
    );
  });

  it("matches UNIQUE_VIOLATION via pg/PGlite `code`", () => {
    const cause = { code: PG_ERROR.UNIQUE_VIOLATION };
    expect(isPgError(drizzleError(cause), PG_ERROR.UNIQUE_VIOLATION)).toBe(
      true,
    );
  });

  it("returns false for a different code", () => {
    const cause = { errno: PG_ERROR.UNIQUE_VIOLATION };
    expect(isPgError(drizzleError(cause), PG_ERROR.FOREIGN_KEY_VIOLATION)).toBe(
      false,
    );
  });
});

// Structural object mirroring the runtime shape of a Bun/pg PostgresError.
const pgCause = (fields: Record<string, string>): Error =>
  Object.assign(new Error("database error"), fields);

describe("pgErrorFields", () => {
  it("surfaces the SQLSTATE from a DrizzleQueryError-wrapped PostgresError", () => {
    const error = new DrizzleQueryError(
      "query failed",
      [],
      pgCause({
        code: "42803",
      }),
    );
    expect(pgErrorFields(error)["error.cause.pg_code"]).toBe("42803");
  });

  it("reads SQLSTATE from `errno` (Bun) over the generic `code` category", () => {
    const error = new DrizzleQueryError(
      "query failed",
      [],
      pgCause({
        errno: "23505",
        code: "ERR_POSTGRES_SERVER_ERROR",
      }),
    );
    expect(pgErrorFields(error)["error.cause.pg_code"]).toBe("23505");
  });

  it("emits schema identifiers but never row-bearing fields", () => {
    const error = new DrizzleQueryError(
      "query failed",
      [],
      pgCause({
        code: "23505",
        severity: "ERROR",
        constraint: "users_email_key",
        table: "users",
        column: "email",
        schema: "public",
        routine: "_bt_check_unique",
        detail: "Key (email)=(secret@example.com) already exists.",
        hint: "a hint that could echo values",
        where: "a plpgsql context line",
      }),
    );
    expect(pgErrorFields(error)).toEqual({
      "error.cause.pg_code": "23505",
      "error.cause.pg_severity": "ERROR",
      "error.cause.pg_constraint": "users_email_key",
      "error.cause.pg_table": "users",
      "error.cause.pg_column": "email",
      "error.cause.pg_schema": "public",
      "error.cause.pg_routine": "_bt_check_unique",
    });
  });

  it("ignores a Node system error whose `code` is not a SQLSTATE", () => {
    const sys = Object.assign(new Error("socket"), {
      code: "ECONNRESET",
      errno: "-54",
    });
    expect(pgErrorFields(sys)).toEqual({});
    expect(
      pgErrorFields(new DrizzleQueryError("query failed", [], sys)),
    ).toEqual({});
  });

  it("ignores five-letter Node system codes that fit the SQLSTATE shape", () => {
    // EPIPE/EPERM are five chars from the SQLSTATE alphabet; the digit
    // requirement and the syscall marker must each keep them out.
    const epipe = Object.assign(new Error("broken pipe"), {
      code: "EPIPE",
      errno: -32,
      syscall: "write",
    });
    expect(pgErrorFields(epipe)).toEqual({});
    expect(
      pgErrorFields(new DrizzleQueryError("query failed", [], epipe)),
    ).toEqual({});

    // Even without a syscall marker, an all-letter code is not a SQLSTATE.
    const eperm = Object.assign(new Error("not permitted"), {
      code: "EPERM",
    });
    expect(pgErrorFields(eperm)).toEqual({});
  });

  it("returns {} for a non-Postgres error and non-object input", () => {
    expect(pgErrorFields(new Error("plain"))).toEqual({});
    expect(pgErrorFields("boom")).toEqual({});
    expect(pgErrorFields(null)).toEqual({});
  });

  it("never throws on a hostile cause accessor", () => {
    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "cause", {
      get: () => {
        throw new Error("cause getter failed");
      },
    });
    expect(() => pgErrorFields(hostile)).not.toThrow();
    expect(pgErrorFields(hostile)).toEqual({});
  });
});
