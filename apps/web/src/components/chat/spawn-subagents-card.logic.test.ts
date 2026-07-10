import { describe, expect, test } from "bun:test";

import { keySpawnSubagents } from "@/components/chat/spawn-subagents-card.logic";

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
