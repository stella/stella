import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { SafeDb } from "@/api/db";
import { createChatAttachmentPart } from "@/api/handlers/chat/chat-message-parts";
import { validateMessage } from "@/api/handlers/chat/chat-schema";
import type { ChatToolMap } from "@/api/handlers/chat/tools/chat-tool-types";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { toUserFileUrl } from "@/api/handlers/user-files/types";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

import type { StoredChatFile, StoredFileRef } from "./attachment-validation";
import {
  validateChatFileParts,
  validateStoredFileRefs,
} from "./attachment-validation";
import type { ChatMessage } from "./types";

type ChatParts = ChatMessage["parts"];

const userFileId = (id: string) => toSafeId<"userFile">(id);
const chatThreadId = (id: string) => toSafeId<"chatThread">(id);
const userId = (id: string) => toSafeId<"user">(id);
const chatMessageId = (id: string) => toSafeId<"chatMessage">(id);
const noDbReads: SafeDb = async () => {
  throw new Error("This validation path should not read the database");
};
const noTools = {} satisfies ChatToolMap;
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
