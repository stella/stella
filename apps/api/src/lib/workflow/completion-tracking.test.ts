import { describe, expect, test } from "bun:test";

import {
  COMPLETE_ENTITY_SCRIPT,
  parseEntityCompletionReply,
  recordEntityCompletion,
  resetCompletionState,
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
    if (command !== "EVAL" || arg(args, 0) !== COMPLETE_ENTITY_SCRIPT) {
      throw new TypeError(`Unexpected Redis command: ${command}`);
    }

    const requestIdKey = arg(args, 2);
    const runningKey = arg(args, 3);
    const completedEntitiesKey = arg(args, 4);
    const totalKey = arg(args, 5);
    const activeRequestId = arg(args, 6);
    const entityId = arg(args, 7);
    const runStateTtlSec = Number(arg(args, 8));

    if (
      state.strings.get(requestIdKey) !== activeRequestId ||
      state.strings.get(runningKey) !== activeRequestId
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
    return [1, completed.size, total];
  },
});

describe("entity completion state", () => {
  const keys = {
    requestId: "workflow:ws_1:request-id",
    running: "workflow:ws_1:running",
    completedEntities: "workflow:ws_1:completed-entities",
    total: "workflow:ws_1:total",
  };
  const activeRequestId = "req_1";

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
    });
    expect(state.sets.has(keys.completedEntities)).toBe(false);
    expect(await complete(state, "entity_a")).toEqual({
      matched: true,
      completed: 1,
      total: 2,
    });
  });

  test("rejects superseded and obsolete constant-valued locks", async () => {
    const superseded = seedActiveRun(2);
    superseded.strings.set(keys.requestId, "req_2");
    superseded.strings.set(keys.running, "req_2");
    expect(await complete(superseded, "entity_a")).toEqual({
      matched: false,
    });

    const obsolete = seedActiveRun(2);
    obsolete.strings.set(keys.running, "1");
    expect(await complete(obsolete, "entity_a")).toEqual({ matched: false });
    expect(obsolete.sets.has(keys.completedEntities)).toBe(false);
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
