/**
 * Classifies a daemon-loop failure as a connection the pool lost rather than
 * work that failed.
 *
 * Split out of the daemon so the shapes below are testable: every ingestion
 * loop routes its failures through this one predicate, and the two sinks it
 * chooses between are not interchangeable. A lost connection is logged as a
 * retry and the loop picks the work up next cycle; anything else is logged as
 * a backfill failure, the line an operator is expected to read.
 */

import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import {
  PG_DRIVER_ERROR,
  isTransientPgConnectionError,
} from "@/api/lib/pg-error";

/**
 * Closure wording that has reached this predicate as free text, from a caller
 * that rendered the driver error into a message of its own instead of keeping
 * it as the `cause`. Kept as a widening fallback beneath the code check: this
 * predicate also decides whether an unhandled rejection ends the process, so
 * it must never match less than it used to.
 */
const CONNECTION_CLOSED_TEXT = [
  "Connection closed",
  PG_DRIVER_ERROR.CONNECTION_CLOSED,
] as const;

/**
 * Bun's native Postgres pool emits unhandled errors when the server closes a
 * connection (a failover, a network interruption) and when the pool retires
 * one on its own `idleTimeout` or `maxLifetime` bound. The internal `#onClose`
 * callback throws a `PostgresError` that no query-level try/catch sees, so
 * without this classification the process crashes on any connection drop.
 *
 * A `TimeoutError` is the same failure class surfacing differently: a
 * connection the server reaped silently never errors, so the bounded DB handle
 * in `../db` rejects the wedged await instead. Both retry next cycle, and the
 * adapter loops self-heal within `CYCLE_DELAY_MS`.
 */
export const isTransientConnectionError = (error: unknown): boolean => {
  if (error instanceof TimeoutError || isTransientPgConnectionError(error)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return CONNECTION_CLOSED_TEXT.some((text) => message.includes(text));
};
