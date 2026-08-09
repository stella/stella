import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import {
  resourceRef,
  RESOURCE_TYPE,
  toChatResourceHref,
} from "@stll/api-contract";

import type { ChatMention, ChatMessage } from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { expandThreadDataScope } from "@/api/lib/chat/data-scope";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import {
  computeAssistantTurnWorkspaceIds,
  extractAssistantWorkspaceIds,
  extractIncomingMessageWorkspaceIds,
  extractMessageWorkspaceIds,
  extractMentionWorkspaceIds,
  extractThreadDataWorkspaceIds,
} from "./data-scope";

const wsA = toSafeId<"workspace">("00000000-0000-0000-0000-00000000000a");
const wsB = toSafeId<"workspace">("00000000-0000-0000-0000-00000000000b");
const wsC = toSafeId<"workspace">("00000000-0000-0000-0000-00000000000c");
const threadId = toSafeId<"chatThread">("00000000-0000-0000-0000-0000000000aa");

const workspaceMention = ({
  id,
  label,
}: {
  id: SafeId<"workspace">;
  label: string;
}): ChatMention => ({
  category: "workspace",
  id,
  label,
  resource: resourceRef({ type: RESOURCE_TYPE.WORKSPACE, id }),
});

const entityMention = ({
  id,
  label,
  workspaceId,
}: {
  id: string;
  label: string;
  workspaceId: SafeId<"workspace"> | null;
}): ChatMention => ({
  category: "entity",
  id,
  label,
  resource: resourceRef({
    type: RESOURCE_TYPE.ENTITY,
    id: toSafeId<"entity">(id),
  }),
  workspaceId,
});

describe("extractMentionWorkspaceIds", () => {
  test("workspace mention contributes its own ID", () => {
    const mentions = [workspaceMention({ id: wsA, label: "Matter A" })];
    expect(extractMentionWorkspaceIds(mentions)).toEqual([wsA]);
  });

  test("entity mention contributes its workspace ID", () => {
    const mentions = [
      entityMention({ id: "entity_1", label: "Doc 1", workspaceId: wsA }),
    ];
    expect(extractMentionWorkspaceIds(mentions)).toEqual([wsA]);
  });

  test("entity mention without workspace contributes nothing", () => {
    const mentions = [
      entityMention({ id: "entity_1", label: "Doc 1", workspaceId: null }),
    ];
    expect(extractMentionWorkspaceIds(mentions)).toEqual([]);
  });

  test("multiple mentions across workspaces deduplicate", () => {
    const mentions = [
      workspaceMention({ id: wsA, label: "Matter A" }),
      entityMention({ id: "entity_1", label: "Doc 1", workspaceId: wsA }),
      entityMention({ id: "entity_2", label: "Doc 2", workspaceId: wsB }),
    ];
    expect(new Set(extractMentionWorkspaceIds(mentions))).toEqual(
      new Set([wsA, wsB]),
    );
  });
});

describe("extractAssistantWorkspaceIds", () => {
  test("source-document metadata contributes its workspaceId", () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      parts: [],
      metadata: {
        sourceDocuments: [
          {
            entityId: "entity_1",
            kind: "document",
            mimeType: "application/pdf",
            title: "Motion.pdf",
            workspaceId: wsA,
          },
        ],
      },
    } satisfies ChatMessage;
    expect(extractMessageWorkspaceIds(message)).toEqual([wsA]);
  });

  test("source-document metadata dedupes across workspaces", () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      parts: [],
      metadata: {
        sourceDocuments: [
          {
            entityId: "entity-1",
            kind: "document",
            mimeType: "application/pdf",
            title: "A",
            workspaceId: wsA,
          },
          {
            entityId: "entity-2",
            kind: "document",
            mimeType: "application/pdf",
            title: "B",
            workspaceId: wsB,
          },
          {
            entityId: "entity-3",
            kind: "document",
            mimeType: "application/pdf",
            title: "C",
            workspaceId: wsA,
          },
        ],
      },
    } satisfies ChatMessage;
    expect(new Set(extractMessageWorkspaceIds(message))).toEqual(
      new Set([wsA, wsB]),
    );
  });

  test("text parts without stella refs are ignored", () => {
    const parts = [
      { type: "text" as const, content: "Just a normal reply, no refs." },
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
        content: `See [matter](#stella-workspace=${wsA}) and the related document at #stella-entity=${wsB}:00000000-0000-0000-0000-000000000001.`,
      },
    ];
    expect(new Set(extractAssistantWorkspaceIds(parts))).toEqual(
      new Set([wsA, wsB]),
    );
  });

  test("regression: canonical links widen scope for opaque workspace IDs", () => {
    const workspaceId = toSafeId<"workspace">("imported:matter");
    const entityId = toSafeId<"entity">("document:42");
    const workspaceHref = toChatResourceHref({
      type: RESOURCE_TYPE.WORKSPACE,
      resource: resourceRef({ type: RESOURCE_TYPE.WORKSPACE, id: workspaceId }),
    });
    const entityHref = toChatResourceHref({
      type: RESOURCE_TYPE.ENTITY,
      resource: resourceRef({ type: RESOURCE_TYPE.ENTITY, id: entityId }),
      location: {
        type: "workspace",
        workspace: resourceRef({
          type: RESOURCE_TYPE.WORKSPACE,
          id: workspaceId,
        }),
      },
    });
    const parts = [
      {
        type: "text" as const,
        content: `See [Matter](${workspaceHref}) and [Document](${entityHref}).`,
      },
    ];

    expect(extractAssistantWorkspaceIds(parts)).toEqual([workspaceId]);
  });

  test("bare links stop before sentence punctuation", () => {
    const workspaceHref = toChatResourceHref({
      type: RESOURCE_TYPE.WORKSPACE,
      resource: resourceRef({ type: RESOURCE_TYPE.WORKSPACE, id: wsA }),
    });
    const parts = [
      {
        type: "text" as const,
        content: `See ${workspaceHref}.`,
      },
    ];

    expect(extractAssistantWorkspaceIds(parts)).toEqual([wsA]);
  });

  test("does not partially accept malformed canonical links", () => {
    const parts = [
      {
        type: "text" as const,
        content:
          "Ignore #stella-workspace=imported-matter%ZZ and #stella-entity=imported-matter:%ZZ.",
      },
    ];

    expect(extractAssistantWorkspaceIds(parts)).toEqual([]);
  });

  test("text and source-document metadata are unioned", () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "text" as const,
          content: `more context #stella-workspace=${wsB}`,
        },
      ],
      metadata: {
        sourceDocuments: [
          {
            entityId: "entity-1",
            kind: "document",
            mimeType: "application/pdf",
            title: "A",
            workspaceId: wsA,
          },
        ],
      },
    } satisfies ChatMessage;
    expect(new Set(extractMessageWorkspaceIds(message))).toEqual(
      new Set([wsA, wsB]),
    );
  });

  test("malformed encoded IDs in text refs are ignored", () => {
    const parts = [
      {
        type: "text" as const,
        content:
          "garbage #stella-workspace=bad%encoding and #stella-entity=bad%encoding:entity-1",
      },
    ];
    expect(extractAssistantWorkspaceIds(parts)).toEqual([]);
  });

  test("relative entity links do not masquerade as workspace identities", () => {
    const parts = [
      {
        type: "text" as const,
        content: `relative #stella-entity=${wsA}`,
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
        type: "tool-call" as const,
        id: "call_1",
        name: "mcp__test__listMatters",
        arguments: "{}",
        state: "complete" as const,
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
        type: "tool-call" as const,
        id: "call_1",
        name: "mcp__test__getProperty",
        arguments: "{}",
        state: "complete" as const,
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
        type: "tool-call" as const,
        id: "call_1",
        name: "mcp__test__listMatters",
        arguments: "{}",
        state: "complete" as const,
        output: { items: [{ matterRef: "mat_1" }] },
      },
    ];
    expect(extractAssistantWorkspaceIds(parts)).toEqual([]);
  });

  test("source-document metadata with empty workspaceId contributes nothing", () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      parts: [],
      metadata: {
        sourceDocuments: [
          {
            entityId: "entity-1",
            kind: "document",
            mimeType: "application/pdf",
            title: "A",
            workspaceId: "",
          },
          {
            entityId: "entity-2",
            kind: "document",
            mimeType: "application/pdf",
            title: "B",
            workspaceId: null,
          },
        ],
      },
    } satisfies ChatMessage;
    expect(extractMessageWorkspaceIds(message)).toEqual([]);
  });
});

describe("extractIncomingMessageWorkspaceIds", () => {
  test("assistant create-document outputs widen the data scope", () => {
    const message = {
      id: "assistant-created-doc",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "tool-call-1",
          name: "create-document",
          arguments: JSON.stringify({
            name: "Generated Agreement",
            source: "@title Generated Agreement",
          }),
          state: "complete",
          input: {
            name: "Generated Agreement",
            source: "@title Generated Agreement",
          },
          output: {
            success: true,
            fileName: "Generated Agreement.docx",
            entityId: "00000000-0000-0000-0000-0000000000ee",
            fieldId: "00000000-0000-0000-0000-0000000000ff",
            workspaceId: wsA,
            entityRef: "ent_1",
            matterRef: "mat_1",
            href: `#stella-entity=${wsA}:00000000-0000-0000-0000-0000000000ee`,
            mention: "[Generated Agreement](#stella-entity-ref=ent_1)",
          },
        },
      ],
    } satisfies ChatMessage;

    expect(
      extractIncomingMessageWorkspaceIds({ message, mentions: [] }),
    ).toEqual([wsA]);
  });
});

describe("extractThreadDataWorkspaceIds", () => {
  test("recomputes scope from retained persisted messages", () => {
    const messages = [
      {
        id: "user-1",
        role: "user",
        parts: [
          {
            type: "text",
            content: `Use [Matter A](#stella-workspace=${wsA}) and [Doc B](#stella-entity=${wsB}:00000000-0000-0000-0000-000000000001).`,
          },
        ],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [],
        metadata: {
          sourceDocuments: [
            {
              entityId: "00000000-0000-0000-0000-000000000002",
              kind: "document",
              mimeType: "application/pdf",
              title: "Motion.pdf",
              workspaceId: wsC,
            },
          ],
        },
      },
    ] satisfies ChatMessage[];

    expect(new Set(extractThreadDataWorkspaceIds(messages))).toEqual(
      new Set([wsA, wsB, wsC]),
    );
  });

  test("excludes workspace refs from messages omitted by replay truncation", () => {
    const messagesBeforeTruncation = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", content: `Keep #stella-workspace=${wsA}` }],
      },
      {
        id: "assistant-deleted",
        role: "assistant",
        parts: [{ type: "text", content: `Drop #stella-workspace=${wsC}` }],
      },
    ] satisfies ChatMessage[];

    expect(
      extractThreadDataWorkspaceIds(messagesBeforeTruncation.slice(0, 1)),
    ).toEqual([wsA]);
  });
});

describe("computeAssistantTurnWorkspaceIds", () => {
  // `send-message.ts` snapshots `refRegistry.getRegisteredWorkspaceIds()`
  // before streaming and diffs it against the post-stream snapshot passed
  // here as `registeredWorkspaceIdsAfterStream`. This is the mechanism that
  // widens `chat_threads.data_workspace_ids` when a `spawn_subagents`
  // subagent reads workspace-scoped content and only returns a free-form
  // text summary — no structural `matterRef`/`workspaceId` field or
  // `#stella-*` ref ever reaches the parent's response parts, so the
  // structural scan alone would miss it.

  test("folds in a workspace a subagent registered mid-stream, even with no matching response part", () => {
    const ids = computeAssistantTurnWorkspaceIds({
      responseParts: [
        { type: "text", content: "Done — see the summary above." },
      ],
      workspaceIdsBeforeStream: new Set(),
      registeredWorkspaceIdsAfterStream: [wsA],
      accessibleWorkspaceIds: new Set([wsA]),
    });

    expect(ids).toEqual([wsA]);
  });

  test("folds in every workspace an opaque sandbox run could read", () => {
    const ids = computeAssistantTurnWorkspaceIds({
      accessibleWorkspaceIds: new Set([wsA, wsB]),
      opaqueReadWorkspaceIds: [wsA, wsB],
      registeredWorkspaceIdsAfterStream: [],
      responseParts: [
        { content: "A summary without structured refs", type: "text" },
      ],
      workspaceIdsBeforeStream: new Set(),
    });

    expect(ids).toEqual([wsA, wsB]);
  });

  test("excludes a workspace that was already registered before the stream started", () => {
    // Prompt-time pins / prior-turn history refs should not re-widen scope
    // on every later turn.
    const ids = computeAssistantTurnWorkspaceIds({
      responseParts: [],
      workspaceIdsBeforeStream: new Set([wsA]),
      registeredWorkspaceIdsAfterStream: [wsA],
      accessibleWorkspaceIds: new Set([wsA]),
    });

    expect(ids).toEqual([]);
  });

  test("drops a subagent-registered workspace the caller can no longer access", () => {
    // Guards against a stale/revoked workspace id ever reaching
    // `data_workspace_ids`, mirroring the same accessibleWorkspaceIds
    // intersection `extractIncomingMessageWorkspaceIds` callers apply.
    const ids = computeAssistantTurnWorkspaceIds({
      responseParts: [],
      workspaceIdsBeforeStream: new Set(),
      registeredWorkspaceIdsAfterStream: [wsA],
      accessibleWorkspaceIds: new Set(),
    });

    expect(ids).toEqual([]);
  });

  test("unions the structural response scan with the registry delta", () => {
    const ids = computeAssistantTurnWorkspaceIds({
      responseParts: [
        {
          type: "tool-call",
          id: "call_1",
          name: "mcp__test__listMatters",
          arguments: "{}",
          state: "complete",
          output: { items: [{ matterRef: wsB, name: "Matter B" }] },
        },
      ],
      workspaceIdsBeforeStream: new Set(),
      registeredWorkspaceIdsAfterStream: [wsA],
      accessibleWorkspaceIds: new Set([wsA, wsB]),
    });

    expect(new Set(ids)).toEqual(new Set([wsA, wsB]));
  });
});

describe("expandThreadDataScope", () => {
  const buildTx = (initialDataWorkspaceIds: SafeId<"workspace">[] = []) => {
    let dataWorkspaceIds = [...initialDataWorkspaceIds];
    const returningMock = mock(async () => [{ dataWorkspaceIds }]);
    const whereUpdateMock = mock(() => ({ returning: returningMock }));
    const setMock = mock(({ dataWorkspaceIds: nextDataWorkspaceIds }) => {
      dataWorkspaceIds = [...nextDataWorkspaceIds];
      return { where: whereUpdateMock };
    });
    const updateMock = mock(() => ({ set: setMock }));
    const forUpdateMock = mock(async () => [{ dataWorkspaceIds }]);
    const limitMock = mock(() => ({ for: forUpdateMock }));
    const whereSelectMock = mock(() => ({ limit: limitMock }));
    const fromMock = mock(() => ({ where: whereSelectMock }));
    const selectMock = mock(() => ({ from: fromMock }));
    const insertMock = mock(() => ({
      values: mock(async () => undefined),
    }));
    const tx = {
      insert: insertMock,
      select: selectMock,
      update: updateMock,
    };
    const { safeDb } = createScopedDbMock(tx);
    const recordAuditEvent = mock(async () => undefined);
    return {
      forUpdateMock,
      recordAuditEvent,
      safeDb,
      setMock,
      updateMock,
    };
  };

  test("locks and returns the persisted scope when no IDs are requested", async () => {
    const { forUpdateMock, safeDb, updateMock, recordAuditEvent } = buildTx([
      wsA,
    ]);
    const result = await expandThreadDataScope({
      newWorkspaceIds: [],
      recordAuditEvent,
      safeDb,
      threadId,
      threadWorkspaceId: null,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(forUpdateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
    if (Result.isOk(result)) {
      expect(result.value).toEqual([wsA]);
    }
  });

  test("all new IDs already present → no UPDATE issued", async () => {
    const { safeDb, updateMock, recordAuditEvent } = buildTx([wsA, wsB]);
    const result = await expandThreadDataScope({
      newWorkspaceIds: [wsA, wsB],
      recordAuditEvent,
      safeDb,
      threadId,
      threadWorkspaceId: null,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
  });

  test("regression: genuinely new workspace IDs trigger UPDATE", async () => {
    const { safeDb, updateMock, setMock, recordAuditEvent } = buildTx([wsA]);
    const result = await expandThreadDataScope({
      newWorkspaceIds: [wsB, wsC],
      recordAuditEvent,
      safeDb,
      threadId,
      threadWorkspaceId: null,
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

  test("uses the locked row for the audit transition, not a caller snapshot", async () => {
    const { safeDb, updateMock, recordAuditEvent } = buildTx([wsA, wsB]);
    const result = await expandThreadDataScope({
      newWorkspaceIds: [wsB, wsC],
      recordAuditEvent,
      safeDb,
      threadId,
      threadWorkspaceId: null,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);
    if (Result.isOk(result)) {
      expect(new Set<SafeId<"workspace">>(result.value)).toEqual(
        new Set([wsA, wsB, wsC]),
      );
    }
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        changes: {
          dataWorkspaceIds: {
            old: [wsA, wsB],
            new: [wsA, wsB, wsC],
          },
        },
      }),
    );
  });

  test("deduplicates repeated workspace IDs before updating", async () => {
    const { safeDb, recordAuditEvent } = buildTx([wsA]);
    const result = await expandThreadDataScope({
      newWorkspaceIds: [wsB, wsB, wsC],
      recordAuditEvent,
      safeDb,
      threadId,
      threadWorkspaceId: null,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual([wsA, wsB, wsC]);
    }
  });
});
