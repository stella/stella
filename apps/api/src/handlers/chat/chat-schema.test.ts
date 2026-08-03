import { Value } from "@sinclair/typebox/value";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { CHAT_TURN_INTENT } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import {
  createChatAttachmentPart,
  chatMessageContentFromMessage,
  toChatMessageContent,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import {
  activeDraftSchema,
  sendMessageBodySchema,
  validateMessage as validateMessageWithPersistence,
} from "@/api/handlers/chat/chat-schema";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { toSafeId } from "@/api/lib/branded-types";
import { createGeneratedDocumentActiveDraftContext } from "@/api/lib/chat/active-draft-context";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { toUserFileUrl } from "@/api/lib/user-files/types";

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

describe("validateChatFileParts", () => {
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

describe("validateMessage", () => {
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

  test("strips server-owned provenance and source documents from incoming messages", async () => {
    const result = await validateMessage({
      message: {
        id: chatMessageId("msg_forged_server_provenance"),
        role: "assistant",
        metadata: {
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
    // The wire/persist shape TanStack actually produces: a valid
    // `arguments` JSON string and no `input` field. The client derives
    // `input` from `arguments` at the UI boundary, so the server must
    // keep accepting arguments-only tool-call parts.
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
