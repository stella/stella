import { describe, expect, test } from "bun:test";

import { toPersistableChatMessage } from "@/api/handlers/chat/chat-message-parts";
import { replaceCreatedDraftOutput } from "@/api/handlers/chat/created-draft/update";
import { toSafeId } from "@/api/lib/branded-types";

const messageId = toSafeId<"chatMessage">(
  "019fc8e2-dc58-7a48-94cb-40ff5e1f53ed",
);
const entityId = toSafeId<"entity">("019fc8e2-dc58-7a48-94cb-40ff5e1f53ee");
const fieldId = toSafeId<"field">("019fc8e2-dc58-7a48-94cb-40ff5e1f53ef");
const workspaceId = toSafeId<"workspace">(
  "019fc8e2-dc58-7a48-94cb-40ff5e1f53f0",
);
const href = `#stella-entity=${workspaceId}:${entityId}`;
const output = {
  success: true,
  entityId,
  entityRef: entityId,
  fieldId,
  fileName: "Power of attorney.docx",
  href,
  matterRef: workspaceId,
  mention: `[Power of attorney.docx](${href})`,
  workspaceId,
} as const;

const draftMessage = toPersistableChatMessage({
  id: messageId,
  role: "assistant",
  parts: [
    {
      type: "tool-call",
      id: "tool-create-document-1",
      name: "create-document",
      arguments: JSON.stringify({ name: "Power of attorney", source: "@doc" }),
      state: "complete",
      input: { name: "Power of attorney", source: "@doc" },
      output: {
        success: true,
        destination: "draft",
        fileName: "Power of attorney.docx",
      },
    },
  ],
});

describe("replaceCreatedDraftOutput", () => {
  test("replaces a completed draft without requiring a synthetic tool-result part", () => {
    const updated = replaceCreatedDraftOutput({
      message: draftMessage,
      messageId,
      output,
      toolCallId: "tool-create-document-1",
    });

    expect(updated?.parts.at(0)).toMatchObject({
      type: "tool-call",
      id: "tool-create-document-1",
      output,
    });
  });

  test("is idempotent for the same saved entity", () => {
    const first = replaceCreatedDraftOutput({
      message: draftMessage,
      messageId,
      output,
      toolCallId: "tool-create-document-1",
    });
    expect(first).not.toBeNull();

    expect(
      replaceCreatedDraftOutput({
        message: first ?? draftMessage,
        messageId,
        output,
        toolCallId: "tool-create-document-1",
      }),
    ).not.toBeNull();
  });

  test("refuses to rewrite another tool call or saved entity", () => {
    expect(
      replaceCreatedDraftOutput({
        message: draftMessage,
        messageId,
        output,
        toolCallId: "another-tool",
      }),
    ).toBeNull();

    const otherOutput = {
      ...output,
      entityId: toSafeId<"entity">("019fc8e2-dc58-7a48-94cb-40ff5e1f53f1"),
    };
    const saved = replaceCreatedDraftOutput({
      message: draftMessage,
      messageId,
      output: otherOutput,
      toolCallId: "tool-create-document-1",
    });
    expect(saved).not.toBeNull();
    expect(
      replaceCreatedDraftOutput({
        message: saved ?? draftMessage,
        messageId,
        output,
        toolCallId: "tool-create-document-1",
      }),
    ).toBeNull();
  });
});
