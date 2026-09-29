import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import {
  brandPersistedEntityId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

import { renderMemoryBlock } from "./memory-context";

const MEMORY_ID = toSafeId<"aiMemory">("memory_test");
const keepText = (text: string) => text;

describe("memory prompt rendering", () => {
  test("an oversized first memory cannot suppress later memories", () => {
    const { block } = renderMemoryBlock({
      hydrateRefs: keepText,
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
      hydrateRefs: keepText,
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
      hydrateRefs: keepText,
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
      hydrateRefs: keepText,
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

  test("a memory written in one thread names the same document in another", () => {
    const target = {
      entityId: brandPersistedEntityId("01a0df7d-c93a-7105-99f9-c66cf1b14d0a"),
      workspaceId: brandPersistedWorkspaceId(
        "01a0df7d-c93a-7105-99f9-c66cf1b14d01",
      ),
    };
    const other = {
      entityId: brandPersistedEntityId("01a0df7d-c93a-7105-99f9-c66cf1b14d0b"),
      workspaceId: target.workspaceId,
    };
    // Thread A shows the model `ent_2` for the template; the memory it
    // writes must not keep that spelling.
    const threadA = createChatRefRegistry();
    threadA.toEntityRef(other);
    const ref = threadA.toEntityRef(target);
    const stored = threadA.toDurableRefText(
      `Use ${ref} as the template, not ent_9 or contact_1`,
    );
    expect(stored).not.toContain(ref);

    // In thread B the same spelling already names another document.
    const threadB = createChatRefRegistry();
    expect(threadB.toEntityRef(other)).toBe("ent_1");
    threadB.toEntityRef({
      entityId: brandPersistedEntityId("01a0df7d-c93a-7105-99f9-c66cf1b14d0c"),
      workspaceId: target.workspaceId,
    });
    const { block } = renderMemoryBlock({
      hydrateRefs: threadB.hydrateAssistantTextRefs,
      contextMatterIds: [],
      rows: [
        {
          id: MEMORY_ID,
          content: stored,
          kind: "instruction",
          pinned: false,
          scope: "user",
          workspaceId: null,
        },
      ],
    });

    const shown = /#stella-entity-ref=(ent_\d+)/u.exec(block)?.[1];
    expect(shown).toBeDefined();
    const resolved = threadB.resolveEntityRefTargets([shown ?? ""]);
    expect(resolved.isOk() ? resolved.value : null).toEqual([target]);
    expect(block).toContain("(unavailable reference)");
  });
});
