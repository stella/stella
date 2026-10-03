import {
  PG_CONNECTION_LIFECYCLE_SQL_STATES,
  PG_DRIVER_ERROR,
  pgIdentityFields,
  shadowGradeFields,
} from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";

// The driver codes are owned by the failure grader, which reads them for every
// sink; they are re-exported here for the retry and control-flow callers.
export { PG_DRIVER_ERROR };

/** The outermost SQLSTATE in the shared, read-once failure snapshot. */
export const getPgErrorCode = (error: unknown): string | undefined =>
  readEvidence(error).nodes.find((node) => node.sqlState !== undefined)
    ?.sqlState;

/** Bun's safe Postgres driver code, including connection failures without SQLSTATE. */
export const getPgDriverErrorCode = (error: unknown): string | undefined =>
  pgIdentityFields(readEvidence(error))["error.cause.pg_driver_code"];

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
  readEvidence(error).nodes.some(
    (node) =>
      node.sqlState === code && node.pgIdentifiers.constraint === constraint,
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
 * the one generic `code` and puts the SQLSTATE in `errno`. This reads the
 * same snapshot as `pgErrorFields`, preserving the identity seen by telemetry.
 */
export const isTransientPgConnectionError = (error: unknown): boolean =>
  readEvidence(error).nodes.some(
    (node) =>
      (node.code !== undefined && CONNECTION_LIFECYCLE_CODES.has(node.code)) ||
      (node.sqlState !== undefined &&
        CONNECTION_LIFECYCLE_SQL_STATES.has(node.sqlState)),
  );

export const PG_ERROR = {
  DEADLOCK_DETECTED: "40P01",
  /** A statement gave up waiting for a lock it asked for with `lock_timeout`. */
  LOCK_NOT_AVAILABLE: "55P03",
  /** A statement was cancelled: `statement_timeout` expired, or an operator said so. */
  QUERY_CANCELED: "57014",
  FOREIGN_KEY_VIOLATION: "23503",
  SERIALIZATION_FAILURE: "40001",
  UNIQUE_VIOLATION: "23505",
  CHECK_VIOLATION: "23514",
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
 * Returns a SQLSTATE under `error.cause.pg_code`, a Bun driver code under
 * `error.cause.pg_driver_code`, plus any present schema identifiers, read
 * from the shared failure snapshot, and the grade that failure would get.
 * Returns `{}` when no Postgres error is found. Never throws.
 */
export const pgErrorFields = (error: unknown): Record<string, string> => {
  const fields = pgIdentityFields(readEvidence(error));
  return Object.keys(fields).length === 0
    ? fields
    : { ...fields, ...shadowGradeFields(error) };
};
