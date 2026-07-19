import { describe, expect, test } from "bun:test";

import {
  COMPLETE_ENTITY_SCRIPT,
  parseEntityCompletionReply,
  recordEntityCompletion,
  resetCompletionState,
} from "@/api/lib/workflow/completion-tracking";

describe("parseEntityCompletionReply", () => {
  test("reads a matched increment", () => {
    expect(parseEntityCompletionReply([1, 3, 10])).toEqual({
      matched: true,
      completed: 3,
      total: 10,
    });
  });

  test("treats an unmatched request as unmatched", () => {
    // A stale job's requestId no longer equals the workspace's current
    // request-id (or running lock): the Lua script returns [0, 0, 0]
    // without touching the counters. This is the case that used to be a
    // separate, racy `isCurrentWorkflowRequest` check before the INCR.
    expect(parseEntityCompletionReply([0, 0, 0])).toEqual({ matched: false });
  });

  test("treats a non-array reply as unmatched", () => {
    expect(parseEntityCompletionReply(null)).toEqual({ matched: false });
    expect(parseEntityCompletionReply(undefined)).toEqual({
      matched: false,
    });
    expect(parseEntityCompletionReply("OK")).toEqual({ matched: false });
  });

  test("treats a short array as unmatched", () => {
    expect(parseEntityCompletionReply([1, 3])).toEqual({ matched: false });
  });

  test("treats non-numeric completed/total as unmatched", () => {
    expect(parseEntityCompletionReply([1, "x", 10])).toEqual({
      matched: false,
    });
    expect(parseEntityCompletionReply([1, 3, "y"])).toEqual({
      matched: false,
    });
  });

  test("treats a matched flag other than 1 as unmatched", () => {
    expect(parseEntityCompletionReply([2, 3, 10])).toEqual({
      matched: false,
    });
  });
});

// In-memory fake modelling the exact Redis commands COMPLETE_ENTITY_SCRIPT
// issues. Mirrors the FakeRedisClient pattern used by the rate-limit tests:
// the real Lua cannot run in-process, so `send("EVAL", …)` dispatches on the
// production script constant and reproduces its GET / SADD / EXPIRE / SCARD
// semantics against a Map. This exercises the real `recordEntityCompletion`
// wiring (arg layout, reply parsing) and the script's documented behaviour.
type FakeRedisState = {
  strings: Map<string, string>;
  sets: Map<string, Set<string>>;
  ttlSec: Map<string, number>;
};

const arg = (args: string[], index: number): string => {
  const value = args.at(index);
  if (value === undefined) {
    throw new TypeError(`Missing Redis argument at index ${index}`);
  }
  return value;
};

const createFakeRedis = (state: FakeRedisState) => ({
  send: async (command: string, args: string[]): Promise<unknown> => {
    if (command === "DEL") {
      let removed = 0;
      for (const key of args) {
        const existed =
          state.strings.has(key) ||
          state.sets.has(key) ||
          state.ttlSec.has(key);
        state.strings.delete(key);
        state.sets.delete(key);
        state.ttlSec.delete(key);
        removed += Number(existed);
      }
      return removed;
    }
    if (command !== "EVAL" || arg(args, 0) !== COMPLETE_ENTITY_SCRIPT) {
      throw new TypeError(`Unexpected Redis command: ${command}`);
    }
    // KEYS[1..5] then ARGV[1..4]; KEYS start at index 2 (after script + numkeys).
    const requestIdKey = arg(args, 2);
    const runningKey = arg(args, 3);
    const completedEntitiesKey = arg(args, 4);
    const totalKey = arg(args, 5);
    const legacyCompletedKey = arg(args, 6);
    const activeRequestId = arg(args, 7);
    const legacyRunningLockValue = arg(args, 8);
    const entityId = arg(args, 9);
    const runStateTtlSec = Number(arg(args, 10));

    const currentRequestId = state.strings.get(requestIdKey) ?? null;
    const runningValue = state.strings.get(runningKey) ?? null;
    if (currentRequestId !== activeRequestId) {
      return [0, 0, 0];
    }
    if (
      runningValue !== activeRequestId &&
      runningValue !== legacyRunningLockValue
    ) {
      return [0, 0, 0];
    }

    const completedSet =
      state.sets.get(completedEntitiesKey) ?? new Set<string>();
    completedSet.add(entityId);
    state.sets.set(completedEntitiesKey, completedSet);
    state.ttlSec.set(completedEntitiesKey, runStateTtlSec);

    // Deploy-transition compat: a pre-set run's finished entities live in the
    // legacy INCR counter, absent from the set. Add them so the run reaches total.
    const legacyCompleted =
      Number(state.strings.get(legacyCompletedKey) ?? "0") || 0;
    const total = Number(state.strings.get(totalKey) ?? "0") || 0;
    return [1, completedSet.size + legacyCompleted, total];
  },
});

describe("recordEntityCompletion", () => {
  const keys = {
    requestId: "workflow:ws_1:request-id",
    running: "workflow:ws_1:running",
    completedEntities: "workflow:ws_1:completed-entities",
    total: "workflow:ws_1:total",
    legacyCompleted: "workflow:ws_1:completed",
  };
  const activeRequestId = "req_1";
  const legacyRunningLockValue = "1";

  const seedActiveRun = (total: number): FakeRedisState => ({
    strings: new Map([
      [keys.requestId, activeRequestId],
      [keys.running, activeRequestId],
      [keys.total, String(total)],
    ]),
    sets: new Map(),
    ttlSec: new Map(),
  });

  const complete = async (state: FakeRedisState, entityId: string) =>
    await recordEntityCompletion({
      redis: createFakeRedis(state),
      keys,
      activeRequestId,
      legacyRunningLockValue,
      entityId,
      runStateTtlSec: 3600,
    });

  test("counts distinct entities, not repeated completions of the same one", async () => {
    // The class of bug: an entity job can run its completion path more than
    // once for the same run (timeout after completion, stalled-job reclaim,
    // exhausted-retry failure handler). A blind counter would over-count and
    // let `completed` reach `total` while another entity is still mid-flight.
    const state = seedActiveRun(2);

    const first = await complete(state, "entity_a");
    expect(first).toEqual({ matched: true, completed: 1, total: 2 });

    // Same entity again: idempotent, count does not advance and the run must
    // NOT be treated as finished (completed stays below total).
    const retry = await complete(state, "entity_a");
    expect(retry).toEqual({ matched: true, completed: 1, total: 2 });

    // A genuinely distinct entity finally reaches the total.
    const second = await complete(state, "entity_b");
    expect(second).toEqual({ matched: true, completed: 2, total: 2 });
  });

  test("does not finalize early when one entity double-completes", async () => {
    const state = seedActiveRun(3);
    // Two completions from entity_a (retry) plus one from entity_b: a counter
    // would read 3 and finalize; the set reads 2 distinct, so the run stays
    // open for the still-pending third entity.
    await complete(state, "entity_a");
    await complete(state, "entity_a");
    const latest = await complete(state, "entity_b");

    expect(latest.matched).toBe(true);
    if (!latest.matched) {
      throw new Error("expected a matched completion");
    }
    expect(latest.completed).toBe(2);
    expect(latest.completed < latest.total).toBe(true);
  });

  test("gives the completed-entities set the run-state TTL", async () => {
    const state = seedActiveRun(1);
    await complete(state, "entity_a");
    // Guards the no-TTL-leak fix: the set is created by the script and must
    // carry the run-state TTL so it self-heals rather than lingering forever.
    expect(state.ttlSec.get(keys.completedEntities)).toBe(3600);
  });

  test("clears a prior run's leftover completion set before counting", async () => {
    // The class of bug: the completion set is grown lazily via SADD, so it
    // can outlive the run-state that named it (worker death between the
    // script's EXPIRE and the sibling-key refresh, a manual lock deletion, a
    // TTL discrepancy). A new run reuses the same key, and its first SADD
    // would land in the stale set — SCARD could then reach `total` while
    // this run's entities are still mid-flight and finalize it early.
    const state = seedActiveRun(2);
    state.sets.set(
      keys.completedEntities,
      new Set(["entity_stale_1", "entity_stale_2"]),
    );

    await resetCompletionState({
      redis: createFakeRedis(state),
      completedEntitiesKey: keys.completedEntities,
      legacyCompletedKey: keys.legacyCompleted,
    });
    expect(state.sets.get(keys.completedEntities)).toBeUndefined();

    // The new run now counts only its own entities from a clean slate.
    const first = await complete(state, "entity_a");
    expect(first).toEqual({ matched: true, completed: 1, total: 2 });
  });

  test("does not record a completion for a superseded request", async () => {
    const state = seedActiveRun(2);
    // A new run reset the request-id/running lock; the stale job's completion
    // must be a no-op, leaving the new run's set untouched.
    state.strings.set(keys.requestId, "req_2");
    state.strings.set(keys.running, "req_2");

    const result = await complete(state, "entity_a");

    expect(result).toEqual({ matched: false });
    expect(state.sets.get(keys.completedEntities)).toBeUndefined();
  });

  test("finalizes an in-flight run that straddled a deploy", async () => {
    // The class of bug: a deploy lands mid-run. The pre-set code recorded
    // finished entities in the legacy `completed` INCR counter; those entities
    // never enter the new set. Counting the set alone would leave `completed`
    // permanently below `total`, so the run would never finalize.
    const state = seedActiveRun(3);
    state.strings.set(keys.legacyCompleted, "2"); // 2 entities finished pre-deploy

    // The remaining entity finishes post-deploy under the new set path.
    const result = await complete(state, "entity_c");

    // Effective completed = SCARD(1) + legacy(2) = 3 == total, so the run
    // reaches total and finalizes instead of stranding below it.
    expect(result).toEqual({ matched: true, completed: 3, total: 3 });
  });

  test("accepts the narrow overshoot when a pre-deploy entity retries post-deploy", async () => {
    // Documented, accepted window: an entity counted in the legacy counter is
    // retried post-deploy and also lands in the set, so it is counted twice
    // (legacy 2 + set 1 = 3 == total). Finalizing one completion early beats a
    // run that never finalizes; still no blind counting of post-deploy work.
    const state = seedActiveRun(3);
    state.strings.set(keys.legacyCompleted, "2");

    const result = await complete(state, "entity_a");

    expect(result).toEqual({ matched: true, completed: 3, total: 3 });
  });

  test("reset clears the legacy counter so fresh runs count the set alone", async () => {
    // Guards that the compat path dies with the transition: a stale legacy
    // counter left by a prior run must not inflate a fresh run's count and
    // finalize it early. resetCompletionState deletes it under the run lock.
    const state = seedActiveRun(2);
    state.strings.set(keys.legacyCompleted, "5");

    await resetCompletionState({
      redis: createFakeRedis(state),
      completedEntitiesKey: keys.completedEntities,
      legacyCompletedKey: keys.legacyCompleted,
    });
    expect(state.strings.get(keys.legacyCompleted)).toBeUndefined();

    const first = await complete(state, "entity_a");
    expect(first).toEqual({ matched: true, completed: 1, total: 2 });
  });
});
