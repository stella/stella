// Pure helpers for the atomic entity-completion script. This module stays
// free of Redis client imports so its concurrency invariants are testable
// in-process; it takes keys, never a connection.

import {
  coordinationSetArguments,
  type CoordinationKey,
} from "@/api/lib/redis-keys";

// Atomically verifies that a job still belongs to the active workflow, records
// the entity once, and returns progress. Bundling the operations closes the
// stale-run check/write race; SADD/SCARD makes retries idempotent per entity.
//
// All six keys must share one cluster slot, which the `workflow-run` hashtag
// on the workspace id guarantees; a cluster rejects a script whose keys span
// slots.
//
// KEYS[1] = request-id, KEYS[2] = running, KEYS[3] = completed-entities,
// KEYS[4] = total, KEYS[5] = transitional completed counter,
// KEYS[6] = set-mode marker. ARGV[1] = requestId,
// ARGV[2] = transitional running-lock value, ARGV[3] = entityId,
// ARGV[4] = run-state TTL seconds.
export const COMPLETE_ENTITY_SCRIPT = `
local currentRequestId = redis.call("GET", KEYS[1])
local runningValue = redis.call("GET", KEYS[2])
local requestId = ARGV[1]
local transitionalRunningLockValue = ARGV[2]
local entityId = ARGV[3]
local runStateTtlSec = ARGV[4]

if currentRequestId ~= requestId then
  return {0, 0, 0}
end
if runningValue ~= requestId and runningValue ~= transitionalRunningLockValue then
  return {0, 0, 0}
end

local total = tonumber(redis.call("GET", KEYS[4]))
if total == nil or total < 1 then
  return {0, 0, 0}
end

redis.call("SADD", KEYS[3], entityId)
redis.call("EXPIRE", KEYS[3], tonumber(runStateTtlSec))
local completed = redis.call("SCARD", KEYS[3])

if redis.call("EXISTS", KEYS[6]) == 1 then
  redis.call("EXPIRE", KEYS[6], tonumber(runStateTtlSec))
else
  local transitionalCompleted = tonumber(redis.call("GET", KEYS[5])) or 0
  completed = completed + transitionalCompleted
  redis.call("EXPIRE", KEYS[5], tonumber(runStateTtlSec))
end

if completed > total then
  completed = total
end
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
  requestId: CoordinationKey;
  running: CoordinationKey;
  completedEntities: CoordinationKey;
  total: CoordinationKey;
  transitionalCompleted: CoordinationKey;
  setMode: CoordinationKey;
};

type RecordEntityCompletionArgs = {
  redis: EntityCompletionRedis;
  keys: WorkflowCompletionKeys;
  activeRequestId: string;
  transitionalRunningLockValue: string;
  entityId: string;
  runStateTtlSec: number;
};

export const recordEntityCompletion = async ({
  redis,
  keys,
  activeRequestId,
  transitionalRunningLockValue,
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
    keys.transitionalCompleted,
    keys.setMode,
    activeRequestId,
    transitionalRunningLockValue,
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
  transitionalCompletedKey,
  setModeKey,
  runStateTtlSec,
}: {
  redis: EntityCompletionRedis;
  completedEntitiesKey: CoordinationKey;
  transitionalCompletedKey: CoordinationKey;
  setModeKey: CoordinationKey;
  runStateTtlSec: number;
}): Promise<void> => {
  // Both keys carry the same workspace hashtag, so this multi-key DEL stays
  // inside one cluster slot.
  await redis.send("DEL", [completedEntitiesKey, transitionalCompletedKey]);
  await redis.send(
    "SET",
    coordinationSetArguments({
      key: setModeKey,
      value: "1",
      ttl: { unit: "seconds", value: runStateTtlSec },
    }),
  );
};
