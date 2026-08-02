import { describe, expect, test } from "bun:test";

import {
  buildCreateDocumentDraftPayload,
  buildCreateDocumentDownloadFileName,
  isCreateDocumentDraftPayload,
  isSameCreateDocumentDraftPayload,
  normalizeCreateDocumentInput,
  selectCreateDocumentDrafts,
  selectUnsettledCreateDocumentDrafts,
} from "@/components/chat/create-document-draft.logic";
import { toChatThreadId } from "@/lib/chat-thread-ref";

describe("create-document drafts", () => {
  test("surfaces partial source while tool arguments are streaming", () => {
    const messages = [
      {
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
        toolCallId: "tool-streaming",
        name: "Power of attorney",
        source: "@doc kind=other\n@paragraph\nDraft in pro",
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
        toolCallId: "tool-1",
        name: "Purchase agreement",
        source: input.source,
        status: "ready",
      },
    ]);

    const readyDraft = [
      {
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
        toolCallId: "tool-1",
        name: "Purchase agreement",
        source: input.source,
        status: "ready",
      },
    ]);
    expect(selectUnsettledCreateDocumentDrafts(readyDraft)).toEqual([]);
    expect(selectUnsettledCreateDocumentDrafts(unresolved)).toHaveLength(1);
    expect(
      selectUnsettledCreateDocumentDrafts([
        ...unresolved,
        { role: "user", parts: [{ type: "text", content: "Make it longer" }] },
      ]),
    ).toEqual([]);

    const resolved = [
      {
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
      originChatThreadId: toChatThreadId("thread-origin"),
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
    const draftChatThreadId = toChatThreadId("thread-draft");
    const generatedThreadIds = [originChatThreadId, draftChatThreadId];
    let generatedIndex = 0;
    const createThreadId = () =>
      generatedThreadIds.at(generatedIndex++) ?? draftChatThreadId;
    const draft = {
      toolCallId: "tool-1",
      name: "Power of attorney",
      source: "@doc kind=other locale=en page=A4",
      status: "streaming",
    } as const;

    const initial = buildCreateDocumentDraftPayload({
      createThreadId,
      draft,
      existingPayload: undefined,
      originChatThreadId,
    });

    expect(initial.originChatThreadId).toBe(originChatThreadId);
    expect(initial.chatThreadId).toBe(draftChatThreadId);
    expect(initial.chatThreadId).not.toBe(initial.originChatThreadId);
    expect(generatedIndex).toBe(2);

    const updated = buildCreateDocumentDraftPayload({
      createThreadId: () => toChatThreadId("unexpected-thread"),
      draft: {
        ...draft,
        source: `${draft.source}\n@title Power of attorney`,
        status: "ready",
      },
      existingPayload: initial,
      originChatThreadId,
    });

    expect(updated.chatThreadId).toBe(draftChatThreadId);
    expect(updated.source).toContain("@title Power of attorney");
    expect(isCreateDocumentDraftPayload(updated)).toBe(true);
    expect(
      isCreateDocumentDraftPayload({
        ...updated,
        chatThreadId: originChatThreadId,
      }),
    ).toBe(false);
  });

  test("builds a bounded safe DOCX download name", () => {
    const fileName = buildCreateDocumentDownloadFileName(
      `../${"a".repeat(300)}\r\n?.docx`,
    );
    expect(fileName.length).toBeLessThanOrEqual(255);
    expect(fileName.endsWith(".docx")).toBe(true);
    // eslint-disable-next-line no-control-regex -- verifies that download names cannot retain null/control characters
    expect(fileName).not.toMatch(/["/\\<>\r\n\0|*?:]/u);
    expect(fileName).not.toContain("..");
  });
});
