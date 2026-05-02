import { DrizzleQueryError } from "drizzle-orm";

type PgCause = { code?: unknown; errno?: unknown };

const hasPgCause = (cause: unknown): cause is PgCause =>
  cause !== null &&
  typeof cause === "object" &&
  ("code" in cause || "errno" in cause);

/**
 * Extracts the PostgreSQL SQLSTATE from a driver error. Bun's native
 * `Bun.sql` puts the SQLSTATE in `errno` and uses `code` for a generic
 * category like "ERR_POSTGRES_SERVER_ERROR"; pg/PGlite put the SQLSTATE
 * in `code` and leave `errno` undefined. Prefer `errno` so Bun-thrown
 * errors are recognized; fall back to `code` for pg/PGlite.
 */
const sqlStateFromCause = (cause: PgCause): string | undefined => {
  if (typeof cause.errno === "string") {
    return cause.errno;
  }
  if (typeof cause.code === "string") {
    return cause.code;
  }
  return undefined;
};

/**
 * Returns true when `error` is a Postgres error with the
 * given error code. Drizzle wraps the original driver
 * error (Bun `Bun.sql`, pg, or PGlite) as `.cause`.
 *
 * Common codes: see `PG_ERROR` below.
 */
export const isPgError = (error: unknown, code: string): boolean =>
  error instanceof DrizzleQueryError &&
  hasPgCause(error.cause) &&
  sqlStateFromCause(error.cause) === code;

export const getPgErrorCode = (error: unknown): string | undefined =>
  error instanceof DrizzleQueryError && hasPgCause(error.cause)
    ? sqlStateFromCause(error.cause)
    : undefined;

export const PG_ERROR = {
  DEADLOCK_DETECTED: "40P01",
  FOREIGN_KEY_VIOLATION: "23503",
  SERIALIZATION_FAILURE: "40001",
  UNIQUE_VIOLATION: "23505",
  INSUFFICIENT_PRIVILEGE: "42501",
} as const;
