import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import type { ChatMention } from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import {
  expandThreadDataScope,
  extractAssistantWorkspaceIds,
  extractMentionWorkspaceIds,
} from "./data-scope";

const wsA = toSafeId<"workspace">("00000000-0000-0000-0000-00000000000a");
const wsB = toSafeId<"workspace">("00000000-0000-0000-0000-00000000000b");
const wsC = toSafeId<"workspace">("00000000-0000-0000-0000-00000000000c");
const threadId = toSafeId<"chatThread">("00000000-0000-0000-0000-0000000000aa");

describe("extractMentionWorkspaceIds", () => {
  test("workspace mention contributes its own ID", () => {
    const mentions: ChatMention[] = [
      { id: wsA, label: "Matter A", category: "workspace" },
    ];
    expect(extractMentionWorkspaceIds(mentions)).toEqual([wsA]);
  });

  test("entity mention contributes its workspace ID", () => {
    const mentions: ChatMention[] = [
      {
        id: "entity_1",
        label: "Doc 1",
        category: "entity",
        workspaceId: wsA,
      },
    ];
    expect(extractMentionWorkspaceIds(mentions)).toEqual([wsA]);
  });

  test("entity mention without workspace contributes nothing", () => {
    const mentions: ChatMention[] = [
      {
        id: "entity_1",
        label: "Doc 1",
        category: "entity",
        workspaceId: null,
      },
    ];
    expect(extractMentionWorkspaceIds(mentions)).toEqual([]);
  });

  test("multiple mentions across workspaces deduplicate", () => {
    const mentions: ChatMention[] = [
      { id: wsA, label: "Matter A", category: "workspace" },
      {
        id: "entity_1",
        label: "Doc 1",
        category: "entity",
        workspaceId: wsA,
      },
      {
        id: "entity_2",
        label: "Doc 2",
        category: "entity",
        workspaceId: wsB,
      },
    ];
    expect(new Set(extractMentionWorkspaceIds(mentions))).toEqual(
      new Set([wsA, wsB]),
    );
  });
});

describe("extractAssistantWorkspaceIds", () => {
  test("source-document parts contribute their workspaceId", () => {
    const parts = [
      {
        type: "data-stella-source-document" as const,
        data: {
          entityId: "entity_1",
          kind: "document",
          mimeType: "application/pdf",
          title: "Motion.pdf",
          workspaceId: wsA,
        },
      },
    ];
    expect(extractAssistantWorkspaceIds(parts)).toEqual([wsA]);
  });

  test("source-document parts dedupe across workspaces", () => {
    const parts = [
      {
        type: "data-stella-source-document" as const,
        data: { workspaceId: wsA },
      },
      {
        type: "data-stella-source-document" as const,
        data: { workspaceId: wsB },
      },
      {
        type: "data-stella-source-document" as const,
        data: { workspaceId: wsA },
      },
    ];
    expect(new Set(extractAssistantWorkspaceIds(parts))).toEqual(
      new Set([wsA, wsB]),
    );
  });

  test("text parts without stella refs are ignored", () => {
    const parts = [
      { type: "text" as const, text: "Just a normal reply, no refs." },
      { type: "data-stella-mentions" as const, data: { mentions: [] } },
    ];
    expect(extractAssistantWorkspaceIds(parts)).toEqual([]);
  });

  test("regression: assistant text refs widen the data scope", () => {
    // Resolved by `resolveAssistantTextRefs` after the stream
    // finishes; the workspace ID then needs to be added to
    // `data_workspace_ids` so the persisted reply doesn't
    // outlive the user's access to that workspace.
    const parts = [
      {
        type: "text" as const,
        text: `See [matter](#stella-workspace=${wsA}) and the related document at #stella-entity=${wsB}:abc.`,
      },
    ];
    expect(new Set(extractAssistantWorkspaceIds(parts))).toEqual(
      new Set([wsA, wsB]),
    );
  });

  test("text and source-document parts are unioned", () => {
    const parts = [
      {
        type: "data-stella-source-document" as const,
        data: { workspaceId: wsA },
      },
      {
        type: "text" as const,
        text: `more context #stella-workspace=${wsB}`,
      },
    ];
    expect(new Set(extractAssistantWorkspaceIds(parts))).toEqual(
      new Set([wsA, wsB]),
    );
  });

  test("malformed UUIDs in text refs are ignored", () => {
    const parts = [
      {
        type: "text" as const,
        text: "garbage #stella-workspace=not-a-uuid and #stella-entity=zz:yy",
      },
    ];
    expect(extractAssistantWorkspaceIds(parts)).toEqual([]);
  });

  test("regression: tool output parts with matterRef widen the data scope", () => {
    // Tool outputs persist UUIDs in `matterRef` / `workspaceId`
    // fields after `resolveAssistantValueRefs` rehydrates them
    // from the in-memory `mat_N` ref shorthand. Without scanning
    // these, a thread that only contains tool output (no
    // source-document parts and no text refs) would keep an
    // empty data scope and leak after revocation.
    const parts = [
      {
        type: "tool-listMatters-output" as const,
        toolCallId: "call_1",
        state: "output-available" as const,
        output: {
          items: [
            { matterRef: wsA, name: "Matter A" },
            { matterRef: wsB, name: "Matter B" },
          ],
          nextOffset: null,
          hasMore: false,
        },
      },
    ];
    expect(new Set(extractAssistantWorkspaceIds(parts))).toEqual(
      new Set([wsA, wsB]),
    );
  });

  test("regression: deeply nested workspaceId fields are picked up", () => {
    const parts = [
      {
        type: "tool-getProperty-output" as const,
        output: {
          property: {
            id: "prop_1",
            owner: { workspaceId: wsA },
          },
        },
      },
    ];
    expect(extractAssistantWorkspaceIds(parts)).toEqual([wsA]);
  });

  test("non-UUID matterRef values are ignored (e.g. unresolved ref shorthand)", () => {
    // If a tool output ever lands with the in-memory shorthand
    // (mat_1) instead of a UUID, the structural walker must not
    // brand it as a workspace ID and must not crash.
    const parts = [
      {
        type: "tool-listMatters-output" as const,
        output: { items: [{ matterRef: "mat_1" }] },
      },
    ];
    expect(extractAssistantWorkspaceIds(parts)).toEqual([]);
  });

  test("source-document with empty workspaceId contributes nothing", () => {
    const parts = [
      {
        type: "data-stella-source-document" as const,
        data: { workspaceId: "" },
      },
      {
        type: "data-stella-source-document" as const,
        data: { workspaceId: null },
      },
    ];
    expect(extractAssistantWorkspaceIds(parts)).toEqual([]);
  });
});

describe("expandThreadDataScope", () => {
  const buildTx = () => {
    const setMock = mock(() => ({
      where: mock(async () => undefined),
    }));
    const updateMock = mock(() => ({ set: setMock }));
    const tx = { update: updateMock };
    const { safeDb } = createScopedDbMock(tx);
    return { safeDb, updateMock, setMock };
  };

  test("no new IDs → no UPDATE issued", async () => {
    const { safeDb, updateMock } = buildTx();
    const result = await expandThreadDataScope({
      currentDataWorkspaceIds: [wsA],
      newWorkspaceIds: [],
      safeDb,
      threadId,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
  });

  test("all new IDs already present → no UPDATE issued", async () => {
    const { safeDb, updateMock } = buildTx();
    const result = await expandThreadDataScope({
      currentDataWorkspaceIds: [wsA, wsB],
      newWorkspaceIds: [wsA, wsB],
      safeDb,
      threadId,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
  });

  test("regression: genuinely new workspace IDs trigger UPDATE", async () => {
    const { safeDb, updateMock, setMock } = buildTx();
    const result = await expandThreadDataScope({
      currentDataWorkspaceIds: [wsA],
      newWorkspaceIds: [wsB, wsC],
      safeDb,
      threadId,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledTimes(1);
    if (Result.isOk(result)) {
      expect(new Set<SafeId<"workspace">>(result.value)).toEqual(
        new Set([wsA, wsB, wsC]),
      );
    }
  });

  test("partial overlap: only the genuinely-new IDs are appended", async () => {
    const { safeDb, updateMock } = buildTx();
    const result = await expandThreadDataScope({
      currentDataWorkspaceIds: [wsA, wsB],
      newWorkspaceIds: [wsB, wsC],
      safeDb,
      threadId,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);
    if (Result.isOk(result)) {
      expect(new Set<SafeId<"workspace">>(result.value)).toEqual(
        new Set([wsA, wsB, wsC]),
      );
    }
  });
});
