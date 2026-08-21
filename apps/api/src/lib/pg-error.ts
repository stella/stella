// A SQLSTATE is exactly five characters from the class/subclass alphabet
// (`0`-`9`, `A`-`Z`). Shape alone is not enough: five-letter Node system
// codes (`EPIPE`, `EPERM`) fit it too, so the check also requires at least
// one digit (every standard SQLSTATE contains one; Node codes are all
// letters) and `sqlStateOf` skips nodes carrying `syscall`, which every Node
// system error has and no Postgres driver error does.
const PG_SQLSTATE_PATTERN = /^(?=.*[0-9])[0-9A-Z]{5}$/u;

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
// Bun's `Bun.sql` puts the SQLSTATE in `errno` (`code` is a generic category
// like "ERR_POSTGRES_SERVER_ERROR"); pg/PGlite put it in `code`. Prefer
// `errno`, fall back to `code`, and require the SQLSTATE shape so
// non-Postgres codes are ignored.
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

type PgErrorNode = { node: object; sqlState: string };

/**
 * Every node in `error`'s `.cause` chain, outermost first, that is shaped like
 * a Postgres driver error.
 *
 * Matching walks the chain rather than testing for a `DrizzleQueryError`
 * wrapper because only failures raised inside prepared-query execution are
 * wrapped. The transaction lifecycle runs through the client's own `begin`,
 * so a failure while acquiring a connection or running `BEGIN`, `COMMIT`, or
 * `ROLLBACK` arrives as the bare driver error. `COMMIT` is where Postgres
 * reports deferred constraint violations and serialization failures, so a
 * reader gated on the wrapper misses exactly the codes worth acting on.
 *
 * Every helper below reads the chain through this one walk, so a SQLSTATE the
 * observability fields can see is also one the predicates can match. Never
 * throws: property access is fully guarded.
 */
const pgErrorNodes = (error: unknown): PgErrorNode[] => {
  const nodes: PgErrorNode[] = [];
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
      nodes.push({ node: current, sqlState });
    }
    current = readProperty(current, "cause");
    depth += 1;
  }

  return nodes;
};

/**
 * The SQLSTATE of the outermost Postgres driver error in `error`'s cause
 * chain, or undefined when the chain holds none.
 *
 * Common codes: see `PG_ERROR` below.
 */
export const getPgErrorCode = (error: unknown): string | undefined =>
  pgErrorNodes(error).at(0)?.sqlState;

/** Returns true when `error` is a Postgres error with the given SQLSTATE. */
export const isPgError = (error: unknown, code: string): boolean =>
  getPgErrorCode(error) === code;

/**
 * Returns true only when Postgres identified both the SQLSTATE and the
 * database constraint/index which rejected the query.  A 23505 alone is not
 * enough to retry a different value: an identity conflict and a slug conflict
 * have different replay semantics.
 */
export const isPgConstraintError = (
  error: unknown,
  code: string,
  constraint: string,
): boolean =>
  pgErrorNodes(error).some(
    ({ node, sqlState }) =>
      sqlState === code &&
      readNonEmptyString(node, "constraint") === constraint,
  );

export const PG_ERROR = {
  DEADLOCK_DETECTED: "40P01",
  FOREIGN_KEY_VIOLATION: "23503",
  SERIALIZATION_FAILURE: "40001",
  UNIQUE_VIOLATION: "23505",
  INSUFFICIENT_PRIVILEGE: "42501",
  READ_ONLY_SQL_TRANSACTION: "25006",
} as const;

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

const readSafePgStringFields = (node: object): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const { key, property } of PG_SAFE_STRING_FIELDS) {
    const value = readNonEmptyString(node, property);
    if (value !== undefined) {
      fields[key] = value;
    }
  }
  return fields;
};

/**
 * Extract safe, structured fields from a Postgres driver error anywhere in an
 * error's `.cause` chain, for observability. A failed query wraps the driver
 * error (`DrizzleQueryError`), so its SQLSTATE lives one or more `.cause` hops
 * down and would otherwise never reach the log sink.
 *
 * Returns the SQLSTATE under `error.cause.pg_code` plus any present schema
 * identifiers (severity, constraint, table, column, schema, routine). Every
 * key is chosen to NOT match the logger's PII redaction regex, so the fields
 * survive `sanitizeLogAttributes`. Returns `{}` when no Postgres error is
 * found. Never throws: property access is fully guarded.
 */
export const pgErrorFields = (error: unknown): Record<string, string> => {
  const nodes = pgErrorNodes(error);
  const outermost = nodes.at(0);
  if (outermost === undefined) {
    return {};
  }

  const fields: Record<string, string> = {
    "error.cause.pg_code": outermost.sqlState,
  };
  for (const { node } of nodes) {
    Object.assign(fields, readSafePgStringFields(node));
  }
  return fields;
};
