// Pure helpers for interpreting the atomic entity-completion Lua script's
// reply. Kept free of Redis imports so the parsing logic is unit-testable
// without a live connection, mirroring `orphan-recovery.ts`.

// Atomically re-checks that `requestId` is still the workspace's active
// workflow request (matching both the `request-id` key and the `running`
// lock, including the legacy running-lock value) and, only if so,
// increments the completed counter and reads the total in the same Redis
// command. A plain check-then-INCR (two separate round trips) leaves a
// window where a stale job's check can pass just before the run it
// belongs to finishes and a new run resets the counters: the stale job's
// INCR would then land on the new run instead of a no-op. Bundling the
// check and the increment into one script closes that window, since Redis
// executes Lua scripts atomically with no other command interleaved.
//
// KEYS[1] = request-id key, KEYS[2] = running key, KEYS[3] = completed
// key, KEYS[4] = total key.
// ARGV[1] = requestId, ARGV[2] = legacy running-lock value.
//
// Returns `[matched, completed, total]`, where `matched` is `1` only when
// the increment happened against the currently active request.
export const COMPLETE_ENTITY_SCRIPT = `
local currentRequestId = redis.call("GET", KEYS[1])
local runningValue = redis.call("GET", KEYS[2])
local requestId = ARGV[1]
local legacyRunningLockValue = ARGV[2]

if currentRequestId ~= requestId then
  return {0, 0, 0}
end
if runningValue ~= requestId and runningValue ~= legacyRunningLockValue then
  return {0, 0, 0}
end

local completed = redis.call("INCR", KEYS[3])
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
