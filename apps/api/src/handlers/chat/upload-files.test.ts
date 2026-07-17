import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  TEXT_CSV_MIME_TYPE,
  TEXT_MARKDOWN_MIME_TYPE,
  TEXT_PLAIN_MIME_TYPE,
} from "@/api/handlers/chat/attachment-validation";
import {
  createChatAttachmentPart,
  getChatAttachmentUrl,
} from "@/api/handlers/chat/chat-message-parts";
import type { PersistableChatMessage } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { parseDataUrl, toDataUrl } from "@/api/lib/data-url";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const fileBytes = new TextEncoder().encode("Jan Novak,Acme");
const arrayBufferMock = mock(async () =>
  fileBytes.buffer.slice(
    fileBytes.byteOffset,
    fileBytes.byteOffset + fileBytes.byteLength,
  ),
);
const fileMock = mock(() => ({ arrayBuffer: arrayBufferMock }));
const writeMock = mock(async () => undefined);
const s3DeleteMock = mock(async () => undefined);
const workspaceId = toSafeId<"workspace">("workspace_1");

void mock.module("@/api/lib/s3", () => ({
  getS3: () => ({ delete: s3DeleteMock, file: fileMock, write: writeMock }),
}));

const {
  canHydrateFilePartAsPlainText,
  hydrateFilePart,
  uploadMessageFiles,
  uploadUserFile,
} = await import("./upload-files");

describe("chat attachment hydration", () => {
  beforeEach(() => {
    arrayBufferMock.mockClear();
    fileMock.mockClear();
    s3DeleteMock.mockClear();
    writeMock.mockClear();
  });

  test("classifies extractable document and text attachments", () => {
    expect(canHydrateFilePartAsPlainText(TEXT_PLAIN_MIME_TYPE)).toBe(true);
    expect(canHydrateFilePartAsPlainText(TEXT_CSV_MIME_TYPE)).toBe(true);
    expect(canHydrateFilePartAsPlainText(TEXT_MARKDOWN_MIME_TYPE)).toBe(true);
    expect(canHydrateFilePartAsPlainText(DOCX_MIME_TYPE)).toBe(true);
    expect(canHydrateFilePartAsPlainText(PDF_MIME_TYPE)).toBe(false);
  });

  test("coerces text-like attachments to plain text for anonymized sends", async () => {
    const result = await hydrateFilePart({
      fileName: "contacts.csv",
      mimeType: TEXT_CSV_MIME_TYPE,
      sendMode: CHAT_SEND_MODE.anonymized,
      s3Key: "user/file",
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }

    expect(result.value).toMatchObject({
      type: "anonymizable",
      part: {
        metadata: { filename: "contacts.csv" },
        source: { mimeType: TEXT_PLAIN_MIME_TYPE },
        type: "document",
      },
    });
    if (result.value.type !== "anonymizable") {
      throw new Error("Expected anonymizable attachment hydration");
    }
    const parsed = parseDataUrl({
      expectedMimeType: TEXT_PLAIN_MIME_TYPE,
      maxBytes: 1024,
      url: getChatAttachmentUrl(result.value.part),
    });

    expect(Result.isOk(parsed)).toBe(true);
    if (Result.isError(parsed)) {
      throw parsed.error;
    }
    expect(new TextDecoder().decode(parsed.value.bytes)).toBe("Jan Novak,Acme");
  });

  test("blocks non-extractable attachments before reading bytes in anonymized mode", async () => {
    const result = await hydrateFilePart({
      fileName: "scan.pdf",
      mimeType: PDF_MIME_TYPE,
      sendMode: CHAT_SEND_MODE.anonymized,
      s3Key: "user/file",
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.type).toBe("blocked");
    expect(fileMock).not.toHaveBeenCalled();
  });

  test("hydrates non-extractable attachments as raw override when the user allows it", async () => {
    const result = await hydrateFilePart({
      fileName: "scan.pdf",
      mimeType: PDF_MIME_TYPE,
      sendMode: CHAT_SEND_MODE.rawOverride,
      s3Key: "user/file",
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value).toMatchObject({
      type: "rawOverride",
      part: {
        metadata: { filename: "scan.pdf" },
        source: { mimeType: PDF_MIME_TYPE },
        type: "document",
      },
    });
  });

  test("raw override bypasses DOCX text extraction and sends the original file", async () => {
    const result = await hydrateFilePart({
      fileName: "draft.docx",
      mimeType: DOCX_MIME_TYPE,
      sendMode: CHAT_SEND_MODE.rawOverride,
      s3Key: "user/file",
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value).toMatchObject({
      type: "rawOverride",
      part: {
        metadata: { filename: "draft.docx" },
        source: { mimeType: DOCX_MIME_TYPE },
        type: "document",
      },
    });
  });

  test("cleans up already uploaded files when a later attachment fails", async () => {
    const valuesMock = mock(async () => undefined);
    const insertMock = mock(() => ({ values: valuesMock }));
    const whereMock = mock(async () => undefined);
    const deleteMock = mock(() => ({ where: whereMock }));
    const tx = {
      delete: deleteMock,
      insert: insertMock,
    };
    // The upload helper only touches `insert().values()` and
    // `delete().where()` in this regression test.
    const testTx = asTestRaw<Transaction>(tx);
    const safeDb: SafeDb = async (callback) =>
      // oxlint-disable-next-line node/callback-return -- arrow body already returns the callback result
      await Result.tryPromise(async () => await callback(testTx));
    const message: PersistableChatMessage = {
      id: toSafeId<"chatMessage">("11111111-1111-4111-8111-111111111111"),
      role: "user",
      parts: [
        createChatAttachmentPart({
          filename: "first.txt",
          mimeType: TEXT_PLAIN_MIME_TYPE,
          url: toDataUrl(
            new TextEncoder().encode("first"),
            TEXT_PLAIN_MIME_TYPE,
          ),
        }),
        createChatAttachmentPart({
          filename: "broken.txt",
          mimeType: TEXT_PLAIN_MIME_TYPE,
          url: "not-a-data-url",
        }),
      ],
    };

    const recordAuditEvent = mock(async () => undefined);
    const result = await uploadMessageFiles({
      message,
      recordAuditEvent,
      safeDb,
      threadId: toSafeId<"chatThread">("thread_1"),
      userId: toSafeId<"user">("user_1"),
      workspaceId,
    });

    expect(Result.isError(result)).toBe(true);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(s3DeleteMock).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      testTx,
      expect.objectContaining({ workspaceId }),
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(
      testTx,
      expect.arrayContaining([expect.objectContaining({ workspaceId })]),
    );
  });

  test("deletes the stored object when the database save fails", async () => {
    const databaseError = new DatabaseError({
      message: "user file insert failed",
    });
    const safeDb: SafeDb = async <T>() =>
      Result.err<T, SafeDbError>(databaseError);
    const recordAuditEvent = mock(async () => undefined);

    const result = await uploadUserFile({
      file: {
        bytes: new TextEncoder().encode("confidential text"),
        fileName: "notes.txt",
        mimeType: TEXT_PLAIN_MIME_TYPE,
      },
      recordAuditEvent,
      safeDb,
      threadId: toSafeId<"chatThread">("11111111-1111-4111-8111-111111111112"),
      userId: toSafeId<"user">("11111111-1111-4111-8111-111111111113"),
      workspaceId,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("Expected the database save to fail");
    }
    expect(result.error).toBe(databaseError);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(s3DeleteMock).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});
