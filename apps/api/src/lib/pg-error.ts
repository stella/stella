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

// A SQLSTATE is exactly five characters from the class/subclass alphabet
// (`0`-`9`, `A`-`Z`). Shape alone is not enough: five-letter Node system
// codes (`EPIPE`, `EPERM`) fit it too, so the check also requires at least
// one digit (every standard SQLSTATE contains one; Node codes are all
// letters) and `sqlStateOf` skips nodes carrying `syscall`, which every Node
// system error has and no Postgres driver error does.
const PG_SQLSTATE_PATTERN = /^(?=.*[0-9])[0-9A-Z]{5}$/u;

// Schema identifiers Postgres attaches to a server error. These name database
// objects, never row data, so they are safe to ship to a log sink. `detail`,
// `hint`, `where`, `internalQuery`, and `query` are deliberately excluded:
// they can embed the offending row's column values.
const PG_SAFE_STRING_FIELDS = [
  { key: "error.cause.pg_severity", property: "severity" },
  { key: "error.cause.pg_constraint", property: "constraint" },
  { key: "error.cause.pg_table", property: "table" },
  { key: "error.cause.pg_column", property: "column" },
  { key: "error.cause.pg_schema", property: "schema" },
  { key: "error.cause.pg_routine", property: "routine" },
] as const;

const MAX_CAUSE_DEPTH = 6;

const readProperty = (value: object, key: string): unknown => {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
};

const readNonEmptyString = (value: object, key: string): string | undefined => {
  const raw = readProperty(value, key);
  return typeof raw === "string" && raw !== "" ? raw : undefined;
};

// Returns a node's SQLSTATE when it is shaped like a Postgres driver error.
// Bun's `Bun.sql` puts the SQLSTATE in `errno` (`code` is a generic category);
// pg/PGlite put it in `code`. Prefer `errno`, fall back to `code`, and require
// the SQLSTATE shape so non-Postgres codes are ignored.
const sqlStateOf = (node: object): string | undefined => {
  if (readProperty(node, "syscall") !== undefined) {
    return undefined;
  }
  const errno = readNonEmptyString(node, "errno");
  if (errno !== undefined && PG_SQLSTATE_PATTERN.test(errno)) {
    return errno;
  }
  const code = readNonEmptyString(node, "code");
  if (code !== undefined && PG_SQLSTATE_PATTERN.test(code)) {
    return code;
  }
  return undefined;
};

type PgErrorNode = { error: object; sqlState: string };

const findPgErrorNode = (error: unknown): PgErrorNode | undefined => {
  const seen = new WeakSet<object>();
  let current: unknown = error;
  let depth = 0;
  while (
    current !== null &&
    typeof current === "object" &&
    depth < MAX_CAUSE_DEPTH &&
    !seen.has(current)
  ) {
    seen.add(current);
    const sqlState = sqlStateOf(current);
    if (sqlState !== undefined) {
      return { error: current, sqlState };
    }
    current = readProperty(current, "cause");
    depth += 1;
  }
  return undefined;
};

/**
 * Extract safe, structured fields from a Postgres driver error anywhere in an
 * error's `.cause` chain, for observability. Drizzle wraps the driver error
 * (`DrizzleQueryError`), so on a failed query the SQLSTATE lives one or more
 * `.cause` hops down and would otherwise never reach the log sink.
 *
 * Returns the SQLSTATE under `error.cause.pg_code` plus any present schema
 * identifiers (severity, constraint, table, column, schema, routine). Every
 * key is chosen to NOT match the logger's PII redaction regex, so the fields
 * survive `sanitizeLogAttributes`. Returns `{}` when no Postgres error is
 * found. Never throws: property access is fully guarded.
 */
export const pgErrorFields = (error: unknown): Record<string, string> => {
  const node = findPgErrorNode(error);
  if (node === undefined) {
    return {};
  }

  const fields: Record<string, string> = {
    "error.cause.pg_code": node.sqlState,
  };
  for (const { key, property } of PG_SAFE_STRING_FIELDS) {
    const value = readNonEmptyString(node.error, property);
    if (value !== undefined) {
      fields[key] = value;
    }
  }
  return fields;
};
