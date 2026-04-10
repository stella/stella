import { DrizzleQueryError } from "drizzle-orm";

type PgCause = { code: string };

const hasPgCause = (cause: unknown): cause is PgCause =>
  cause !== null &&
  typeof cause === "object" &&
  "code" in cause &&
  typeof cause.code === "string";

/**
 * Returns true when `error` is a Postgres error with the
 * given error code. Drizzle wraps the original driver
 * error (pg `DatabaseError` or PGlite equivalent) as
 * `.cause`; we duck-type the `code` property so this
 * works with both drivers.
 *
 * Common codes: see `PG_ERROR` below.
 */
export const isPgError = (error: unknown, code: string): boolean =>
  error instanceof DrizzleQueryError &&
  hasPgCause(error.cause) &&
  error.cause.code === code;

export const getPgErrorCode = (error: unknown): string | undefined =>
  error instanceof DrizzleQueryError && hasPgCause(error.cause)
    ? error.cause.code
    : undefined;

export const PG_ERROR = {
  DEADLOCK_DETECTED: "40P01",
  FOREIGN_KEY_VIOLATION: "23503",
  SERIALIZATION_FAILURE: "40001",
  UNIQUE_VIOLATION: "23505",
  INSUFFICIENT_PRIVILEGE: "42501",
} as const;
