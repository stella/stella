import { SQL } from "bun";
import { describe, expect, it } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";

import { DatabaseError } from "./errors/tagged-errors";
import {
  getPgErrorCode,
  isPgConstraintError,
  isPgError,
  isTransientPgConnectionError,
  PG_DRIVER_ERROR,
  PG_ERROR,
  pgErrorFields,
} from "./pg-error";

const drizzleError = (cause: {
  errno?: string;
  code?: string;
  constraint?: string;
}) =>
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

  it("returns undefined when the cause chain carries no SQLSTATE", () => {
    expect(getPgErrorCode(new Error("plain"))).toBeUndefined();
  });
});

describe("isPgConstraintError", () => {
  it("does not confuse another unique constraint with the requested one", () => {
    const error = drizzleError({
      errno: PG_ERROR.UNIQUE_VIOLATION,
      constraint: "case_law_decisions_source_document_idx",
    });

    expect(
      isPgConstraintError(
        error,
        PG_ERROR.UNIQUE_VIOLATION,
        "case_law_decisions_slug_uidx",
      ),
    ).toBe(false);
    expect(
      isPgConstraintError(
        error,
        PG_ERROR.UNIQUE_VIOLATION,
        "case_law_decisions_source_document_idx",
      ),
    ).toBe(true);
  });

  it("matches the constraint on an inner driver error", () => {
    const constraint = "case_law_decisions_slug_uidx";
    const driver = Object.assign(new Error("database error"), {
      errno: PG_ERROR.UNIQUE_VIOLATION,
      constraint,
    });
    const error = new DatabaseError({
      message: "Database query failed",
      code: PG_ERROR.UNIQUE_VIOLATION,
      cause: driver,
    });

    expect(
      isPgConstraintError(error, PG_ERROR.UNIQUE_VIOLATION, constraint),
    ).toBe(true);
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

// The transaction lifecycle runs through the client's own `begin`, so a
// failure acquiring a connection or running BEGIN/COMMIT/ROLLBACK never
// passes through the prepared-query wrapper and arrives in this shape.
describe("driver errors that reached the caller unwrapped", () => {
  it("reads the SQLSTATE Bun reports in `errno`", () => {
    const error = pgCause({
      errno: PG_ERROR.SERIALIZATION_FAILURE,
      code: "ERR_POSTGRES_SERVER_ERROR",
    });

    expect(getPgErrorCode(error)).toBe(PG_ERROR.SERIALIZATION_FAILURE);
    expect(isPgError(error, PG_ERROR.SERIALIZATION_FAILURE)).toBe(true);
  });

  it("matches a constraint alongside the SQLSTATE", () => {
    const error = pgCause({
      errno: PG_ERROR.UNIQUE_VIOLATION,
      constraint: "case_law_decisions_slug_uidx",
    });

    expect(
      isPgConstraintError(
        error,
        PG_ERROR.UNIQUE_VIOLATION,
        "case_law_decisions_slug_uidx",
      ),
    ).toBe(true);
    expect(
      isPgConstraintError(
        error,
        PG_ERROR.UNIQUE_VIOLATION,
        "case_law_decisions_source_document_idx",
      ),
    ).toBe(false);
  });

  it("reads through a wrapper that is not a DrizzleQueryError", () => {
    const error = Object.assign(new Error("transaction failed"), {
      cause: pgCause({ code: PG_ERROR.DEADLOCK_DETECTED }),
    });

    expect(getPgErrorCode(error)).toBe(PG_ERROR.DEADLOCK_DETECTED);
  });

  it("still ignores a connection error carrying no SQLSTATE", () => {
    const error = Object.assign(new Error("socket"), {
      code: "ECONNRESET",
      errno: -54,
      syscall: "read",
    });

    expect(getPgErrorCode(error)).toBeUndefined();
    expect(isPgError(error, PG_ERROR.UNIQUE_VIOLATION)).toBe(false);
  });
});

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

  it("continues past SQLSTATE-only wrappers to collect driver schema identifiers", () => {
    const driver = pgCause({
      code: "23505",
      severity: "ERROR",
      constraint: "users_email_key",
      table: "users",
      column: "email",
    });
    const drizzle = new DrizzleQueryError("query failed", [], driver);
    const databaseError = Object.assign(new Error("Database query failed"), {
      code: "23505",
      cause: drizzle,
    });

    expect(pgErrorFields(databaseError)).toEqual({
      "error.cause.pg_code": "23505",
      "error.cause.pg_severity": "ERROR",
      "error.cause.pg_constraint": "users_email_key",
      "error.cause.pg_table": "users",
      "error.cause.pg_column": "email",
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

describe("PG_DRIVER_ERROR", () => {
  /**
   * Pinned as literals rather than derived from the map, because
   * `isTransientPgConnectionError` matches on exactly these values: a test
   * that spelled them `PG_DRIVER_ERROR.IDLE_TIMEOUT` would agree with a typo
   * and stay green while production stopped matching. The whole object is
   * asserted so a rename, a removal, or a silent addition all fail here.
   *
   * Source: Bun's documented connection-error codes (`runtime/sql`), and
   * `CONNECTION_CLOSED` is additionally pinned against the live runtime by
   * the integration test below.
   */
  it("matches the driver's documented connection-error codes", () => {
    expect(PG_DRIVER_ERROR).toEqual({
      CONNECTION_CLOSED: "ERR_POSTGRES_CONNECTION_CLOSED",
      CONNECTION_FAILED: "ERR_POSTGRES_CONNECTION_FAILED",
      CONNECTION_TIMEOUT: "ERR_POSTGRES_CONNECTION_TIMEOUT",
      IDLE_TIMEOUT: "ERR_POSTGRES_IDLE_TIMEOUT",
      LIFETIME_TIMEOUT: "ERR_POSTGRES_LIFETIME_TIMEOUT",
    });
  });
});

describe("isTransientPgConnectionError", () => {
  it("reads a hand-built driver error through the cause chain", () => {
    const retired = Object.assign(new Error("Idle timeout reached after 2m"), {
      name: "PostgresError",
      code: PG_DRIVER_ERROR.IDLE_TIMEOUT,
    });
    expect(isTransientPgConnectionError(retired)).toBe(true);
    expect(
      isTransientPgConnectionError(
        new DrizzleQueryError("query failed", [], retired),
      ),
    ).toBe(true);
  });

  /**
   * Total over the map rather than a list of examples, so a code added to
   * `PG_DRIVER_ERROR` without the predicate recognising it fails here.
   */
  it("classifies every connection-lifecycle code, bare or wrapped", () => {
    for (const code of Object.values(PG_DRIVER_ERROR)) {
      const failure = Object.assign(new Error("connection gone"), {
        name: "PostgresError",
        code,
      });
      expect(isTransientPgConnectionError(failure)).toBe(true);
      expect(
        isTransientPgConnectionError(
          new DrizzleQueryError("query failed", [], failure),
        ),
      ).toBe(true);
    }
  });

  it("does not match a query the server rejected", () => {
    expect(
      isTransientPgConnectionError(
        drizzleError({ errno: "23505", code: "ERR_POSTGRES_SERVER_ERROR" }),
      ),
    ).toBe(false);
  });

  /**
   * The load-bearing test for this predicate, and the only one that touches a
   * value this repo does not author: it drives the real `Bun.sql` pool against
   * a socket that accepts and closes before the Postgres handshake, then
   * asserts against whatever the driver actually threw.
   *
   * Two things are verified that a synthetic fixture cannot. First, that
   * whatever code the driver really emits is one this predicate recognises, so
   * a rename or a new member fails here rather than in production. Second,
   * that the driver's `message` does NOT contain its own type name — which is
   * precisely why matching `message` for `"PostgresError"` never fired, and
   * why this predicate reads `code` instead.
   *
   * The exact member is deliberately not asserted. This scenario surfaces as
   * `CONNECTION_FAILED` on Bun 1.4 (accepted, then closed before the
   * handshake, retried until `connectionTimeout`) and as `CONNECTION_CLOSED`
   * on 1.3, so pinning one would test the driver's version rather than this
   * predicate. Membership plus the classification is the stable claim.
   */
  it("classifies an error the live Bun driver actually threw", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => {
          socket.end();
        },
        data: () => {},
        close: () => {},
      },
    });
    const sql = new SQL({
      url: `postgres://user:pass@127.0.0.1:${server.port}/db`,
      max: 1,
      connectionTimeout: 1,
    });

    const failure = await Promise.resolve(sql`select 1`).then(
      () => undefined,
      (error: unknown) => error,
    );
    server.stop(true);
    await sql.end();

    // Doubles as the assertion that the driver rejected at all, and narrows
    // the caught value without asserting a shape onto it.
    if (!(failure instanceof Error)) {
      throw new Error(`expected a driver rejection, got ${String(failure)}`);
    }
    const code = "code" in failure ? failure.code : undefined;
    if (typeof code !== "string") {
      throw new TypeError(`expected a driver error code, got ${String(code)}`);
    }
    // Widened so the assertion compares runtime strings rather than narrowing
    // the argument to the map's own literal union.
    const lifecycleCodes: readonly string[] = Object.values(PG_DRIVER_ERROR);
    expect(lifecycleCodes).toContain(code);
    expect(failure.message).not.toContain("PostgresError");
    expect(isTransientPgConnectionError(failure)).toBe(true);
  });
});
