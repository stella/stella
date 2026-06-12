import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SafeDb } from "@/api/db";
import { createChatAttachmentPart } from "@/api/handlers/chat/chat-message-parts";
import { validateMessage } from "@/api/handlers/chat/chat-schema";
import type { ChatToolMap } from "@/api/handlers/chat/tools/chat-tool-types";
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
});

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
