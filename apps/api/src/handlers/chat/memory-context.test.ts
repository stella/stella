import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { renderMemoryBlock } from "./memory-context";

const MEMORY_ID = toSafeId<"aiMemory">("memory_test");

describe("memory prompt rendering", () => {
  test("an oversized first memory cannot suppress later memories", () => {
    const block = renderMemoryBlock({
      contextMatterIds: [],
      rows: [
        {
          id: MEMORY_ID,
          content: "a".repeat(4000),
          kind: "preference",
          pinned: true,
          scope: "user",
          workspaceId: null,
        },
        {
          id: toSafeId<"aiMemory">("memory_short"),
          content: "Use concise headings",
          kind: "instruction",
          pinned: false,
          scope: "user",
          workspaceId: null,
        },
      ],
    });

    expect(block).toContain("a".repeat(100));
    expect(block).toContain("Use concise headings");
    expect(block.length).toBeLessThanOrEqual(2100);
  });
});
