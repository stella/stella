import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { renderMemoryBlock } from "./memory-context";

const MEMORY_ID = toSafeId<"aiMemory">("memory_test");

describe("memory prompt rendering", () => {
  test("an oversized first memory cannot suppress later memories", () => {
    const { block } = renderMemoryBlock({
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

  test("reports how many rows the budget excluded", () => {
    // Silent truncation was the bug: the block just got shorter, and firm
    // memories (ordered last) disappeared with no signal anywhere.
    const { block, omittedRowCount, renderedRowIds } = renderMemoryBlock({
      contextMatterIds: [],
      rows: Array.from({ length: 8 }, (_unused, index) => ({
        id: toSafeId<"aiMemory">(`memory_${index}`),
        content: "b".repeat(900),
        kind: "preference" as const,
        pinned: false,
        scope: "user" as const,
        workspaceId: null,
      })),
    });

    expect(block.length).toBeLessThanOrEqual(2100);
    expect(omittedRowCount).toBeGreaterThan(0);
    expect(renderedRowIds).toHaveLength(8 - omittedRowCount);
  });

  test("reports nothing omitted when everything fits", () => {
    const { omittedRowCount, renderedRowIds } = renderMemoryBlock({
      contextMatterIds: [],
      rows: [
        {
          id: MEMORY_ID,
          content: "Use concise headings",
          kind: "instruction",
          pinned: false,
          scope: "user",
          workspaceId: null,
        },
      ],
    });

    expect(omittedRowCount).toBe(0);
    expect(renderedRowIds).toEqual([MEMORY_ID]);
  });

  test("does not count sanitized-empty rows as rendered", () => {
    const { omittedRowCount, renderedRowIds } = renderMemoryBlock({
      contextMatterIds: [],
      rows: [
        {
          id: MEMORY_ID,
          content: "\u0000\u0001",
          kind: "instruction",
          pinned: false,
          scope: "user",
          workspaceId: null,
        },
      ],
    });

    expect(omittedRowCount).toBe(0);
    expect(renderedRowIds).toHaveLength(0);
  });
});
