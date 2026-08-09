// Pure helpers for the atomic entity-completion script. This module stays
// free of Redis imports so its concurrency invariants are testable in-process.

// Atomically verifies that a job still belongs to the active workflow, records
// the entity once, and returns progress. Bundling the operations closes the
// stale-run check/write race; SADD/SCARD makes retries idempotent per entity.
//
// KEYS[1] = request-id, KEYS[2] = running, KEYS[3] = completed-entities,
// KEYS[4] = total. ARGV[1] = requestId, ARGV[2] = entityId,
// ARGV[3] = run-state TTL seconds.
export const COMPLETE_ENTITY_SCRIPT = `
local currentRequestId = redis.call("GET", KEYS[1])
local runningValue = redis.call("GET", KEYS[2])
local requestId = ARGV[1]
local entityId = ARGV[2]
local runStateTtlSec = ARGV[3]

if currentRequestId ~= requestId or runningValue ~= requestId then
  return {0, 0, 0}
end

local total = tonumber(redis.call("GET", KEYS[4]))
if total == nil or total < 1 then
  return {0, 0, 0}
end

redis.call("SADD", KEYS[3], entityId)
redis.call("EXPIRE", KEYS[3], tonumber(runStateTtlSec))
local completed = redis.call("SCARD", KEYS[3])
return {1, completed, total}
`;

export type EntityCompletionReply =
  | { matched: false }
  | { matched: true; completed: number; total: number };

const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

/**
 * Parse the raw EVAL reply. Any malformed shape is unmatched so a protocol
 * error cannot advance or finalize a workflow.
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
  if (
    !Number.isInteger(completed) ||
    completed < 0 ||
    !Number.isInteger(total) ||
    total < 1 ||
    completed > total
  ) {
    return { matched: false };
  }
  return { matched: true, completed, total };
};

type EntityCompletionRedis = {
  send: (command: string, args: string[]) => Promise<unknown>;
};

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
  entityId: string;
  runStateTtlSec: number;
};

export const recordEntityCompletion = async ({
  redis,
  keys,
  activeRequestId,
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
    entityId,
    String(runStateTtlSec),
  ]);
  return parseEntityCompletionReply(reply);
};

/**
 * Clear the prior run's completion set before enqueuing a new run. The set is
 * populated lazily, so a process death or TTL discrepancy can otherwise leave
 * stale members that make the next run finalize early.
 */
export const resetCompletionState = async ({
  redis,
  completedEntitiesKey,
}: {
  redis: EntityCompletionRedis;
  completedEntitiesKey: string;
}): Promise<void> => {
  await redis.send("DEL", [completedEntitiesKey]);
};
