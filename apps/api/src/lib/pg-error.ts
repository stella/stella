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

/**
 * Every node in `error`'s `.cause` chain, outermost first.
 *
 * Bounded by `MAX_CAUSE_DEPTH` and guarded by `seen`: a self-referential
 * `cause` is an infinite loop on a runtime with proper tail calls, not a
 * fast throw, so the cycle guard is load-bearing rather than defensive.
 * Never throws: property access is fully guarded.
 */
const causeChain = (error: unknown): object[] => {
  const nodes: object[] = [];
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
    nodes.push(current);
    current = readProperty(current, "cause");
    depth += 1;
  }

  return nodes;
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
  for (const node of causeChain(error)) {
    const sqlState = sqlStateOf(node);
    if (sqlState !== undefined) {
      nodes.push({ node, sqlState });
    }
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

/**
 * Bun driver codes for a connection that is gone, as opposed to a query the
 * server rejected. The driver reports this category in `code`; a SQLSTATE,
 * when there is one, lives in `errno`, so these never collide with `PG_ERROR`.
 *
 * Retirement by the pool's own `idleTimeout` and `maxLifetime` bounds belongs
 * with the server-side closures: Bun retires a connection when the timer
 * expires whether or not a caller still holds it, so the interrupted work is
 * neither lost nor invalid, and the next attempt gets a fresh connection.
 *
 * `CONNECTION_FAILED` is the same story at the other end of the connection's
 * life: the driver documents it as accepted but closed before the handshake
 * completed, which is what a server that is still starting up looks like.
 * Which of these a given failure surfaces as is not stable across driver
 * versions, so callers must treat the set as one condition rather than
 * branching on a member.
 */
export const PG_DRIVER_ERROR = {
  CONNECTION_CLOSED: "ERR_POSTGRES_CONNECTION_CLOSED",
  CONNECTION_FAILED: "ERR_POSTGRES_CONNECTION_FAILED",
  CONNECTION_TIMEOUT: "ERR_POSTGRES_CONNECTION_TIMEOUT",
  IDLE_TIMEOUT: "ERR_POSTGRES_IDLE_TIMEOUT",
  LIFETIME_TIMEOUT: "ERR_POSTGRES_LIFETIME_TIMEOUT",
} as const;

/**
 * `ERR_POSTGRES_CONNECTION_REFUSED` is deliberately absent: the driver
 * documents it as nothing listening at the address, fails it immediately, and
 * does not retry. Treating it as transient would turn a wrong host or port
 * into a silent retry loop rather than a failure someone reads.
 */

const CONNECTION_LIFECYCLE_CODES: ReadonlySet<string> = new Set(
  Object.values(PG_DRIVER_ERROR),
);

/**
 * True when `error`, or anything in its `.cause` chain, is a driver error
 * reporting a lost or retired connection: the work is retryable as-is.
 *
 * Reads the driver's `code` rather than the message. A `PostgresError`'s
 * message is the failure alone ("Idle timeout reached after 2m") and never
 * names its own type, so matching message text for a type name cannot fire;
 * the wording is also the driver's to change between releases, while the code
 * is its stable contract. Walks the chain because a failure raised inside
 * prepared-query execution arrives wrapped in a `DrizzleQueryError`.
 */
export const isTransientPgConnectionError = (error: unknown): boolean =>
  causeChain(error).some((node) => {
    const code = readNonEmptyString(node, "code");
    return code !== undefined && CONNECTION_LIFECYCLE_CODES.has(code);
  });

export const PG_ERROR = {
  DEADLOCK_DETECTED: "40P01",
  /** A statement gave up waiting for a lock it asked for with `lock_timeout`. */
  LOCK_NOT_AVAILABLE: "55P03",
  /** A statement was cancelled: `statement_timeout` expired, or an operator said so. */
  QUERY_CANCELED: "57014",
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
