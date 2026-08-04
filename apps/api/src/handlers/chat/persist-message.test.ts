import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  toChatMessageContent,
  toPersistableChatMessage,
} from "./chat-message-parts";
import {
  planAssistantFinishPersistence,
  planMessagePersistence,
} from "./persist-message";
import type { PersistableChatMessage } from "./types";

const workspaceId = toSafeId<"workspace">(
  "0dc54d0c-10d7-501d-897e-e801dbd0998c",
);
const entityId = toSafeId<"entity">("c09ec856-d945-5ecc-82e3-bb5382165f34");
const fieldId = toSafeId<"field">("12549e0d-f3dd-589a-8012-d4f27b8cd641");
const chatMessageId = (id: string) => toSafeId<"chatMessage">(id);

const stored = (message: PersistableChatMessage) => ({
  id: message.id,
  role: message.role,
  content: toChatMessageContent({
    version: 2,
    data: message.parts,
    metadata: message.metadata,
  }),
});

const createDocumentInput = {
  name: "Draft agreement",
  source: "@title Draft agreement",
};

const createDocumentApprovalRespondedMessage = toPersistableChatMessage({
  id: chatMessageId("019aef0c-4df0-7d25-b5ad-cfa5a548fb2b"),
  role: "assistant",
  parts: [
    {
      type: "tool-call",
      id: "tool-create-document-1",
      name: "create-document",
      arguments: JSON.stringify(createDocumentInput),
      state: "input-complete",
      input: createDocumentInput,
    },
  ],
});

const createDocumentFinishedMessage = toPersistableChatMessage({
  ...createDocumentApprovalRespondedMessage,
  parts: [
    {
      type: "tool-call",
      id: "tool-create-document-1",
      name: "create-document",
      arguments: JSON.stringify(createDocumentInput),
      state: "complete",
      input: createDocumentInput,
      output: {
        success: true,
        fileName: "Draft agreement.docx",
        entityId,
        fieldId,
        workspaceId,
        entityRef: entityId,
        matterRef: workspaceId,
        href: `#stella-entity=${workspaceId}:${entityId}`,
        mention: `[Draft agreement.docx](#stella-entity=${workspaceId}:${entityId})`,
      },
    },
    {
      type: "text",
      content:
        "Created [Draft agreement.docx](#stella-entity=" +
        `${workspaceId}:${entityId}).`,
    },
  ],
});

const updateFieldsApprovalRespondedMessage = toPersistableChatMessage({
  id: chatMessageId("019aef0c-4df0-7d25-b5ad-cfa5a548fb2c"),
  role: "assistant",
  parts: [
    {
      type: "tool-call",
      id: "tool-update-entity-fields-1",
      name: "update-entity-fields",
      arguments: JSON.stringify({
        matterRef: "mat_1",
        entityRef: "ent_1",
        propertyRef: "prop_1",
        value: "Reviewed",
      }),
      state: "approval-responded",
      input: {
        matterRef: "mat_1",
        entityRef: "ent_1",
        propertyRef: "prop_1",
        value: "Reviewed",
      },
      approval: {
        id: "approval-2",
        approved: true,
        needsApproval: true,
      },
    },
  ],
});

const updateFieldsFinishedMessage = toPersistableChatMessage({
  ...updateFieldsApprovalRespondedMessage,
  parts: [
    {
      type: "tool-call",
      id: "tool-update-entity-fields-1",
      name: "update-entity-fields",
      arguments: JSON.stringify({
        matterRef: "mat_1",
        entityRef: "ent_1",
        propertyRef: "prop_1",
        value: "Reviewed",
      }),
      state: "complete",
      input: {
        matterRef: "mat_1",
        entityRef: "ent_1",
        propertyRef: "prop_1",
        value: "Reviewed",
      },
      output: {
        success: true,
        entityRef: "ent_1",
        propertyRef: "prop_1",
        newValue: "Reviewed",
      },
      approval: {
        id: "approval-2",
        approved: true,
        needsApproval: true,
      },
    },
    {
      type: "text",
      content: "Updated Status to Reviewed.",
    },
  ],
});

describe("chat approval persistence", () => {
  test("updates an approved create-document assistant message with the final output and text", () => {
    const incomingPlan = planMessagePersistence({
      message: createDocumentApprovalRespondedMessage,
      storedMessages: [stored(createDocumentApprovalRespondedMessage)],
    });

    const finishPlan = planAssistantFinishPersistence({
      existingIds: incomingPlan.existingIds,
      finishOutcome: { type: "completed" },
      message: createDocumentFinishedMessage,
    });

    expect(finishPlan).toEqual({
      type: "update",
      messageId: createDocumentFinishedMessage.id,
      message: createDocumentFinishedMessage,
    });
  });

  test("updates an approved update-entity-fields assistant message with the final output and text", () => {
    const incomingPlan = planMessagePersistence({
      message: updateFieldsApprovalRespondedMessage,
      storedMessages: [stored(updateFieldsApprovalRespondedMessage)],
    });

    const finishPlan = planAssistantFinishPersistence({
      existingIds: incomingPlan.existingIds,
      finishOutcome: { type: "completed" },
      message: updateFieldsFinishedMessage,
    });

    expect(finishPlan).toEqual({
      type: "update",
      messageId: updateFieldsFinishedMessage.id,
      message: updateFieldsFinishedMessage,
    });
  });

  test("inserts a new final assistant message after an ordinary user turn", () => {
    const userMessage = toPersistableChatMessage({
      id: chatMessageId("019aef0c-4df0-7d25-b5ad-cfa5a548fb2d"),
      role: "user",
      parts: [{ type: "text", content: "Create a document" }],
    });

    const incomingPlan = planMessagePersistence({
      message: userMessage,
      storedMessages: [],
    });

    const finishPlan = planAssistantFinishPersistence({
      existingIds: incomingPlan.existingIds,
      finishOutcome: { type: "completed" },
      message: createDocumentFinishedMessage,
    });

    expect(finishPlan).toEqual({
      type: "insert",
      message: createDocumentFinishedMessage,
    });
  });

  test("does not overwrite user messages from the finish callback", () => {
    const userMessage = toPersistableChatMessage({
      id: chatMessageId("019aef0c-4df0-7d25-b5ad-cfa5a548fb2e"),
      role: "user",
      parts: [{ type: "text", content: "Approved" }],
    });

    const finishPlan = planAssistantFinishPersistence({
      existingIds: new Set([userMessage.id]),
      finishOutcome: { type: "completed" },
      message: userMessage,
    });

    expect(finishPlan).toEqual({ type: "none" });
  });

  test("updates approval-responded messages with the interrupted outcome", () => {
    const finishPlan = planAssistantFinishPersistence({
      existingIds: new Set([createDocumentFinishedMessage.id]),
      finishOutcome: { type: "interrupted", reason: "timeout" },
      message: createDocumentFinishedMessage,
    });

    expect(finishPlan).toEqual({
      type: "update",
      messageId: createDocumentFinishedMessage.id,
      message: createDocumentFinishedMessage,
    });
  });
});

describe("chat finish persistence on client disconnect", () => {
  const userMessage = toPersistableChatMessage({
    id: chatMessageId("019aef0c-4df0-7d25-b5ad-cfa5a548fb30"),
    role: "user",
    parts: [{ type: "text", content: "Draft a mutual NDA" }],
  });

  const completedAssistantMessage = toPersistableChatMessage({
    id: chatMessageId("019aef0c-4df0-7d25-b5ad-cfa5a548fb31"),
    role: "assistant",
    parts: [{ type: "text", content: "Here is the completed draft." }],
  });

  // A dropped client connection does not abort the metered provider call, so
  // the generation still reaches `onFinish` as completed. The completed (and
  // metered) message must be persisted even though nobody is listening.
  test("inserts a completed assistant message even when the client disconnected", () => {
    const incomingPlan = planMessagePersistence({
      message: userMessage,
      storedMessages: [stored(userMessage)],
    });

    const finishPlan = planAssistantFinishPersistence({
      existingIds: incomingPlan.existingIds,
      finishOutcome: { type: "completed" },
      message: completedAssistantMessage,
    });

    expect(finishPlan).toEqual({
      type: "insert",
      message: completedAssistantMessage,
    });
  });

  test("persists the terminal state of a generation cut off mid-stream", () => {
    const finishPlan = planAssistantFinishPersistence({
      existingIds: new Set([userMessage.id]),
      finishOutcome: { type: "interrupted", reason: "timeout" },
      message: completedAssistantMessage,
    });

    expect(finishPlan).toEqual({
      type: "insert",
      message: completedAssistantMessage,
    });
  });

  test("does not persist a non-assistant finish message", () => {
    const finishPlan = planAssistantFinishPersistence({
      existingIds: new Set([userMessage.id]),
      finishOutcome: { type: "completed" },
      message: userMessage,
    });

    expect(finishPlan).toEqual({ type: "none" });
  });

  // Idempotency: a completed message already present in the thread updates in
  // place rather than inserting a duplicate, so a refetch after reconnect does
  // not produce two assistant rows for the same turn.
  test("updates in place when the completed message id already exists", () => {
    const finishPlan = planAssistantFinishPersistence({
      existingIds: new Set([userMessage.id, completedAssistantMessage.id]),
      finishOutcome: { type: "completed" },
      message: completedAssistantMessage,
    });

    expect(finishPlan).toEqual({
      type: "update",
      messageId: completedAssistantMessage.id,
      message: completedAssistantMessage,
    });
  });
});

describe("chat user-message persistence", () => {
  const userMessage = toPersistableChatMessage({
    id: chatMessageId("019aef0c-4df0-7d25-b5ad-cfa5a548fb2f"),
    role: "user",
    parts: [{ type: "text", content: "Summarize this matter" }],
  });

  test("does not append a re-sent message already present in the loaded window", () => {
    const result = planMessagePersistence({
      message: userMessage,
      storedMessages: [stored(userMessage)],
    });

    expect(result.persistencePlan).toEqual({ type: "none" });
    expect(result.messages).toEqual([userMessage]);
    expect(result.existingIds).toEqual(new Set([userMessage.id]));
  });

  test("does not insert an existing message that falls outside the loaded window", () => {
    const result = planMessagePersistence({
      message: userMessage,
      storedMessages: [],
      incomingMessageExists: true,
    });

    expect(result.persistencePlan).toEqual({ type: "none" });
    expect(result.messages).toEqual([]);
    expect(result.existingIds).toEqual(new Set());
  });
});
