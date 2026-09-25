import {
  PG_CONNECTION_LIFECYCLE_SQL_STATES,
  PG_DRIVER_ERROR,
  pgIdentityFields,
  shadowGradeFields,
} from "@/api/lib/observability/failure";
import {
  MAX_EVIDENCE_DEPTH,
  readEvidence,
  sqlStateFrom,
} from "@/api/lib/observability/failure-evidence";

// The driver codes are owned by the failure grader, which reads them for every
// sink; they are re-exported here for the retry and control-flow callers.
export { PG_DRIVER_ERROR };

const MAX_CAUSE_DEPTH = MAX_EVIDENCE_DEPTH;

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

// The snapshot's SQLSTATE rule, so a code the observability fields can see is
// one these predicates can match.
const sqlStateOf = (node: object): string | undefined =>
  sqlStateFrom({
    syscall: readProperty(node, "syscall"),
    errno: readProperty(node, "errno"),
    code: readProperty(node, "code"),
  });

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

const CONNECTION_LIFECYCLE_CODES: ReadonlySet<string> = new Set(
  Object.values(PG_DRIVER_ERROR),
);

const CONNECTION_LIFECYCLE_SQL_STATES: ReadonlySet<string> = new Set(
  PG_CONNECTION_LIFECYCLE_SQL_STATES,
);

/**
 * True when `error`, or anything in its `.cause` chain, reports a connection
 * that was lost, retired, or refused: the work is retryable as-is.
 *
 * Reads the driver's `code` rather than the message. A `PostgresError`'s
 * message is the failure alone ("Idle timeout reached after 2m") and never
 * names its own type, so matching message text for a type name cannot fire;
 * the wording is also the driver's to change between releases, while the code
 * is its stable contract. Walks the chain because a failure raised inside
 * prepared-query execution arrives wrapped in a `DrizzleQueryError`.
 *
 * A node matches on either contract, because the two describe the same
 * conditions at different points of the handshake: the driver's own `code`
 * when the connection failed below the protocol, and the server's SQLSTATE
 * when the backend answered and declined to serve it. Reading only `code`
 * misses the latter entirely, since the driver files every server error under
 * the one generic `code` and puts the SQLSTATE in `errno`. `sqlStateOf` is the
 * same reader `pgErrorFields` uses, so a SQLSTATE the observability fields can
 * see is one this predicate can match.
 */
export const isTransientPgConnectionError = (error: unknown): boolean =>
  causeChain(error).some((node) => {
    const code = readNonEmptyString(node, "code");
    if (code !== undefined && CONNECTION_LIFECYCLE_CODES.has(code)) {
      return true;
    }
    const sqlState = sqlStateOf(node);
    return (
      sqlState !== undefined && CONNECTION_LIFECYCLE_SQL_STATES.has(sqlState)
    );
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
  /** A value outran a fixed limit of the build, such as a `tsvector` over 1 MiB. */
  PROGRAM_LIMIT_EXCEEDED: "54000",
} as const;

/**
 * Extract safe, structured fields from a Postgres driver error anywhere in an
 * error's `.cause` chain, for observability. A failed query wraps the driver
 * error (`DrizzleQueryError`), so its SQLSTATE lives one or more `.cause` hops
 * down and would otherwise never reach the log sink.
 *
 * Returns the SQLSTATE under `error.cause.pg_code` plus any present schema
 * identifiers (severity, constraint, table, column, schema, routine), read
 * from the shared failure snapshot, and the grade that failure would get.
 * Returns `{}` when no Postgres error is found. Never throws.
 */
export const pgErrorFields = (error: unknown): Record<string, string> => {
  const fields = pgIdentityFields(readEvidence(error));
  return Object.keys(fields).length === 0
    ? fields
    : { ...fields, ...shadowGradeFields(error) };
};
