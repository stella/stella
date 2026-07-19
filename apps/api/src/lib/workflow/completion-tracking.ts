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
//  3. Deploy-transition compatibility, gated to runs that provably predate
//     this code. A run that began under the previous code recorded finished
//     entities in a legacy INCR counter (`completed`, KEYS[5]) instead of
//     this set. After a mid-run deploy those entities are absent from the
//     set, so counting the set alone would leave `completed` permanently
//     below `total` and the run would never finalize (stranded until TTL or
//     the boot reconciler). We add the legacy counter to the set's
//     cardinality so an in-flight old run can still reach `total` — but
//     only when KEYS[6], the set-mode marker written by
//     `resetCompletionState`, is absent. A fresh run (marker present)
//     never trusts the legacy key, even if one of its entity jobs is
//     dequeued by a straggler old-code replica that recreates `completed`
//     via its own INCR path mid-rollout (queue topology lets old replicas
//     keep draining the shared queue during a deploy). Without this gate
//     that straggler write would add into `completed + legacyCompleted`
//     for a run whose own entities are tracked purely by the set,
//     reintroducing this PR's target bug — early finalization — on every
//     rolling deploy instead of only for runs that genuinely started
//     before it. New runs never have the legacy key deleted from under
//     them mid-run (`clearWorkflowRunState` only runs after finish), so
//     once a run's marker is set, `completed` is `SCARD` alone for its
//     entire lifetime, straggler writes included.
//     Narrow accepted window, unchanged for genuinely pre-deploy runs: an
//     entity that finished pre-deploy (no marker was ever written for that
//     run) and is retried post-deploy is counted in both the legacy
//     counter and the set, overshooting by one and finalizing one
//     completion early — preferred over a run that never finalizes.
//
// KEYS[1] = request-id key, KEYS[2] = running key,
// KEYS[3] = completed-entities set key, KEYS[4] = total key,
// KEYS[5] = legacy `completed` counter key (deploy-transition only),
// KEYS[6] = set-mode marker key (present only for runs started under this
// code; gates KEYS[5] out of the count once present).
// ARGV[1] = requestId, ARGV[2] = legacy running-lock value,
// ARGV[3] = entityId, ARGV[4] = run-state TTL seconds.
//
// Returns `[matched, completed, total]`, where `matched` is `1` only when
// the completion was recorded against the currently active request and
// `completed` is the count of distinct entities finished so far (the set's
// cardinality plus the legacy pre-deploy counter, but only for runs that
// never set the set-mode marker, per guarantee 3).
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

local setMode = redis.call("EXISTS", KEYS[6])
local legacyCompleted = 0
if setMode == 0 then
  legacyCompleted = tonumber(redis.call("GET", KEYS[5])) or 0
else
  redis.call("EXPIRE", KEYS[6], tonumber(runStateTtlSec))
end

local totalRaw = redis.call("GET", KEYS[4])
local total = tonumber(totalRaw) or 0
return {1, completed + legacyCompleted, total}
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
  // Legacy pre-set INCR counter, read only for deploy-transition
  // compatibility (guarantee 3), and only when `setMode` is absent.
  legacyCompleted: string;
  // Marker written by `resetCompletionState` for every run started under
  // this code. Once present, `legacyCompleted` is never added to the
  // count for this run's lifetime — including if a straggler old-code
  // replica recreates it mid-run — so the run's completion is tracked by
  // the set alone (guarantee 3).
  setMode: string;
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
    "6",
    keys.requestId,
    keys.running,
    keys.completedEntities,
    keys.total,
    keys.legacyCompleted,
    keys.setMode,
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
  legacyCompletedKey: string;
  setModeKey: string;
  runStateTtlSec: number;
};

/**
 * Clear the completion accounting before a new run enqueues its jobs. The
 * distinct-entity set grows lazily via `SADD`, so it can outlive the
 * run-state that named it: a worker death between the completion script's
 * `EXPIRE` and the sibling-key TTL refresh, a manual lock deletion, or a
 * TTL discrepancy can leave a populated set behind. A later run reuses the
 * same key, and its first `SADD`/`SCARD` would then read the stale members
 * and could reach `total` while entities are still mid-flight — finalizing
 * the run early and stranding cells at `pending`.
 *
 * Also deletes the legacy `completed` counter, then writes the set-mode
 * marker (with the same TTL/refresh discipline as every other run-state
 * key — refreshed by the completion script itself on each entity, deleted
 * by `clearWorkflowRunState` on finish). The marker, not merely the
 * counter's absence, is what gates `COMPLETE_ENTITY_SCRIPT`'s legacy read
 * (guarantee 3): a run started under this code sets the marker once, up
 * front, before any entity completes, so a straggler old-code replica
 * that later recreates the legacy counter for one of this run's entities
 * (rolling deploys let old replicas keep draining the shared queue) can
 * never make that write count — the marker's presence alone decides,
 * independent of whatever the legacy key currently holds. A genuinely
 * pre-deploy run never has this marker (it never called
 * `resetCompletionState` under this code), so its legacy counter still
 * applies, unchanged from before.
 *
 * The caller must already hold the run lock so no live run shares the
 * keys. Routed through `send` (not a typed `del`/`set`) to keep this
 * module free of a live-connection dependency and unit-testable against
 * the same in-memory fake as `recordEntityCompletion`.
 */
export const resetCompletionState = async ({
  redis,
  completedEntitiesKey,
  legacyCompletedKey,
  setModeKey,
  runStateTtlSec,
}: ResetCompletionStateArgs): Promise<void> => {
  await redis.send("DEL", [completedEntitiesKey, legacyCompletedKey]);
  await redis.send("SET", [setModeKey, "1", "EX", String(runStateTtlSec)]);
};
