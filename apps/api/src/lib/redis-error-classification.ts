import { safeErrorCode } from "@/api/lib/errors/utils";

/**
 * Which Valkey failures are expected operational transients.
 *
 * Split from `redis-client.ts` so a consumer can classify an error it was
 * handed without importing the module that opens connections: that module is
 * allowlisted per file precisely so the set of things which may live in
 * Valkey stays reviewable, and a pure predicate is not such a thing.
 * `redis-client.ts` re-exports both predicates, so existing callers are
 * unaffected.
 */

// Bun's experimental BullMQ Redis adapter intermittently fails to parse a reply
// on a worker's idle blocking poll, surfacing an opaque
// `ERR_REDIS_INVALID_RESPONSE` ("Failed to read data") roughly every few
// seconds. It is self-recovering — the worker keeps draining jobs — so callers
// must not treat it as a real outage. A persistent Redis outage manifests as
// different codes / reconnection failures, which stay unclassified here.
const RECOVERABLE_REDIS_POLL_ERROR_CODE = "ERR_REDIS_INVALID_RESPONSE";

export const isRecoverableRedisPollError = (error: unknown): boolean =>
  error instanceof Error &&
  safeErrorCode(error) === RECOVERABLE_REDIS_POLL_ERROR_CODE;

// Bun's RedisClient auto-reconnects a dropped socket, but a command issued
// against the dead connection — the first touch after an idle window, or a
// command in flight when the drop happens — rejects with
// ERR_REDIS_CONNECTION_CLOSED instead of waiting for the reconnect. For a
// periodic loop whose next tick retries anyway, that rejection is an
// expected operational transient, not a defect; a persistent outage keeps
// failing and stays visible through the loop's own error logging and the
// worker/broadcast error paths.
const TRANSIENT_REDIS_CONNECTION_ERROR_CODE = "ERR_REDIS_CONNECTION_CLOSED";

export const isTransientRedisConnectionError = (error: unknown): boolean =>
  error instanceof Error &&
  safeErrorCode(error) === TRANSIENT_REDIS_CONNECTION_ERROR_CODE;
