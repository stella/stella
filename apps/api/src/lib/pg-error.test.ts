import { describe, expect, it } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";

import { getPgErrorCode, isPgError, PG_ERROR } from "./pg-error";

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
