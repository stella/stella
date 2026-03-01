import { DrizzleQueryError } from "drizzle-orm";

/**
 * Returns true when `error` is a Postgres constraint violation with the
 * given error code. Useful for catching specific constraint errors without
 * swallowing unrelated exceptions.
 *
 * Common codes:
 *   23503 — foreign_key_violation
 *   23505 — unique_violation
 */
export const isPgError = (error: unknown, code: string): boolean =>
  error instanceof DrizzleQueryError &&
  error.cause !== null &&
  typeof error.cause === "object" &&
  "code" in error.cause &&
  error.cause.code === code;

export const PG_ERROR = {
  FOREIGN_KEY_VIOLATION: "23503",
  UNIQUE_VIOLATION: "23505",
} as const;
