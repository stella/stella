import { describe, expect, test } from "bun:test";

import {
  buildCreateDocumentDraftPayload,
  buildCreateDocumentDownloadFileName,
  bindCreateDocumentDraftChatThread,
  findReadyCreateDocumentDraftMessageId,
  getCreateDocumentDraftEditorAccess,
  isCreateDocumentDraftPayload,
  isSameCreateDocumentDraftPayload,
  normalizeCreateDocumentInput,
  persistCreateDocumentDraftPayload,
  replaceReadyCreateDocumentDraftOutput,
  resolveCreateDocumentDraftOverlayChatThreadId,
  selectCreateDocumentDrafts,
  selectSettleableCreateDocumentDrafts,
  selectTerminalCreateDocumentDraftIds,
  selectUnsettledCreateDocumentDrafts,
  setCreateDocumentDraftChatThreadId,
  setCreateDocumentDraftPayloadStatus,
  terminalizeUnsettledCreateDocumentDraft,
} from "@/components/chat/create-document-draft.logic";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

describe("create-document drafts", () => {
  test("surfaces partial source while tool arguments are streaming", () => {
    const messages = [
      {
        id: "message-streaming",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "tool-streaming",
            name: "create-document",
            arguments:
              '{"name":"Power of attorney","source":"@doc kind=other\\n@paragraph\\nDraft in pro',
            state: "input-streaming",
          },
        ],
      },
    ] satisfies Parameters<typeof selectCreateDocumentDrafts>[0];

    expect(selectCreateDocumentDrafts(messages)).toEqual([
      {
        messageId: "message-streaming",
        toolCallId: "tool-streaming",
        name: "Power of attorney",
        source: "@doc kind=other\n@paragraph\nDraft in pro",
        status: "streaming",
      },
    ]);
  });

  test("opens an empty streaming draft as soon as the tool call starts", () => {
    const messages = [
      {
        id: "message-starting",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "tool-starting",
            name: "create-document",
            arguments: "",
            state: "awaiting-input",
          },
        ],
      },
    ] satisfies Parameters<typeof selectCreateDocumentDrafts>[0];

    expect(selectCreateDocumentDrafts(messages)).toEqual([
      {
        messageId: "message-starting",
        toolCallId: "tool-starting",
        name: "",
        source: "",
        status: "streaming",
      },
    ]);
  });

  test("keeps a ready unsaved draft selected and stops after export", () => {
    const input = {
      name: "Purchase agreement",
      source: "@doc kind=agreement locale=en page=A4\n@title Purchase",
    };
    const unresolved = [
      {
        id: "message-unresolved",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "tool-1",
            name: "create-document",
            arguments: JSON.stringify(input),
            state: "input-complete",
            input,
          },
        ],
      },
    ] satisfies Parameters<typeof selectCreateDocumentDrafts>[0];

    expect(selectCreateDocumentDrafts(unresolved)).toEqual([
      {
        messageId: "message-unresolved",
        toolCallId: "tool-1",
        name: "Purchase agreement",
        source: input.source,
        status: "ready",
      },
    ]);

    const readyDraft = [
      {
        id: "message-ready",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "tool-1",
            name: "create-document",
            arguments: JSON.stringify(input),
            state: "complete",
            input,
            output: {
              success: true,
              destination: "draft",
              fileName: "Purchase agreement.docx",
            },
          },
        ],
      },
    ] satisfies Parameters<typeof selectCreateDocumentDrafts>[0];
    expect(selectCreateDocumentDrafts(readyDraft)).toEqual([
      {
        messageId: "message-ready",
        toolCallId: "tool-1",
        name: "Purchase agreement",
        source: input.source,
        status: "ready",
      },
    ]);
    expect(selectUnsettledCreateDocumentDrafts(readyDraft)).toEqual([]);
    expect(selectUnsettledCreateDocumentDrafts(unresolved)).toHaveLength(1);
    expect(
      selectSettleableCreateDocumentDrafts(unresolved, "streaming"),
    ).toEqual([]);
    expect(
      selectSettleableCreateDocumentDrafts(unresolved, "ready"),
    ).toHaveLength(1);
    expect(
      selectUnsettledCreateDocumentDrafts([
        ...unresolved,
        {
          id: "message-user",
          role: "user",
          parts: [{ type: "text", content: "Make it longer" }],
        },
      ]),
    ).toEqual([]);

    const resolved = [
      {
        id: "message-resolved",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "tool-1",
            name: "create-document",
            arguments: JSON.stringify(input),
            state: "complete",
            input,
            output: {
              success: true,
              destination: "download",
              fileName: "Purchase agreement.docx",
            },
          },
        ],
      },
    ] satisfies Parameters<typeof selectCreateDocumentDrafts>[0];
    expect(selectCreateDocumentDrafts(resolved)).toEqual([]);
  });

  test("moves a settled draft to a saved entity without a second tool result", () => {
    const messageId = toSafeId<"chatMessage">(
      "019fc8ee-aea6-7eba-8da3-3ec8d4bda03e",
    );
    const input = {
      name: "Purchase agreement",
      source: "@doc kind=agreement locale=en page=A4",
    };
    const messages = [
      {
        id: messageId,
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "tool-1",
            name: "create-document",
            arguments: JSON.stringify(input),
            state: "complete",
            input,
            output: {
              success: true,
              destination: "draft",
              fileName: "Purchase agreement.docx",
            },
          },
        ],
      },
    ] satisfies Parameters<typeof findReadyCreateDocumentDraftMessageId>[0];
    const output = {
      success: true,
      entityId: "entity-1",
      entityRef: "entity-1",
      fieldId: "field-1",
      fileName: "Purchase agreement.docx",
      href: "#stella-entity=workspace-1:entity-1",
      matterRef: "workspace-1",
      mention: "[Purchase agreement.docx](#stella-entity=workspace-1:entity-1)",
      workspaceId: "workspace-1",
    } as const;

    expect(findReadyCreateDocumentDraftMessageId(messages, "tool-1")).toBe(
      messageId,
    );
    const updated = replaceReadyCreateDocumentDraftOutput(
      messages,
      "tool-1",
      output,
    );
    expect(updated[0]?.parts).toHaveLength(1);
    expect(updated[0]?.parts.at(0)).toMatchObject({ output });
    expect(findReadyCreateDocumentDraftMessageId(updated, "tool-1")).toBeNull();
  });

  test("terminalizes only the exhausted draft settlement", () => {
    const messages = [
      {
        id: toSafeId<"chatMessage">("019fc8ee-aea6-7eba-8da3-3ec8d4bda03f"),
        role: "assistant",
        parts: [
          {
            arguments: JSON.stringify({ name: "Draft", source: "@doc" }),
            id: "tool-1",
            input: { name: "Draft", source: "@doc" },
            name: "create-document",
            state: "input-complete",
            type: "tool-call",
          },
        ],
      },
    ] satisfies Parameters<typeof terminalizeUnsettledCreateDocumentDraft>[0];

    const updated = terminalizeUnsettledCreateDocumentDraft(messages, "tool-1");
    expect(updated[0]?.parts[0]).toMatchObject({ state: "error" });
    expect(selectUnsettledCreateDocumentDrafts(updated)).toEqual([]);
  });

  test("marks failed create-document calls terminal without closing active drafts", () => {
    const messages = [
      {
        role: "assistant",
        parts: [
          {
            arguments: "{}",
            id: "failed-tool",
            name: "create-document",
            state: "error",
            type: "tool-call",
          },
          {
            arguments: "{}",
            id: "active-tool",
            name: "create-document",
            state: "input-streaming",
            type: "tool-call",
          },
        ],
      },
    ] satisfies Parameters<typeof selectTerminalCreateDocumentDraftIds>[0];

    expect(selectTerminalCreateDocumentDraftIds(messages)).toEqual([
      "failed-tool",
    ]);
  });

  test("normalizes legacy markdown input", () => {
    expect(
      normalizeCreateDocumentInput({
        name: "Legacy",
        markdown: "# Legacy document",
      }),
    ).toEqual({ name: "Legacy", source: "# Legacy document" });
  });

  test("recognizes an unchanged inspector payload", () => {
    const payload = {
      originChatMessageId: "message-origin",
      originChatThreadId: toChatThreadId("thread-origin"),
      chatThreadBinding: "unbound",
      chatThreadId: toChatThreadId("thread-draft"),
      toolCallId: "tool-1",
      name: "Purchase agreement",
      source: "@doc kind=agreement locale=en page=A4",
      status: "ready",
    } as const;

    expect(isSameCreateDocumentDraftPayload({ ...payload }, payload)).toBe(
      true,
    );
    expect(
      isSameCreateDocumentDraftPayload(
        { ...payload, source: `${payload.source}\n@title Changed` },
        payload,
      ),
    ).toBe(false);
  });

  test("gives the draft overlay a fresh stable thread", () => {
    const originChatThreadId = toChatThreadId("thread-origin");
    const draft = {
      messageId: "message-origin",
      toolCallId: "tool-1",
      name: "Power of attorney",
      source: "@doc kind=other locale=en page=A4",
      status: "streaming",
    } as const;

    const initial = buildCreateDocumentDraftPayload({
      draft,
      existingPayload: undefined,
      originChatThreadId,
    });

    expect(initial.originChatThreadId).toBe(originChatThreadId);
    expect(initial.chatThreadBinding).toBe("unbound");
    expect(initial.chatThreadId).not.toBe(initial.originChatThreadId);

    const updated = buildCreateDocumentDraftPayload({
      draft: {
        ...draft,
        source: `${draft.source}\n@title Power of attorney`,
        status: "ready",
      },
      existingPayload: initial,
      originChatThreadId,
    });

    expect(updated.chatThreadId).toBe(initial.chatThreadId);
    expect(updated.source).toContain("@title Power of attorney");
    expect(isCreateDocumentDraftPayload(updated)).toBe(true);
    expect(
      isCreateDocumentDraftPayload({
        ...updated,
        chatThreadId: originChatThreadId,
      }),
    ).toBe(false);
    expect(
      buildCreateDocumentDraftPayload({
        draft,
        existingPayload: undefined,
        originChatThreadId,
      }).chatThreadId,
    ).toBe(initial.chatThreadId);
    expect(isCreateDocumentDraftPayload({ ...updated, workspaceId: 42 })).toBe(
      false,
    );

    const rotated = setCreateDocumentDraftChatThreadId({
      chatThreadId: toChatThreadId("thread-rotated"),
      payload: updated,
    });
    expect(rotated.chatThreadId).toBe(toChatThreadId("thread-rotated"));
    expect(rotated.chatThreadBinding).toBe("unbound");
    expect(
      buildCreateDocumentDraftPayload({
        draft: { ...draft, status: "ready" },
        existingPayload: rotated,
        originChatThreadId,
      }).chatThreadId,
    ).toBe(toChatThreadId("thread-rotated"));
    expect(
      setCreateDocumentDraftChatThreadId({
        chatThreadId: originChatThreadId,
        payload: rotated,
      }),
    ).toBe(rotated);
  });

  test("forwards a draft chat only after the server-confirmed binding", () => {
    const payload = buildCreateDocumentDraftPayload({
      draft: {
        messageId: "message-origin",
        toolCallId: "tool-1",
        name: "Power of attorney",
        source: "@doc kind=other locale=en page=A4",
        status: "ready",
      },
      existingPayload: undefined,
      originChatThreadId: toChatThreadId("thread-origin"),
    });

    expect(payload.chatThreadBinding).toBe("unbound");
    const bound = bindCreateDocumentDraftChatThread({
      chatThreadId: payload.chatThreadId,
      payload,
    });
    expect(bound.chatThreadBinding).toBe("bound");
    expect(bound.chatThreadId).toBe(payload.chatThreadId);

    const rotated = setCreateDocumentDraftChatThreadId({
      chatThreadId: toChatThreadId("thread-rotated"),
      payload: bound,
    });
    expect(rotated.chatThreadBinding).toBe("unbound");
    expect(
      bindCreateDocumentDraftChatThread({
        chatThreadId: toChatThreadId("other-thread"),
        payload: rotated,
      }),
    ).toBe(rotated);
  });

  test("keeps the editor locked while a save snapshot is in flight", () => {
    const ready = buildCreateDocumentDraftPayload({
      draft: {
        messageId: "message-origin",
        toolCallId: "tool-1",
        name: "Power of attorney",
        source: "@doc kind=other locale=en page=A4",
        status: "ready",
      },
      existingPayload: undefined,
      originChatThreadId: toChatThreadId("thread-origin"),
    });
    const saving = setCreateDocumentDraftPayloadStatus({
      payload: ready,
      status: "saving",
    });
    const rebuilt = buildCreateDocumentDraftPayload({
      draft: {
        messageId: "message-origin",
        toolCallId: "tool-1",
        name: "Power of attorney",
        source: "@doc kind=other locale=en page=A4\n@title Updated",
        status: "ready",
      },
      existingPayload: saving,
      originChatThreadId: toChatThreadId("thread-origin"),
    });

    expect(rebuilt.status).toBe("saving");
    expect(getCreateDocumentDraftEditorAccess(saving)).toBe("read-only");
    expect(
      setCreateDocumentDraftPayloadStatus({
        payload: rebuilt,
        status: "ready",
      }).status,
    ).toBe("ready");
  });

  test("promotes a draft to a persisted file without changing editor identity", () => {
    const payload = buildCreateDocumentDraftPayload({
      draft: {
        messageId: "message-origin",
        toolCallId: "tool-1",
        name: "Power of attorney",
        source: "@doc kind=other locale=en page=A4",
        status: "ready",
      },
      existingPayload: undefined,
      originChatThreadId: toChatThreadId("thread-origin"),
    });

    const persisted = persistCreateDocumentDraftPayload({
      entityId: "entity-1",
      fieldId: "field-1",
      fileName: "Power of attorney.docx",
      payload,
      workspaceId: "workspace-1",
    });

    expect(persisted).toMatchObject({
      status: "persisted",
      entityId: "entity-1",
      fieldId: "field-1",
      fileName: "Power of attorney.docx",
      workspaceId: "workspace-1",
    });
    expect(persisted.toolCallId).toBe(payload.toolCallId);
    expect(persisted.chatThreadId).toBe(payload.chatThreadId);
    expect(persisted.source).toBe(payload.source);
    expect(isCreateDocumentDraftPayload(persisted)).toBe(true);
    expect(isSameCreateDocumentDraftPayload({ ...persisted }, persisted)).toBe(
      true,
    );
    expect(
      buildCreateDocumentDraftPayload({
        draft: {
          messageId: payload.originChatMessageId,
          toolCallId: payload.toolCallId,
          name: payload.name,
          source: payload.source,
          status: "ready",
        },
        existingPayload: persisted,
        originChatThreadId: payload.originChatThreadId,
      }),
    ).toBe(persisted);

    expect(getCreateDocumentDraftEditorAccess(payload)).toBe("editable");
    expect(getCreateDocumentDraftEditorAccess(persisted)).toBe("read-only");

    const rotated = setCreateDocumentDraftChatThreadId({
      chatThreadId: toChatThreadId("thread-persisted-rotated"),
      payload: persisted,
    });
    expect(rotated).toMatchObject({
      chatThreadId: "thread-persisted-rotated",
      entityId: "entity-1",
      fieldId: "field-1",
      status: "persisted",
    });
  });

  test("resolves an unbound saved draft through the canonical file chat", () => {
    const draft = buildCreateDocumentDraftPayload({
      draft: {
        messageId: "message-origin",
        toolCallId: "tool-1",
        name: "Power of attorney",
        source: "@doc kind=other locale=en page=A4",
        status: "ready",
      },
      existingPayload: undefined,
      originChatThreadId: toChatThreadId("thread-origin"),
    });
    const persisted = persistCreateDocumentDraftPayload({
      entityId: "entity-1",
      fieldId: "field-1",
      fileName: "Power of attorney.docx",
      payload: draft,
      workspaceId: "workspace-1",
    });

    // An unbound deterministic draft id must not create a second thread after
    // save. `undefined` selects FileChatOverlay's file-mapping resolver.
    expect(
      resolveCreateDocumentDraftOverlayChatThreadId(persisted),
    ).toBeUndefined();

    const bound = bindCreateDocumentDraftChatThread({
      chatThreadId: draft.chatThreadId,
      payload: persisted,
    });
    expect(resolveCreateDocumentDraftOverlayChatThreadId(bound)).toBe(
      draft.chatThreadId,
    );
  });

  test("builds a bounded safe DOCX download name", () => {
    const fileName = buildCreateDocumentDownloadFileName(
      `../${"a".repeat(300)}\r\n?.docx`,
    );
    expect(fileName.length).toBeLessThanOrEqual(255);
    expect(fileName.endsWith(".docx")).toBe(true);
    expect(fileName).not.toMatch(/["/\\<>\r\n\0|*?:]/u);
    expect(fileName).not.toContain("..");
  });
});
