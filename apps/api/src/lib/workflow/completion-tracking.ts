// Pure helpers for interpreting the atomic entity-completion Lua script's
// reply. Kept free of Redis imports so the parsing logic is unit-testable
// without a live connection, mirroring `orphan-recovery.ts`.

// Atomically re-checks that `requestId` is still the workspace's active
// workflow request (matching both the `request-id` key and the `running`
// lock, including the legacy running-lock value) and, only if so, records
// this entity as completed and reads the total in the same Redis command.
//
// Two atomicity guarantees, both closed by bundling the work into one
// script (Redis executes Lua with no other command interleaved):
//
//  1. Stale-run isolation. A plain check-then-write (two round trips)
//     leaves a window where a stale job's check can pass just before the
//     run it belongs to finishes and a new run resets the counters — the
//     stale write would then land on the new run instead of a no-op.
//
//  2. Per-entity idempotency. Completion is tracked as a SET of entity
//     ids (`SADD` + `SCARD`), not a blind counter. An entity job can run
//     its completion path more than once for the same run: a job timeout
//     or a BullMQ stalled-job reclaim can mark a job failed *after* it
//     recorded completion, and the retry (or the exhausted-retry failure
//     handler) records the same entity again. A counter would over-count
//     and let `completed` reach `total` while an entity is still
//     mid-flight, so `finishWorkflow` would clear the run lock early and
//     strand that entity's cells at `pending`. `SADD` of an
//     already-present member is a no-op, so `SCARD` reflects distinct
//     entities only and a re-driven entity cannot advance the count.
//
// The set is (re)given the run-state TTL on every completion so it never
// lingers TTL-less after the run lapses, matching every sibling key.
//
// KEYS[1] = request-id key, KEYS[2] = running key,
// KEYS[3] = completed-entities set key, KEYS[4] = total key.
// ARGV[1] = requestId, ARGV[2] = legacy running-lock value,
// ARGV[3] = entityId, ARGV[4] = run-state TTL seconds.
//
// Returns `[matched, completed, total]`, where `matched` is `1` only when
// the completion was recorded against the currently active request and
// `completed` is the count of distinct entities finished so far.
export const COMPLETE_ENTITY_SCRIPT = `
local currentRequestId = redis.call("GET", KEYS[1])
local runningValue = redis.call("GET", KEYS[2])
local requestId = ARGV[1]
local legacyRunningLockValue = ARGV[2]
local entityId = ARGV[3]
local runStateTtlSec = ARGV[4]

if currentRequestId ~= requestId then
  return {0, 0, 0}
end
if runningValue ~= requestId and runningValue ~= legacyRunningLockValue then
  return {0, 0, 0}
end

redis.call("SADD", KEYS[3], entityId)
redis.call("EXPIRE", KEYS[3], tonumber(runStateTtlSec))
local completed = redis.call("SCARD", KEYS[3])
local totalRaw = redis.call("GET", KEYS[4])
local total = tonumber(totalRaw) or 0
return {1, completed, total}
`;

export type EntityCompletionReply =
  | { matched: false }
  | { matched: true; completed: number; total: number };

const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

/**
 * Parse the raw EVAL reply from `COMPLETE_ENTITY_SCRIPT`. Any shape other
 * than `[1, completed, total]` (a stale Redis client version, a protocol
 * hiccup, a mismatched request) is treated as unmatched so a malformed
 * reply never miscounts a completion.
 */
export const parseEntityCompletionReply = (
  reply: unknown,
): EntityCompletionReply => {
  if (!isUnknownArray(reply) || reply.length < 3) {
    return { matched: false };
  }
  const [matchedRaw, completedRaw, totalRaw] = reply;
  if (Number(matchedRaw) !== 1) {
    return { matched: false };
  }
  const completed = Number(completedRaw);
  const total = Number(totalRaw);
  if (!Number.isFinite(completed) || !Number.isFinite(total)) {
    return { matched: false };
  }
  return { matched: true, completed, total };
};

// Minimal structural view of the Redis client needed to run the
// completion script. Kept structural (not Bun's `RedisClient`) so this
// module stays free of a live-connection dependency and the completion
// path is exercisable against an in-memory fake in tests.
type EntityCompletionRedis = {
  send: (command: string, args: string[]) => Promise<unknown>;
};

// Resolved Redis key names for a workspace's run-state. The caller owns
// key naming (`workflowKey`); this helper only wires them into the script.
export type WorkflowCompletionKeys = {
  requestId: string;
  running: string;
  completedEntities: string;
  total: string;
};

type RecordEntityCompletionArgs = {
  redis: EntityCompletionRedis;
  keys: WorkflowCompletionKeys;
  activeRequestId: string;
  legacyRunningLockValue: string;
  entityId: string;
  runStateTtlSec: number;
};

/**
 * Run `COMPLETE_ENTITY_SCRIPT` for one entity and parse its reply. The
 * script is atomic and idempotent per entity (see its comment), so
 * calling this twice for the same `entityId` records the entity once.
 */
export const recordEntityCompletion = async ({
  redis,
  keys,
  activeRequestId,
  legacyRunningLockValue,
  entityId,
  runStateTtlSec,
}: RecordEntityCompletionArgs): Promise<EntityCompletionReply> => {
  const reply = await redis.send("EVAL", [
    COMPLETE_ENTITY_SCRIPT,
    "4",
    keys.requestId,
    keys.running,
    keys.completedEntities,
    keys.total,
    activeRequestId,
    legacyRunningLockValue,
    entityId,
    String(runStateTtlSec),
  ]);
  return parseEntityCompletionReply(reply);
};

type ResetCompletionStateArgs = {
  redis: EntityCompletionRedis;
  completedEntitiesKey: string;
};

/**
 * Clear the distinct-entity completion set before a new run enqueues its
 * jobs. The set is a Redis Set that completions grow lazily via `SADD`, so
 * it can outlive the run-state that named it: a worker death between the
 * completion script's `EXPIRE` and the sibling-key TTL refresh, a manual
 * lock deletion, or a TTL discrepancy can leave a populated set behind. A
 * later run reuses the same key, and its first `SADD`/`SCARD` would then
 * read the stale members and could reach `total` while entities are still
 * mid-flight — finalizing the run early and stranding cells at `pending`.
 *
 * Deleting the key here gives every run an empty set, so `SCARD` counts
 * only this run's entities. The caller must already hold the run lock so no
 * live run shares the key. Routed through `send` (not a typed `del`) to
 * keep this module free of a live-connection dependency and unit-testable
 * against the same in-memory fake as `recordEntityCompletion`.
 */
export const resetCompletionState = async ({
  redis,
  completedEntitiesKey,
}: ResetCompletionStateArgs): Promise<void> => {
  await redis.send("DEL", [completedEntitiesKey]);
};
