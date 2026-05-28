import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  planAssistantFinishPersistence,
  planMessagePersistence,
} from "./persist-message";
import type { ChatMessage, ChatMessageContent } from "./types";

const workspaceId = toSafeId<"workspace">(
  "0dc54d0c-10d7-501d-897e-e801dbd0998c",
);
const entityId = toSafeId<"entity">("c09ec856-d945-5ecc-82e3-bb5382165f34");
const fieldId = toSafeId<"field">("12549e0d-f3dd-589a-8012-d4f27b8cd641");
const propertyId = toSafeId<"property">("750890f7-42ce-59ab-9627-9171e5dc6346");

const stored = (message: ChatMessage) => ({
  id: message.id,
  role: message.role,
  content: {
    version: 1,
    data: message.parts,
  } satisfies ChatMessageContent,
});

const createDocumentApprovalRespondedMessage = {
  id: "019aef0c-4df0-7d25-b5ad-cfa5a548fb2b",
  role: "assistant",
  parts: [
    {
      type: "tool-create-document",
      toolCallId: "tool-create-document-1",
      state: "approval-responded",
      input: {
        name: "Draft agreement",
        source: "@title Draft agreement",
      },
      approval: {
        id: "approval-1",
        approved: true,
      },
    },
  ],
} satisfies ChatMessage;

const createDocumentFinishedMessage = {
  ...createDocumentApprovalRespondedMessage,
  parts: [
    {
      type: "tool-create-document",
      toolCallId: "tool-create-document-1",
      state: "output-available",
      input: {
        name: "Draft agreement",
        source: "@title Draft agreement",
      },
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
      approval: {
        id: "approval-1",
        approved: true,
      },
    },
    {
      type: "text",
      text:
        "Created [Draft agreement.docx](#stella-entity=" +
        `${workspaceId}:${entityId}).`,
    },
  ],
} satisfies ChatMessage;

const updateFieldsApprovalRespondedMessage = {
  id: "019aef0c-4df0-7d25-b5ad-cfa5a548fb2c",
  role: "assistant",
  parts: [
    {
      type: "tool-update-entity-fields",
      toolCallId: "tool-update-entity-fields-1",
      state: "approval-responded",
      input: {
        workspaceId,
        entityId,
        propertyId,
        propertyName: "Status",
        entityName: "Draft agreement.docx",
        oldValue: "Open",
        value: "Reviewed",
      },
      approval: {
        id: "approval-2",
        approved: true,
      },
    },
  ],
} satisfies ChatMessage;

const updateFieldsFinishedMessage = {
  ...updateFieldsApprovalRespondedMessage,
  parts: [
    {
      type: "tool-update-entity-fields",
      toolCallId: "tool-update-entity-fields-1",
      state: "output-available",
      input: {
        workspaceId,
        entityId,
        propertyId,
        propertyName: "Status",
        entityName: "Draft agreement.docx",
        oldValue: "Open",
        value: "Reviewed",
      },
      output: {
        success: true,
        entityId,
        propertyId,
        newValue: "Reviewed",
      },
      approval: {
        id: "approval-2",
        approved: true,
      },
    },
    {
      type: "text",
      text: "Updated Status to Reviewed.",
    },
  ],
} satisfies ChatMessage;

describe("chat approval persistence", () => {
  test("updates an approved create-document assistant message with the final output and text", () => {
    const incomingPlan = planMessagePersistence({
      message: createDocumentApprovalRespondedMessage,
      storedMessages: [stored(createDocumentApprovalRespondedMessage)],
    });

    const finishPlan = planAssistantFinishPersistence({
      existingIds: incomingPlan.existingIds,
      isAborted: false,
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
      isAborted: false,
      message: updateFieldsFinishedMessage,
    });

    expect(finishPlan).toEqual({
      type: "update",
      messageId: updateFieldsFinishedMessage.id,
      message: updateFieldsFinishedMessage,
    });
  });

  test("inserts a new final assistant message after an ordinary user turn", () => {
    const userMessage = {
      id: "019aef0c-4df0-7d25-b5ad-cfa5a548fb2d",
      role: "user",
      parts: [{ type: "text", text: "Create a document" }],
    } satisfies ChatMessage;

    const incomingPlan = planMessagePersistence({
      message: userMessage,
      storedMessages: [],
    });

    const finishPlan = planAssistantFinishPersistence({
      existingIds: incomingPlan.existingIds,
      isAborted: false,
      message: createDocumentFinishedMessage,
    });

    expect(finishPlan).toEqual({
      type: "insert",
      message: createDocumentFinishedMessage,
    });
  });

  test("does not overwrite user messages from the finish callback", () => {
    const userMessage = {
      id: "019aef0c-4df0-7d25-b5ad-cfa5a548fb2e",
      role: "user",
      parts: [{ type: "text", text: "Approved" }],
    } satisfies ChatMessage;

    const finishPlan = planAssistantFinishPersistence({
      existingIds: new Set([userMessage.id]),
      isAborted: false,
      message: userMessage,
    });

    expect(finishPlan).toEqual({ type: "none" });
  });

  test("leaves approval-responded messages untouched when a stream aborts", () => {
    const finishPlan = planAssistantFinishPersistence({
      existingIds: new Set([createDocumentFinishedMessage.id]),
      isAborted: true,
      message: createDocumentFinishedMessage,
    });

    expect(finishPlan).toEqual({ type: "none" });
  });
});
