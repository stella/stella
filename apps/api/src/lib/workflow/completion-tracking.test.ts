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
    if (command === "SET") {
      // Only the ["key", "1", "EX", "<sec>"] shape `resetCompletionState`
      // issues for the set-mode marker is exercised here.
      const key = arg(args, 0);
      const value = arg(args, 1);
      state.strings.set(key, value);
      if (arg(args, 2) === "EX") {
        state.ttlSec.set(key, Number(arg(args, 3)));
      }
      return "OK";
    }
    if (command !== "EVAL" || arg(args, 0) !== COMPLETE_ENTITY_SCRIPT) {
      throw new TypeError(`Unexpected Redis command: ${command}`);
    }
    // KEYS[1..6] then ARGV[1..4]; KEYS start at index 2 (after script + numkeys).
    const requestIdKey = arg(args, 2);
    const runningKey = arg(args, 3);
    const completedEntitiesKey = arg(args, 4);
    const totalKey = arg(args, 5);
    const legacyCompletedKey = arg(args, 6);
    const setModeKey = arg(args, 7);
    const activeRequestId = arg(args, 8);
    const legacyRunningLockValue = arg(args, 9);
    const entityId = arg(args, 10);
    const runStateTtlSec = Number(arg(args, 11));

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

    // Deploy-transition compat, gated to runs that never set the set-mode
    // marker: a pre-set run's finished entities live in the legacy INCR
    // counter, absent from the set. Add them so the run reaches total. A
    // run with the marker present (started under this code) never adds the
    // legacy counter, even if a straggler old-code replica repopulated it.
    const setMode = state.strings.has(setModeKey);
    let legacyCompleted = 0;
    if (setMode) {
      state.ttlSec.set(setModeKey, runStateTtlSec);
    } else {
      legacyCompleted =
        Number(state.strings.get(legacyCompletedKey) ?? "0") || 0;
    }
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
    setMode: "workflow:ws_1:set-mode",
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
      setModeKey: keys.setMode,
      runStateTtlSec: 3600,
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

  test("finalizes an in-flight run that straddled a deploy (no set-mode marker)", async () => {
    // The class of bug: a deploy lands mid-run. The pre-set code recorded
    // finished entities in the legacy `completed` INCR counter; those entities
    // never enter the new set. Counting the set alone would leave `completed`
    // permanently below `total`, so the run would never finalize. This run
    // predates the code that writes the set-mode marker (it never called
    // `resetCompletionState` under this code), so the marker key is absent
    // and the legacy counter still applies.
    const state = seedActiveRun(3);
    state.strings.set(keys.legacyCompleted, "2"); // 2 entities finished pre-deploy
    expect(state.strings.has(keys.setMode)).toBe(false);

    // The remaining entity finishes post-deploy under the new set path.
    const result = await complete(state, "entity_c");

    // Effective completed = SCARD(1) + legacy(2) = 3 == total, so the run
    // reaches total and finalizes instead of stranding below it.
    expect(result).toEqual({ matched: true, completed: 3, total: 3 });
  });

  test("accepts the narrow overshoot when a pre-deploy entity retries post-deploy", async () => {
    // Documented, accepted window for runs without a set-mode marker: an
    // entity counted in the legacy counter is retried post-deploy and also
    // lands in the set, so it is counted twice (legacy 2 + set 1 = 3 ==
    // total). Finalizing one completion early beats a run that never
    // finalizes; still no blind counting of post-deploy work.
    const state = seedActiveRun(3);
    state.strings.set(keys.legacyCompleted, "2");

    const result = await complete(state, "entity_a");

    expect(result).toEqual({ matched: true, completed: 3, total: 3 });
  });

  test("reset clears the legacy counter and writes the set-mode marker", async () => {
    // Guards that the compat path dies with the transition: a stale legacy
    // counter left by a prior run must not inflate a fresh run's count and
    // finalize it early. resetCompletionState deletes it under the run lock
    // and marks this run as set-mode so the legacy path can never apply to
    // it again, even if the key reappears later (see the straggler test
    // below).
    const state = seedActiveRun(2);
    state.strings.set(keys.legacyCompleted, "5");

    await resetCompletionState({
      redis: createFakeRedis(state),
      completedEntitiesKey: keys.completedEntities,
      legacyCompletedKey: keys.legacyCompleted,
      setModeKey: keys.setMode,
      runStateTtlSec: 3600,
    });
    expect(state.strings.get(keys.legacyCompleted)).toBeUndefined();
    expect(state.strings.get(keys.setMode)).toBe("1");
    expect(state.ttlSec.get(keys.setMode)).toBe(3600);

    const first = await complete(state, "entity_a");
    expect(first).toEqual({ matched: true, completed: 1, total: 2 });
  });

  test("CLASS GUARD: ignores a legacy counter a straggler old-code replica repopulates mid fresh-run", async () => {
    // The bug this round's fix closes: during a rolling deploy, queue
    // topology lets an old-code replica keep draining jobs from the shared
    // queue even for runs that started after the deploy. If that replica
    // dequeues one of THIS run's entity jobs, its old `onEntityCompleted`
    // logic blindly INCRs the legacy `completed` key — recreating it for a
    // run that already started fresh under set-mode tracking. Without the
    // marker gate, a subsequent new-code completion would add that
    // straggler value into the count and could finalize the run early
    // while other entities are still pending — reintroducing the exact bug
    // this PR exists to fix, on every rolling deploy.
    const state = seedActiveRun(3);
    await resetCompletionState({
      redis: createFakeRedis(state),
      completedEntitiesKey: keys.completedEntities,
      legacyCompletedKey: keys.legacyCompleted,
      setModeKey: keys.setMode,
      runStateTtlSec: 3600,
    });

    // entity_a finishes normally under new code.
    const first = await complete(state, "entity_a");
    expect(first).toEqual({ matched: true, completed: 1, total: 3 });

    // A straggler old-code replica processes entity_b and blindly INCRs the
    // legacy counter, recreating a key resetCompletionState had deleted.
    state.strings.set(keys.legacyCompleted, "1");

    // entity_c finishes under new code. If the legacy value leaked in, the
    // effective count would misread as SCARD(2) + legacy(1) = 3 == total
    // and finalize early — but entity_b never actually completed under new
    // code, so that would be wrong. The marker gate must keep the legacy
    // value out entirely.
    const third = await complete(state, "entity_c");

    // completed(2) < total(3): the run correctly stays open.
    expect(third).toEqual({ matched: true, completed: 2, total: 3 });
  });
});
