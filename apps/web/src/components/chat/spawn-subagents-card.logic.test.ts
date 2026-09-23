import { describe, expect, test } from "bun:test";

import {
  getSpawnSubagentsCallStatus,
  keySpawnSubagents,
  SPAWN_SUBAGENTS_CALL_STATUS,
  SPAWN_SUBAGENTS_CALL_STATUS_BY_STATE,
} from "@/components/chat/spawn-subagents-card.logic";
import type {
  SpawnSubagentsCallStatus,
  SpawnSubagentsToolCallState,
} from "@/components/chat/spawn-subagents-card.logic";

describe("spawn subagent row identity", () => {
  test("is stable when distinct subtasks reorder", () => {
    const first = { task: "Research authorities", model: "fast" };
    const second = { task: "Check citations" };

    const original = keySpawnSubagents([first, second]);
    const reordered = keySpawnSubagents([second, first]);

    expect(original.map(({ key }) => key).toSorted()).toEqual(
      reordered.map(({ key }) => key).toSorted(),
    );
  });

  test("disambiguates identical subtasks without using their positions", () => {
    const subagent = { task: "Review the draft" };

    const keyed = keySpawnSubagents([subagent, subagent]);

    expect(keyed[0]?.key).not.toBe(keyed[1]?.key);
    expect(keyed.map(({ index }) => index)).toEqual([0, 1]);
  });
});

// Typed against the SDK state union: adding, removing, or renaming a state
// fails typecheck here until its expected card status is chosen.
const EXPECTED_CALL_STATUS = {
  "awaiting-input": SPAWN_SUBAGENTS_CALL_STATUS.running,
  "input-streaming": SPAWN_SUBAGENTS_CALL_STATUS.running,
  "input-complete": SPAWN_SUBAGENTS_CALL_STATUS.running,
  "approval-requested": SPAWN_SUBAGENTS_CALL_STATUS.awaitingApproval,
  "approval-responded": SPAWN_SUBAGENTS_CALL_STATUS.running,
  complete: SPAWN_SUBAGENTS_CALL_STATUS.done,
  error: SPAWN_SUBAGENTS_CALL_STATUS.failed,
} as const satisfies Record<
  SpawnSubagentsToolCallState,
  SpawnSubagentsCallStatus
>;

describe("spawn subagents call status", () => {
  test("decides every tool-call state explicitly", () => {
    expect(SPAWN_SUBAGENTS_CALL_STATUS_BY_STATE).toEqual(EXPECTED_CALL_STATUS);
  });

  test("settles terminal states without a running indicator", () => {
    expect(getSpawnSubagentsCallStatus({ state: "error" })).toBe(
      SPAWN_SUBAGENTS_CALL_STATUS.failed,
    );
    expect(getSpawnSubagentsCallStatus({ state: "complete" })).toBe(
      SPAWN_SUBAGENTS_CALL_STATUS.done,
    );
  });

  test("waits on the user, not on execution, while approval is requested", () => {
    expect(getSpawnSubagentsCallStatus({ state: "approval-requested" })).toBe(
      SPAWN_SUBAGENTS_CALL_STATUS.awaitingApproval,
    );
  });

  test("runs after an approval and settles after a decline", () => {
    expect(
      getSpawnSubagentsCallStatus({
        approval: { approved: true },
        state: "approval-responded",
      }),
    ).toBe(SPAWN_SUBAGENTS_CALL_STATUS.running);
    expect(
      getSpawnSubagentsCallStatus({
        approval: { approved: false },
        state: "approval-responded",
      }),
    ).toBe(SPAWN_SUBAGENTS_CALL_STATUS.declined);
  });
});
