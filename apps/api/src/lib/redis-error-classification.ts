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

// Bun's RedisClient reconnects a dropped socket, but a command that meets a
// connection which is not up rejects instead of waiting for it to come back.
// Which code it rejects with says only where the command sat when the
// connection went: ERR_REDIS_CONNECTION_CLOSED once the client has observed
// the drop — the first touch after an idle window, or a command in flight at
// the drop — and ERR_REDIS_CONNECTION_TIMEOUT while a connect attempt is
// still outstanding and passes `connectionTimeout`. For a periodic loop whose
// next tick retries anyway, either rejection is an expected operational
// transient, not a defect; a persistent outage keeps failing and stays visible
// through the loop's own error logging and the worker/broadcast error paths.
//
// What makes this downgrade sound is that the connection always comes back:
// `redis-client.ts` reconnects without an attempt cap, and the holders there
// replace a client that closed anyway. Reintroduce a bounded ladder and these
// codes stop meaning "retry later" and start meaning "this client is done",
// at which point the downgrade would hide a permanent failure. That is also
// why ERR_REDIS_IDLE_TIMEOUT is not here: Bun does not reconnect after one,
// and nothing sets `idleTimeout`, so it is unreachable rather than expected.
const TRANSIENT_REDIS_CONNECTION_ERROR_CODES = new Set([
  "ERR_REDIS_CONNECTION_CLOSED",
  "ERR_REDIS_CONNECTION_TIMEOUT",
]);

export const isTransientRedisConnectionError = (error: unknown): boolean =>
  error instanceof Error &&
  TRANSIENT_REDIS_CONNECTION_ERROR_CODES.has(safeErrorCode(error) ?? "");
