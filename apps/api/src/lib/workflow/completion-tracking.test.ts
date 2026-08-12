import { describe, expect, test } from "bun:test";

import { coordinationKey } from "@/api/lib/redis-keys";
import {
  COMPLETE_ENTITY_SCRIPT,
  parseEntityCompletionReply,
  recordEntityCompletion,
  resetCompletionState,
  type WorkflowCompletionKeys,
} from "@/api/lib/workflow/completion-tracking";

describe("completion reply validation", () => {
  test("accepts bounded integer progress", () => {
    expect(parseEntityCompletionReply([1, 3, 10])).toEqual({
      matched: true,
      completed: 3,
      total: 10,
    });
  });

  test("fails closed for unmatched and malformed replies", () => {
    for (const reply of [
      [0, 0, 0],
      [1, 3],
      [1, "x", 10],
      [1, 3, "y"],
      [1, -1, 10],
      [1, 11, 10],
      [1, 1, 0],
      null,
      undefined,
      "OK",
    ]) {
      expect(parseEntityCompletionReply(reply)).toEqual({ matched: false });
    }
  });
});

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
      for (const key of args) {
        state.strings.delete(key);
        state.sets.delete(key);
        state.ttlSec.delete(key);
      }
      return args.length;
    }
    if (command === "SET") {
      state.strings.set(arg(args, 0), arg(args, 1));
      if (arg(args, 2) === "EX") {
        state.ttlSec.set(arg(args, 0), Number(arg(args, 3)));
      }
      return "OK";
    }
    if (command !== "EVAL" || arg(args, 0) !== COMPLETE_ENTITY_SCRIPT) {
      throw new TypeError(`Unexpected Redis command: ${command}`);
    }

    const requestIdKey = arg(args, 2);
    const runningKey = arg(args, 3);
    const completedEntitiesKey = arg(args, 4);
    const totalKey = arg(args, 5);
    const transitionalCompletedKey = arg(args, 6);
    const setModeKey = arg(args, 7);
    const activeRequestId = arg(args, 8);
    const transitionalRunningLockValue = arg(args, 9);
    const entityId = arg(args, 10);
    const runStateTtlSec = Number(arg(args, 11));

    if (
      state.strings.get(requestIdKey) !== activeRequestId ||
      (state.strings.get(runningKey) !== activeRequestId &&
        state.strings.get(runningKey) !== transitionalRunningLockValue)
    ) {
      return [0, 0, 0];
    }
    const total = Number(state.strings.get(totalKey));
    if (!Number.isFinite(total) || total < 1) {
      return [0, 0, 0];
    }

    const completed = state.sets.get(completedEntitiesKey) ?? new Set<string>();
    completed.add(entityId);
    state.sets.set(completedEntitiesKey, completed);
    state.ttlSec.set(completedEntitiesKey, runStateTtlSec);
    let completedCount = completed.size;
    if (state.strings.has(setModeKey)) {
      state.ttlSec.set(setModeKey, runStateTtlSec);
    } else {
      completedCount +=
        Number(state.strings.get(transitionalCompletedKey)) || 0;
      state.ttlSec.set(transitionalCompletedKey, runStateTtlSec);
    }
    return [1, Math.min(completedCount, total), total];
  },
});

describe("entity completion state", () => {
  // Built through the shared key builder rather than spelled out, so the
  // fixture cannot drift from the hashtag layout the script depends on.
  const runKey = (suffix: string) =>
    coordinationKey({ scope: "workflow-run", slot: "ws_1", suffix });
  const keys = {
    requestId: runKey("request-id"),
    running: runKey("running"),
    completedEntities: runKey("completed-entities"),
    total: runKey("total"),
    transitionalCompleted: runKey("completed"),
    setMode: runKey("set-mode"),
  } satisfies WorkflowCompletionKeys;
  const activeRequestId = "req_1";
  const transitionalRunningLockValue = "1";

  const seedActiveRun = (total: number): FakeRedisState => ({
    strings: new Map([
      [keys.requestId, activeRequestId],
      [keys.running, activeRequestId],
      [keys.total, String(total)],
      [keys.setMode, "1"],
    ]),
    sets: new Map(),
    ttlSec: new Map(),
  });

  const complete = async (state: FakeRedisState, entityId: string) =>
    await recordEntityCompletion({
      redis: createFakeRedis(state),
      keys,
      activeRequestId,
      transitionalRunningLockValue,
      entityId,
      runStateTtlSec: 3600,
    });

  test("counts each entity once across retries", async () => {
    const state = seedActiveRun(2);
    expect(await complete(state, "entity_a")).toEqual({
      matched: true,
      completed: 1,
      total: 2,
    });
    expect(await complete(state, "entity_a")).toEqual({
      matched: true,
      completed: 1,
      total: 2,
    });
    expect(await complete(state, "entity_b")).toEqual({
      matched: true,
      completed: 2,
      total: 2,
    });
  });

  test("refreshes the completion set lease", async () => {
    const state = seedActiveRun(1);
    await complete(state, "entity_a");
    expect(state.ttlSec.get(keys.completedEntities)).toBe(3600);
  });

  test("clears stale completion members before a new run", async () => {
    const state = seedActiveRun(2);
    state.sets.set(keys.completedEntities, new Set(["stale_a", "stale_b"]));
    await resetCompletionState({
      redis: createFakeRedis(state),
      completedEntitiesKey: keys.completedEntities,
      transitionalCompletedKey: keys.transitionalCompleted,
      setModeKey: keys.setMode,
      runStateTtlSec: 3600,
    });
    expect(state.sets.has(keys.completedEntities)).toBe(false);
    expect(state.strings.get(keys.setMode)).toBe("1");
    expect(await complete(state, "entity_a")).toEqual({
      matched: true,
      completed: 1,
      total: 2,
    });
  });

  test("rejects superseded locks", async () => {
    const superseded = seedActiveRun(2);
    superseded.strings.set(keys.requestId, "req_2");
    superseded.strings.set(keys.running, "req_2");
    expect(await complete(superseded, "entity_a")).toEqual({
      matched: false,
    });
  });

  test("finishes a persisted constant-lock run using its prior counter", async () => {
    const transitional = seedActiveRun(2);
    transitional.strings.set(keys.running, transitionalRunningLockValue);
    transitional.strings.delete(keys.setMode);
    transitional.strings.set(keys.transitionalCompleted, "1");

    expect(await complete(transitional, "entity_b")).toEqual({
      matched: true,
      completed: 2,
      total: 2,
    });
    expect(transitional.ttlSec.get(keys.transitionalCompleted)).toBe(3600);
  });

  test("ignores the old counter for a set-mode run", async () => {
    const state = seedActiveRun(2);
    state.strings.set(keys.transitionalCompleted, "99");

    expect(await complete(state, "entity_a")).toEqual({
      matched: true,
      completed: 1,
      total: 2,
    });
  });

  test("rejects missing or invalid totals before mutating completion", async () => {
    await Promise.all(
      ["0", "invalid"].map(async (total) => {
        const state = seedActiveRun(1);
        state.strings.set(keys.total, total);
        expect(await complete(state, "entity_a")).toEqual({ matched: false });
        expect(state.sets.has(keys.completedEntities)).toBe(false);
      }),
    );
  });
});
