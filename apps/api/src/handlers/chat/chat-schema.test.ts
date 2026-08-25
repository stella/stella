import { Value } from "@sinclair/typebox/value";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import {
  CHAT_RICH_PART_LIMITS,
  CHAT_TURN_INTENT,
  resourceRef,
  RESOURCE_TYPE,
} from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import {
  createChatAttachmentPart,
  chatMessageContentFromMessage,
  toChatMessageContent,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import {
  activeFileSchema,
  activeDraftSchema,
  agUiSendMessageBodySchema,
  parseMessage,
  sendMessageBodySchema,
  validateToolCallParts,
  validateMessage as validateMessageWithPersistence,
} from "@/api/handlers/chat/chat-schema";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { toSafeId } from "@/api/lib/branded-types";
import { createGeneratedDocumentActiveDraftContext } from "@/api/lib/chat/active-draft-context";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import { CHAT_REF_ENCODING } from "@/api/lib/chat/ref-token";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { toUserFileUrl } from "@/api/lib/user-files/types";
import { XLSX_MIME_TYPE } from "@/api/mime-types";

import { richChatParts, unsafeScriptUrl } from "./__fixtures__/rich-chat-parts";
import type { StoredChatFile, StoredFileRef } from "./attachment-validation";
import {
  validateChatFileParts,
  validateStoredFileRefs,
} from "./attachment-validation";
import type { ChatMessage, ChatMessageMetadata } from "./types";

type ChatParts = ChatMessage["parts"];

const userFileId = (id: string) => toSafeId<"userFile">(id);
const chatThreadId = (id: string) => toSafeId<"chatThread">(id);
const userId = (id: string) => toSafeId<"user">(id);
const chatMessageId = (id: string) => toSafeId<"chatMessage">(id);
const noDbReads: SafeDb = async () => {
  throw new Error("This validation path should not read the database");
};
const noTools = {} satisfies ChatToolMap;
const validateMessage = async (
  input: Omit<
    Parameters<typeof validateMessageWithPersistence>[0],
    "persistedMessage"
  >,
) => await validateMessageWithPersistence({ ...input, persistedMessage: null });
const searchTools = {
  "search-documents": {
    name: "search-documents",
    description: "Search documents",
    inputSchema: toTanStackToolSchema(
      v.strictObject({
        query: v.string(),
      }),
    ),
    outputSchema: toTanStackToolSchema(
      v.strictObject({
        text: v.string(),
      }),
    ),
  },
} satisfies ChatToolMap;
const createDocumentTools = {
  "create-document": {
    name: "create-document",
    description: "Create a document",
    inputSchema: toTanStackToolSchema(
      v.strictObject({
        name: v.string(),
        source: v.string(),
      }),
    ),
    outputSchema: toTanStackToolSchema(
      v.strictObject({
        fileName: v.string(),
      }),
    ),
  },
} satisfies ChatToolMap;
const snapshotApprovalTools = {
  mcp__external__create_document: {
    name: "mcp__external__create_document",
    description: "Create a document",
    inputSchema: createDocumentTools["create-document"].inputSchema,
    outputSchema: createDocumentTools["create-document"].outputSchema,
  },
} satisfies ChatToolMap;
const askUserTools = {
  "ask-user": {
    name: "ask-user",
    description: "Ask a user for missing information",
  },
} satisfies ChatToolMap;

const createUserFilePart = ({
  fileId,
  mediaType,
}: {
  fileId: string;
  mediaType: string;
}) =>
  [
    createChatAttachmentPart({
      filename: "attachment",
      mimeType: mediaType,
      url: toUserFileUrl(userFileId(fileId)),
    }),
  ] satisfies ChatParts;

test("active file context rejects client-supplied email citation text", () => {
  expect(
    Value.Check(activeFileSchema, {
      entityId: "019fc771-8b17-7000-b85e-559afc54cfe5",
      fileFieldId: "019fc771-8b17-7000-b85e-559afc54cfe6",
      fileName: "message.eml",
      emailCitationSnapshot: {
        blocks: [{ id: "body-0001", text: "fabricated source text" }],
      },
    }),
  ).toBe(false);
});

describe("active draft request context", () => {
  const identity = {
    fileName: "Agreement.docx",
    originChatMessageId: "019fc771-8b17-7000-b85e-559afc54cfe5",
    originChatThreadId: "019fc771-8b17-74bf-b85e-559afc54cfe5",
    toolCallId: "create-document-1",
  };

  test("requires the live document snapshot it advertises to the model", () => {
    expect(Value.Check(activeDraftSchema, identity)).toBe(false);
    expect(
      Value.Check(activeDraftSchema, {
        ...identity,
        docxEditSnapshot: {
          blocks: [
            {
              id: "block-1",
              kind: "paragraph",
              text: "Confidential information",
            },
          ],
        },
      }),
    ).toBe(true);
  });
});

describe("chat turn intent", () => {
  const request = {
    threadId: "019fc771-8b17-74bf-b85e-559afc54cfe5",
    runId: "run-regenerate-1",
    sendMode: CHAT_SEND_MODE.rawOverride,
    message: {
      id: "019fc771-8b17-7000-b85e-559afc54cfe5",
      role: "user",
      parts: [{ type: "text", content: "Try again" }],
    },
  };

  test("accepts only the shared explicit regeneration discriminator", () => {
    expect(
      Value.Check(sendMessageBodySchema, {
        ...request,
        turnIntent: CHAT_TURN_INTENT.regenerate,
      }),
    ).toBe(true);
    expect(
      Value.Check(sendMessageBodySchema, {
        ...request,
        turnIntent: "retry",
      }),
    ).toBe(false);
  });
});

describe("native AG-UI request envelope", () => {
  const forwardedProps = {
    threadId: "019fc771-8b17-74bf-b85e-559afc54cfe5",
    runId: "run-1",
    sendMode: CHAT_SEND_MODE.rawOverride,
    message: {
      id: "019fc771-8b17-7000-b85e-559afc54cfe5",
      role: "user",
      parts: [{ type: "text", content: "Continue" }],
    },
  };
  const request = {
    threadId: forwardedProps.threadId,
    runId: forwardedProps.runId,
    state: {},
    messages: [forwardedProps.message],
    tools: [],
    context: [],
    forwardedProps,
    data: forwardedProps,
  };

  test("accepts the canonical envelope with a complete native resume batch", () => {
    const resume = [
      {
        interruptId: "approval-1",
        status: "resolved" as const,
        payload: { approved: true },
      },
    ];
    const continuationForwardedProps = {
      ...forwardedProps,
      message: { ...forwardedProps.message, role: "assistant" as const },
      parentRunId: "run-parent",
      resume,
    };
    expect(
      Value.Check(agUiSendMessageBodySchema, {
        ...request,
        parentRunId: "run-parent",
        resume,
        forwardedProps: continuationForwardedProps,
        data: continuationForwardedProps,
      }),
    ).toBe(true);
  });

  test("rejects untyped fields, incomplete resume items, and user-message resumes", () => {
    expect(
      Value.Check(agUiSendMessageBodySchema, {
        ...request,
        shadowPayload: {},
      }),
    ).toBe(false);
    expect(
      Value.Check(agUiSendMessageBodySchema, {
        ...request,
        parentRunId: "run-parent",
        resume: [{ interruptId: "approval-1" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(agUiSendMessageBodySchema, {
        ...request,
        parentRunId: "run-parent",
        resume: [
          {
            interruptId: "approval-1",
            status: "resolved",
            payload: { approved: true },
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("validateChatFileParts", () => {
  test("accepts XLSX attachments for server-side text extraction", () => {
    const result = validateChatFileParts({
      parts: createUserFilePart({
        fileId: "file_xlsx",
        mediaType: XLSX_MIME_TYPE,
      }),
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value).toEqual([
      { id: userFileId("file_xlsx"), mediaType: XLSX_MIME_TYPE },
    ]);
  });

  test("rejects too many attachments in one message", () => {
    const parts = Array.from(
      { length: LIMITS.chatContextFilesPerMessage + 1 },
      (_, index) =>
        createChatAttachmentPart({
          filename: `attachment-${index}.txt`,
          mimeType: "text/plain",
          url: toUserFileUrl(userFileId(`file_${index}`)),
        }),
    ) satisfies ChatParts;

    const result = validateChatFileParts({ parts });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      return;
    }

    expect(result.error.status).toBe(400);
    expect(result.error.message).toBe(
      "Too many chat attachments in a single message",
    );
  });

  test("returns a safe error for invalid data URLs", () => {
    const result = validateChatFileParts({
      parts: [
        createChatAttachmentPart({
          filename: "attachment.txt",
          mimeType: "text/plain",
          url: "data:text/plain",
        }),
      ] satisfies ChatParts,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      return;
    }

    expect(result.error.status).toBe(400);
    expect(result.error.message).toBe("Invalid chat attachment data URL");
    expect(result.error.message).not.toContain("base64");
  });

  test("rejects unsupported attachment types", () => {
    const result = validateChatFileParts({
      parts: createUserFilePart({
        fileId: "file_test",
        mediaType: "application/zip",
      }),
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      return;
    }

    expect(result.error.status).toBe(400);
    expect(result.error.message).toBe("Unsupported chat attachment type");
  });

  test("rejects unsupported attachment sources", () => {
    const parts = [
      createChatAttachmentPart({
        filename: "attachment.txt",
        mimeType: "text/plain",
        url: "https://example.com/attachment.txt",
      }),
    ] satisfies ChatParts;

    const result = validateChatFileParts({ parts });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      return;
    }

    expect(result.error.status).toBe(400);
    expect(result.error.message).toBe(
      "Chat attachments must use base64 data URLs or stella user-file URLs",
    );
  });
});

describe("parseMessage", () => {
  test("caps mentions accumulated across text parts", () => {
    const accessibleWorkspaceId = toSafeId<"workspace">("workspace_1");
    const parts = Array.from(
      { length: CHAT_RICH_PART_LIMITS.mentionsMax + 1 },
      (_, index) => ({
        type: "text" as const,
        content: `<entity-mention data-id="entity_${index}" data-label="Document ${index}" data-category="entity" data-source-workspace-id="${accessibleWorkspaceId}"></entity-mention>`,
      }),
    );

    const parsed = parseMessage({
      accessibleWorkspaceIds: [accessibleWorkspaceId],
      message: toPersistableChatMessage({
        id: chatMessageId("msg_many_mentions"),
        role: "user",
        parts,
      }),
    });

    expect(parsed.mentions).toHaveLength(CHAT_RICH_PART_LIMITS.mentionsMax);
    expect(parsed.mentions.at(-1)?.id).toBe(
      `entity_${CHAT_RICH_PART_LIMITS.mentionsMax - 1}`,
    );
  });
});

describe("validateMessage", () => {
  test("accepts malformed partial tool input only for interrupted persistence", () => {
    const message = {
      id: chatMessageId("msg_interrupted_partial_tool"),
      role: "assistant",
      parts: [
        {
          arguments: '{"question":"Which',
          id: "tool-call-1",
          name: "ask-user",
          state: "input-streaming",
          type: "tool-call",
        },
      ],
    } as const satisfies ChatMessage;

    expect(
      Result.isOk(
        validateToolCallParts({
          allowPartialInput: true,
          message,
          tools: askUserTools,
        }),
      ),
    ).toBe(true);
    expect(
      Result.isError(validateToolCallParts({ message, tools: askUserTools })),
    ).toBe(true);
  });

  test("accepts TanStack text parts at the live boundary", async () => {
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_tanstack_text"),
        role: "user",
        parts: [{ type: "text", content: "Ahoj" }],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_tanstack_text"),
      tools: noTools,
      userId: userId("user_tanstack_text"),
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }

    expect(result.value.message.parts).toEqual([
      { type: "text", content: "Ahoj" },
    ]);
  });

  test("preserves client-owned assistant metadata on continuations", async () => {
    const metadata = {
      anonRestorations: {
        pairs: [{ placeholder: "[PERSON_1]", original: "Ada Lovelace" }],
      },
      mentions: {
        mentions: [
          {
            category: "entity",
            id: "entity_1",
            label: "Source memo",
            resource: resourceRef({
              type: RESOURCE_TYPE.ENTITY,
              id: toSafeId<"entity">("entity_1"),
            }),
            workspaceId: "workspace_1",
          },
        ],
      },
      usage: {
        completionTokens: 3,
        promptTokens: 2,
        totalTokens: 5,
        completionTokensDetails: { reasoningTokens: 1 },
      },
    } satisfies ChatMessageMetadata;

    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_metadata_continuation"),
        role: "assistant",
        metadata,
        parts: [{ type: "text", content: "Done" }],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_metadata_continuation"),
      tools: noTools,
      userId: userId("user_metadata_continuation"),
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }

    expect(result.value.message.metadata).toEqual(metadata);
  });

  test("upgrades legacy mention metadata to canonical resource identity", async () => {
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_legacy_mention"),
        role: "assistant",
        metadata: {
          mentions: {
            mentions: [
              {
                category: "workspace",
                id: "workspace_1",
                label: "Matter",
              },
            ],
          },
        },
        parts: [{ type: "text", content: "Done" }],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_legacy_mention"),
      tools: noTools,
      userId: userId("user_legacy_mention"),
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }
    expect(result.value.message.metadata?.mentions).toEqual({
      mentions: [
        {
          category: "workspace",
          id: "workspace_1",
          label: "Matter",
          resource: resourceRef({
            type: RESOURCE_TYPE.WORKSPACE,
            id: toSafeId<"workspace">("workspace_1"),
          }),
        },
      ],
    });
  });

  test("rejects mention metadata whose legacy and canonical identities drift", async () => {
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_drifted_mention"),
        role: "assistant",
        metadata: {
          mentions: {
            mentions: [
              {
                category: "entity",
                id: "entity_1",
                label: "Source memo",
                resource: { type: "entity", id: "entity_2" },
                workspaceId: "workspace_1",
              },
            ],
          },
        },
        parts: [{ type: "text", content: "Done" }],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_drifted_mention"),
      tools: noTools,
      userId: userId("user_drifted_mention"),
    });

    expect(Result.isError(result)).toBe(true);
  });

  test("rejects unsafe legacy mention identifiers as invalid metadata", async () => {
    const invalidMentions = [
      {
        category: "workspace",
        id: "",
        label: "Matter",
      },
      {
        category: "entity",
        id: "entity_1",
        label: "Source memo",
        workspaceId: "",
      },
      {
        category: "workspace",
        id: "workspace_\uD800",
        label: "Matter",
      },
      {
        category: "entity",
        id: "entity_\uD800",
        label: "Source memo",
        workspaceId: "workspace_1",
      },
      {
        category: "entity",
        id: "entity_1",
        label: "Source memo",
        workspaceId: "workspace_\uD800",
      },
    ] as const;

    const results = await Promise.all(
      invalidMentions.map(async (mention, index) =>
        validateMessage({
          message: {
            id: chatMessageId(`msg_empty_legacy_mention_${index}`),
            role: "assistant",
            metadata: { mentions: { mentions: [mention] } },
            parts: [{ type: "text", content: "Done" }],
          },
          safeDb: noDbReads,
          threadId: chatThreadId(`thread_empty_legacy_mention_${index}`),
          tools: noTools,
          userId: userId(`user_empty_legacy_mention_${index}`),
        }),
      ),
    );

    for (const result of results) {
      expect(Result.isError(result)).toBe(true);
      if (Result.isOk(result)) {
        continue;
      }
      expect(result.error).toBeInstanceOf(HandlerError);
      if (!(result.error instanceof HandlerError)) {
        continue;
      }
      expect(result.error.status).toBe(400);
      expect(result.error.message).toBe("Invalid chat message metadata");
    }
  });

  test("restores server-owned rich parts on assistant continuations", async () => {
    const id = chatMessageId("msg_rich_continuation");
    const trustedAudio = richChatParts[0];
    const result = await validateMessageWithPersistence({
      message: {
        id,
        role: "assistant",
        parts: [
          { type: "text", content: "Done" },
          {
            type: "audio",
            source: {
              type: "url",
              value: unsafeScriptUrl,
              mimeType: "audio/mpeg",
            },
          },
        ],
      },
      persistedMessage: {
        role: "assistant",
        content: toChatMessageContent({
          version: 2,
          data: [{ type: "text", content: "Done" }, trustedAudio],
        }),
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_rich_continuation"),
      tools: noTools,
      userId: userId("user_rich_continuation"),
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }
    expect(result.value.message.parts).toEqual([
      { type: "text", content: "Done" },
      trustedAudio,
    ]);
  });

  test("rebuilds assistant continuations from persisted content and validated transitions", async () => {
    const id = chatMessageId("msg_immutable_continuation");
    const completedAskUserCall = {
      type: "tool-call",
      id: "ask-user-complete",
      name: "ask-user",
      arguments: JSON.stringify({
        analysis: "Need governing law",
        questions: [
          { question: "Which law applies?", reason: "Sets the legal test" },
        ],
      }),
      input: {
        analysis: "Need governing law",
        questions: [
          { question: "Which law applies?", reason: "Sets the legal test" },
        ],
      },
      output: {
        answers: [{ question: "Which law applies?", answer: "Czech law" }],
      },
      state: "complete",
    } satisfies ChatParts[number];
    const completedAskUserResult = {
      type: "tool-result",
      toolCallId: "ask-user-complete",
      content: JSON.stringify({
        answers: [{ question: "Which law applies?", answer: "Czech law" }],
      }),
      state: "complete",
    } satisfies ChatParts[number];
    const pendingAskUserCall = {
      type: "tool-call",
      id: "ask-user-1",
      name: "ask-user",
      arguments: JSON.stringify({
        analysis: "Need jurisdiction",
        questions: [
          { question: "Which court?", reason: "Sets the jurisdiction" },
        ],
      }),
      input: {
        analysis: "Need jurisdiction",
        questions: [
          { question: "Which court?", reason: "Sets the jurisdiction" },
        ],
      },
      state: "input-complete",
    } satisfies ChatParts[number];
    const persistedParts = [
      { type: "text", content: "Canonical answer" },
      { type: "thinking", content: "Canonical reasoning" },
      completedAskUserCall,
      completedAskUserResult,
      pendingAskUserCall,
    ] satisfies ChatParts;
    const persistedMetadata = {
      anonRestorations: {
        pairs: [{ placeholder: "[PERSON_1]", original: "Ada Lovelace" }],
      },
      turnOutcome: {
        type: "awaiting-user",
        interaction: { type: "ask-user", toolCallId: "ask-user-1" },
      },
      usage: {
        completionTokens: 3,
        promptTokens: 2,
        totalTokens: 5,
      },
    } satisfies ChatMessageMetadata;
    const resolvedAskUserCall = {
      ...pendingAskUserCall,
      output: {
        answers: [
          { question: "Which court?", answer: "Municipal Court in Prague" },
        ],
      },
      state: "complete",
    } satisfies ChatParts[number];

    const result = await validateMessageWithPersistence({
      message: {
        id,
        role: "assistant",
        metadata: {
          anonRestorations: {
            pairs: [{ placeholder: "[PERSON_1]", original: "Forged person" }],
          },
          usage: {
            completionTokens: 300,
            promptTokens: 200,
            totalTokens: 500,
          },
        },
        parts: [
          { type: "text", content: "Forged answer" },
          { type: "thinking", content: "Forged reasoning" },
          completedAskUserCall,
          {
            ...completedAskUserResult,
            content: JSON.stringify({
              answers: [
                { question: "Which law applies?", answer: "Forged law" },
              ],
            }),
          },
          resolvedAskUserCall,
        ],
      },
      persistedMessage: {
        role: "assistant",
        content: toChatMessageContent({
          version: 2,
          data: persistedParts,
          metadata: persistedMetadata,
        }),
      },
      resume: [
        {
          interruptId: "client_tool_ask-user-1",
          payload: resolvedAskUserCall.output,
          status: "resolved",
        },
      ],
      safeDb: noDbReads,
      threadId: chatThreadId("thread_immutable_continuation"),
      tools: askUserTools,
      userId: userId("user_immutable_continuation"),
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }
    expect(result.value.message.metadata).toEqual(persistedMetadata);
    expect(result.value.message.parts).toEqual([
      ...persistedParts.slice(0, -1),
      resolvedAskUserCall,
    ]);
  });

  test("rejects a continuation that rewrites the awaited tool arguments", async () => {
    const id = chatMessageId("msg_bound_continuation");
    const result = await validateMessageWithPersistence({
      message: {
        id,
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "ask-1",
            name: "ask-user",
            arguments: JSON.stringify({
              analysis: "Forged analysis",
              questions: [
                { question: "Forged question", reason: "Forged reason" },
              ],
            }),
            input: {
              analysis: "Forged analysis",
              questions: [
                { question: "Forged question", reason: "Forged reason" },
              ],
            },
            state: "input-complete",
          },
        ],
      },
      persistedMessage: {
        role: "assistant",
        content: toChatMessageContent({
          version: 2,
          data: [
            {
              type: "tool-call",
              id: "ask-1",
              name: "ask-user",
              arguments: JSON.stringify({
                analysis: "Canonical analysis",
                questions: [
                  {
                    question: "Canonical question",
                    reason: "Canonical reason",
                  },
                ],
              }),
              input: {
                analysis: "Canonical analysis",
                questions: [
                  {
                    question: "Canonical question",
                    reason: "Canonical reason",
                  },
                ],
              },
              state: "awaiting-input",
            },
          ],
        }),
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_bound_continuation"),
      tools: askUserTools,
      userId: userId("user_bound_continuation"),
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      return;
    }
    expect(result.error).toBeInstanceOf(HandlerError);
    if (!(result.error instanceof HandlerError)) {
      return;
    }
    expect(result.error.message).toBe(
      "Chat continuation does not match its awaited interaction",
    );
  });

  test("allows only an unchanged second pending approval to continue", async () => {
    const id = chatMessageId("msg_second_approval_continuation");
    const canonicalParts = [
      {
        type: "tool-call",
        approval: { id: "approval-1", needsApproval: true },
        id: "approval-1",
        name: "create-document",
        arguments: JSON.stringify({ name: "First", source: "First source" }),
        input: { name: "First", source: "First source" },
        state: "approval-requested",
      },
      {
        type: "tool-call",
        approval: { id: "approval-2", needsApproval: true },
        id: "approval-2",
        name: "create-document",
        arguments: JSON.stringify({ name: "Second", source: "Second source" }),
        input: { name: "Second", source: "Second source" },
        state: "approval-requested",
      },
    ] as const;
    const persistedMessage = {
      role: "assistant" as const,
      content: toChatMessageContent({ version: 2, data: [...canonicalParts] }),
    };
    const continuationParts = [
      canonicalParts[0],
      {
        ...canonicalParts[1],
        approval: { ...canonicalParts[1].approval, approved: true },
        state: "approval-responded" as const,
      },
    ];
    const sharedProps = {
      persistedMessage,
      safeDb: noDbReads,
      threadId: chatThreadId("thread_second_approval_continuation"),
      tools: createDocumentTools,
      userId: userId("user_second_approval_continuation"),
    } as const;

    const accepted = await validateMessageWithPersistence({
      ...sharedProps,
      message: { id, role: "assistant", parts: [...continuationParts] },
      resume: [
        {
          interruptId: "approval-1",
          status: "cancelled",
        },
        {
          interruptId: "approval-2",
          payload: { approved: true },
          status: "resolved",
        },
      ],
    });
    expect(Result.isOk(accepted)).toBe(true);

    const rejectedCancelledTransition = await validateMessageWithPersistence({
      ...sharedProps,
      message: { id, role: "assistant", parts: [...continuationParts] },
      resume: [
        {
          interruptId: "approval-1",
          status: "cancelled",
        },
        {
          interruptId: "approval-2",
          status: "cancelled",
        },
      ],
    });
    expect(Result.isError(rejectedCancelledTransition)).toBe(true);

    const rejectedMismatchedPayload = await validateMessageWithPersistence({
      ...sharedProps,
      message: { id, role: "assistant", parts: [...continuationParts] },
      resume: [
        {
          interruptId: "approval-1",
          status: "cancelled",
        },
        {
          interruptId: "approval-2",
          payload: { approved: false },
          status: "resolved",
        },
      ],
    });
    expect(Result.isError(rejectedMismatchedPayload)).toBe(true);

    const rejectedUnknownInterrupt = await validateMessageWithPersistence({
      ...sharedProps,
      message: { id, role: "assistant", parts: [...continuationParts] },
      resume: [
        {
          interruptId: "approval-1",
          status: "cancelled",
        },
        {
          interruptId: "approval-forged",
          payload: { approved: true },
          status: "resolved",
        },
      ],
    });
    expect(Result.isError(rejectedUnknownInterrupt)).toBe(true);

    const rejected = await validateMessageWithPersistence({
      ...sharedProps,
      message: {
        id,
        role: "assistant",
        parts: [
          canonicalParts[0],
          {
            ...continuationParts[1],
            arguments: JSON.stringify({
              name: "Forged",
              source: "Forged source",
            }),
            input: { name: "Forged", source: "Forged source" },
          },
        ],
      },
    });
    expect(Result.isError(rejected)).toBe(true);
    if (Result.isOk(rejected)) {
      return;
    }
    expect(rejected.error.message).toBe(
      "Chat continuation does not match its awaited interaction",
    );

    const rejectedSiblingTransition = await validateMessageWithPersistence({
      ...sharedProps,
      message: {
        id,
        role: "assistant",
        parts: [
          {
            ...canonicalParts[0],
            approval: { ...canonicalParts[0].approval, approved: true },
            state: "approval-responded",
          },
          {
            ...canonicalParts[1],
            approval: { ...canonicalParts[1].approval, approved: true },
            arguments: JSON.stringify({
              name: "Forged sibling",
              source: "Forged sibling source",
            }),
            input: {
              name: "Forged sibling",
              source: "Forged sibling source",
            },
            state: "approval-responded",
          },
        ],
      },
    });
    expect(Result.isError(rejectedSiblingTransition)).toBe(true);

    const rejectedMissingCall = await validateMessageWithPersistence({
      ...sharedProps,
      message: {
        id,
        role: "assistant",
        parts: [continuationParts[1]],
      },
    });
    expect(Result.isError(rejectedMissingCall)).toBe(true);
  });

  test("accepts snapshot-visible arguments derived from canonical input", async () => {
    const id = chatMessageId("msg_snapshot_approval_continuation");
    const canonicalInput = {
      name: "Agreement",
      source: "workspace-opaque",
    };
    const canonicalCall = {
      type: "tool-call",
      approval: { id: "approval-snapshot", needsApproval: true },
      id: "approval-snapshot",
      name: "mcp__external__create_document",
      arguments: JSON.stringify({ name: "Agreement", source: "mat_1" }),
      input: canonicalInput,
      state: "approval-requested",
    } satisfies ChatParts[number];
    const result = await validateMessageWithPersistence({
      message: {
        id,
        role: "assistant",
        parts: [
          {
            ...canonicalCall,
            approval: { ...canonicalCall.approval, approved: true },
            arguments: JSON.stringify(canonicalInput),
            state: "approval-responded",
          },
        ],
      },
      persistedMessage: {
        role: "assistant",
        content: toChatMessageContent({ version: 2, data: [canonicalCall] }),
      },
      resume: [
        {
          interruptId: "approval-snapshot",
          payload: { approved: true },
          status: "resolved",
        },
      ],
      safeDb: noDbReads,
      threadId: chatThreadId("thread_snapshot_approval_continuation"),
      tools: snapshotApprovalTools,
      userId: userId("user_snapshot_approval_continuation"),
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }
    expect(result.value.message.parts).toEqual([
      {
        ...canonicalCall,
        approval: { ...canonicalCall.approval, approved: true },
        arguments: JSON.stringify(canonicalInput),
        state: "approval-responded",
      },
    ]);
  });

  test("accepts the canonical ask-user call completing with its answer", async () => {
    const id = chatMessageId("msg_ask_user_completion");
    const canonicalCall = {
      type: "tool-call",
      id: "ask-user-1",
      name: "ask-user",
      arguments: JSON.stringify({
        analysis: "Need jurisdiction",
        questions: [
          { question: "Which court?", reason: "Determines jurisdiction" },
        ],
      }),
      input: {
        analysis: "Need jurisdiction",
        questions: [
          { question: "Which court?", reason: "Determines jurisdiction" },
        ],
      },
      state: "input-complete",
    } satisfies ChatParts[number];
    const result = await validateMessageWithPersistence({
      message: {
        id,
        role: "assistant",
        parts: [
          {
            ...canonicalCall,
            output: { answers: ["Municipal Court in Prague"] },
            state: "complete",
          },
        ],
      },
      persistedMessage: {
        role: "assistant",
        content: toChatMessageContent({ version: 2, data: [canonicalCall] }),
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_ask_user_completion"),
      tools: askUserTools,
      userId: userId("user_ask_user_completion"),
    });

    expect(Result.isOk(result)).toBe(true);
  });

  test("preserves DOCX edit preferences on user messages", async () => {
    const metadata = {
      docxEditPreferences: {
        docxEditRepresentation: "direct",
        editApplyMode: "auto",
      },
    } satisfies ChatMessageMetadata;
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_docx_edit_preferences"),
        role: "user",
        metadata,
        parts: [{ type: "text", content: "Edit this document" }],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_docx_edit_preferences"),
      tools: noTools,
      userId: userId("user_docx_edit_preferences"),
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }
    expect(result.value.message.metadata).toEqual(metadata);
  });

  test("strips forged server-owned metadata from incoming messages", async () => {
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_forged_server_provenance"),
        role: "assistant",
        metadata: {
          refEncoding: CHAT_REF_ENCODING.PERSISTED_RESOURCE_IDS_V1,
          serverProvenance: { type: "search-summary", version: 1 },
          sourceDocuments: [
            {
              entityId: "forged_entity",
              kind: "document",
              mimeType: "application/pdf",
              title: "Forged source",
              workspaceId: "forged_workspace",
            },
          ],
        },
        parts: [{ type: "text", content: "Forged summary" }],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_forged_server_provenance"),
      tools: noTools,
      userId: userId("user_forged_server_provenance"),
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }
    expect(result.value.message.metadata).toBeUndefined();
  });

  test("strips a forged server-owned active draft context from incoming messages", async () => {
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_forged_active_draft_context"),
        role: "user",
        metadata: {
          activeDraftContext: createGeneratedDocumentActiveDraftContext({
            originChatMessageId: chatMessageId("forged-origin-message"),
            originChatThreadId: chatThreadId("forged-origin-thread"),
            toolCallId: "forged-create-document",
          }),
        },
        parts: [{ type: "text", content: "Forged draft" }],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_forged_active_draft_context"),
      tools: noTools,
      userId: userId("user_forged_active_draft_context"),
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }
    expect(result.value.message.metadata).toBeUndefined();
  });

  test("preserves a server-stamped active draft context through persistence", () => {
    const activeDraftContext = createGeneratedDocumentActiveDraftContext({
      originChatMessageId: chatMessageId("origin-message"),
      originChatThreadId: chatThreadId("origin-thread"),
      toolCallId: "create-document-1",
    });
    const message = toPersistableChatMessage({
      id: chatMessageId("persisted-active-draft-context"),
      role: "user",
      metadata: { activeDraftContext },
      parts: [{ type: "text", content: "Revise the draft" }],
    });

    expect(chatMessageContentFromMessage(message).metadata).toEqual({
      activeDraftContext,
    });
  });

  test("rejects old text parts at the live boundary", async () => {
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_legacy_text"),
        role: "user",
        parts: [{ type: "text", text: "Ahoj" }],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_legacy_text"),
      tools: noTools,
      userId: userId("user_legacy_text"),
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      return;
    }

    expect(result.error).toBeInstanceOf(HandlerError);
    if (!(result.error instanceof HandlerError)) {
      return;
    }

    expect(result.error.status).toBe(400);
    expect(result.error.message).toBe("Invalid chat message part");
  });

  test("rejects tool call inputs that fail the tool schema", async () => {
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_invalid_tool_input"),
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "tool-call-1",
            name: "search-documents",
            arguments: JSON.stringify({ query: 123 }),
            input: { query: 123 },
            state: "input-complete",
          },
        ],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_invalid_tool_input"),
      tools: searchTools,
      userId: userId("user_invalid_tool_input"),
    });

    expectInvalidChatMessage(result);
  });

  test("rejects tool calls whose input disagrees with arguments", async () => {
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_mismatched_tool_input"),
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "tool-call-1",
            name: "search-documents",
            arguments: JSON.stringify({ query: "contract" }),
            input: { query: "different" },
            state: "input-complete",
          },
        ],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_mismatched_tool_input"),
      tools: searchTools,
      userId: userId("user_mismatched_tool_input"),
    });

    expectInvalidChatMessage(result);
  });

  test("accepts an input-complete tool call that carries only arguments", async () => {
    // TanStack may send a valid `arguments` string without `input`. The live
    // boundary accepts that wire shape and returns canonical parsed input.
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_arguments_only_tool_call"),
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "tool-call-1",
            name: "search-documents",
            arguments: JSON.stringify({ query: "contract" }),
            state: "input-complete",
          },
        ],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_arguments_only_tool_call"),
      tools: searchTools,
      userId: userId("user_arguments_only_tool_call"),
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }
    const part = result.value.message.parts.at(0);
    expect(part?.type).toBe("tool-call");
    if (part?.type !== "tool-call") {
      return;
    }
    expect(part.input).toEqual({ query: "contract" });
  });

  test("rejects an input-complete tool call whose arguments fail the tool schema", async () => {
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_arguments_only_invalid"),
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "tool-call-1",
            name: "search-documents",
            arguments: JSON.stringify({ query: 123 }),
            state: "input-complete",
          },
        ],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_arguments_only_invalid"),
      tools: searchTools,
      userId: userId("user_arguments_only_invalid"),
    });

    expectInvalidChatMessage(result);
  });

  test("rejects tool call outputs that fail the tool schema", async () => {
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_invalid_tool_output"),
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "tool-call-1",
            name: "search-documents",
            arguments: JSON.stringify({ query: "contract" }),
            input: { query: "contract" },
            output: { text: 123 },
            state: "complete",
          },
        ],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_invalid_tool_output"),
      tools: searchTools,
      userId: userId("user_invalid_tool_output"),
    });

    expectInvalidChatMessage(result);
  });

  test("accepts a failed tool call and its error result during continuation", async () => {
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_failed_tool_continuation"),
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "tool-call-1",
            name: "search-documents",
            arguments: JSON.stringify({ query: "contract" }),
            input: { query: "contract" },
            output: { error: "Search is temporarily unavailable" },
            state: "error",
          },
          {
            type: "tool-result",
            toolCallId: "tool-call-1",
            content: "null",
            error: "Search is temporarily unavailable",
            state: "error",
          },
        ],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_failed_tool_continuation"),
      tools: searchTools,
      userId: userId("user_failed_tool_continuation"),
    });

    expect(Result.isOk(result)).toBe(true);
  });

  test("round-trips TanStack's persisted server-tool error result", async () => {
    const error = "Search is temporarily unavailable";
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_server_tool_error_continuation"),
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "tool-call-1",
            name: "search-documents",
            arguments: JSON.stringify({ query: "contract" }),
            input: { query: "contract" },
            output: { error },
            state: "error",
          },
          {
            type: "tool-result",
            toolCallId: "tool-call-1",
            content: JSON.stringify({ error }),
            error,
            state: "error",
          },
        ],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_server_tool_error_continuation"),
      tools: searchTools,
      userId: userId("user_server_tool_error_continuation"),
    });

    expect(Result.isOk(result)).toBe(true);
  });

  test("rejects a malformed failed tool-call output", async () => {
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_malformed_failed_tool"),
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "tool-call-1",
            name: "search-documents",
            arguments: JSON.stringify({ query: "contract" }),
            output: { error: 123 },
            state: "error",
          },
        ],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_malformed_failed_tool"),
      tools: searchTools,
      userId: userId("user_malformed_failed_tool"),
    });

    expectInvalidChatMessage(result);
  });

  test("accepts tool results that match the paired tool output", async () => {
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_valid_tool_result"),
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "tool-call-1",
            name: "search-documents",
            arguments: JSON.stringify({ query: "contract" }),
            input: { query: "contract" },
            output: { text: "Found contract" },
            state: "complete",
          },
          {
            type: "tool-result",
            toolCallId: "tool-call-1",
            content: JSON.stringify({ text: "Found contract" }),
            state: "complete",
          },
        ],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_valid_tool_result"),
      tools: searchTools,
      userId: userId("user_valid_tool_result"),
    });

    expect(Result.isOk(result)).toBe(true);
  });

  test("rejects tool results without a paired tool call", async () => {
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_unpaired_tool_result"),
        role: "assistant",
        parts: [
          {
            type: "tool-result",
            toolCallId: "tool-call-1",
            content: JSON.stringify({ text: "Found contract" }),
            state: "complete",
          },
        ],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_unpaired_tool_result"),
      tools: searchTools,
      userId: userId("user_unpaired_tool_result"),
    });

    expectInvalidChatMessage(result);
  });

  test("rejects tool results that fail the paired tool output schema", async () => {
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_invalid_tool_result"),
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "tool-call-1",
            name: "search-documents",
            arguments: JSON.stringify({ query: "contract" }),
            input: { query: "contract" },
            output: { text: "Found contract" },
            state: "complete",
          },
          {
            type: "tool-result",
            toolCallId: "tool-call-1",
            content: JSON.stringify({ text: 123 }),
            state: "complete",
          },
        ],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_invalid_tool_result"),
      tools: searchTools,
      userId: userId("user_invalid_tool_result"),
    });

    expectInvalidChatMessage(result);
  });

  test("rejects tool results that disagree with the paired tool output", async () => {
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_mismatched_tool_result"),
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "tool-call-1",
            name: "search-documents",
            arguments: JSON.stringify({ query: "contract" }),
            input: { query: "contract" },
            output: { text: "Found contract" },
            state: "complete",
          },
          {
            type: "tool-result",
            toolCallId: "tool-call-1",
            content: JSON.stringify({ text: "Different result" }),
            state: "complete",
          },
        ],
      },
      safeDb: noDbReads,
      threadId: chatThreadId("thread_mismatched_tool_result"),
      tools: searchTools,
      userId: userId("user_mismatched_tool_result"),
    });

    expectInvalidChatMessage(result);
  });
});

const expectInvalidChatMessage = (
  result: Awaited<ReturnType<typeof validateMessage>>,
): void => {
  expect(Result.isError(result)).toBe(true);
  if (Result.isOk(result)) {
    return;
  }

  expect(result.error).toBeInstanceOf(HandlerError);
  if (!(result.error instanceof HandlerError)) {
    return;
  }

  expect(result.error.status).toBe(400);
  expect(result.error.message).toBe("Invalid chat message");
};

describe("validateStoredFileRefs", () => {
  test("rejects missing stored files", () => {
    const refs = [
      { id: userFileId("file_test"), mediaType: "image/png" },
    ] satisfies StoredFileRef[];

    const result = validateStoredFileRefs({
      refs,
      files: [],
      threadId: chatThreadId("thread_test"),
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      return;
    }

    expect(result.error.status).toBe(404);
    expect(result.error.message).toBe("Chat attachment file not found");
  });

  test("rejects stored files with mismatched MIME types", () => {
    const refs = [
      { id: userFileId("file_test"), mediaType: "image/png" },
    ] satisfies StoredFileRef[];
    const files = [
      {
        id: userFileId("file_test"),
        mimeType: "application/pdf",
        threadId: chatThreadId("thread_test"),
      },
    ] satisfies StoredChatFile[];

    const result = validateStoredFileRefs({
      refs,
      files,
      threadId: chatThreadId("thread_test"),
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      return;
    }

    expect(result.error.status).toBe(400);
    expect(result.error.message).toBe(
      "Chat attachment MIME type does not match stored file",
    );
  });

  test("rejects stored files from a different thread", () => {
    const refs = [
      { id: userFileId("file_test"), mediaType: "image/png" },
    ] satisfies StoredFileRef[];
    const files = [
      {
        id: userFileId("file_test"),
        mimeType: "image/png",
        threadId: chatThreadId("thread_other"),
      },
    ] satisfies StoredChatFile[];

    const result = validateStoredFileRefs({
      refs,
      files,
      threadId: chatThreadId("thread_test"),
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      return;
    }

    expect(result.error.status).toBe(403);
    expect(result.error.message).toBe(
      "Chat attachment does not belong to this thread",
    );
  });
});
