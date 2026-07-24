import { panic, Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import JSZip from "jszip";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  TEXT_CSV_MIME_TYPE,
  TEXT_MARKDOWN_MIME_TYPE,
  TEXT_PLAIN_MIME_TYPE,
} from "@/api/handlers/chat/attachment-validation";
import { createChatAttachmentPart } from "@/api/handlers/chat/chat-message-parts";
import type { PersistableChatMessage } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { toDataUrl } from "@/api/lib/data-url";
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

/** Minimal DOCX with a heading and a body paragraph, for extraction tests. */
const makeDocxBytes = async (): Promise<Uint8Array> => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Agreement</w:t></w:r></w:p>
  <w:p><w:r><w:t>Jan Novak signs here.</w:t></w:r></w:p>
</w:body></w:document>`,
  );
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
  );
  // Copy into a fresh ArrayBuffer-backed view so `.buffer` is an ArrayBuffer
  // (not ArrayBufferLike) for the S3 arrayBuffer mock's return type.
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
};
const fileMock = mock(() => ({ arrayBuffer: arrayBufferMock }));
const writeMock = mock(async () => undefined);
const s3DeleteMock = mock(async () => undefined);
const workspaceId = toSafeId<"workspace">("workspace_1");

// Spread the real module so only `getS3` is overridden: `mock.module` is
// process-global and never auto-restored, so a partial mock would delete the
// other s3 exports (e.g. `getCorpusS3`) for every later test file in the run.
const realS3 = await import("@/api/lib/s3");
void mock.module("@/api/lib/s3", () => ({
  ...realS3,
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

  test("coerces text-like attachments to a text content part (universal, never modality-gated)", async () => {
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

    // A `text` part, not a `document` part: text needs no adapter modality
    // support, so it can never trip the document gate or crash a stream.
    expect(result.value).toMatchObject({
      type: "anonymizable",
      part: {
        type: "text",
        content: 'Attached file "contacts.csv":\n\nJan Novak,Acme',
      },
    });
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

  // Regression: a raw docx byte stream is not a valid content part for any
  // provider adapter — the previous rawOverride short-circuit shipped it
  // anyway, crashing the stream. A docx must ALWAYS be reduced to extracted
  // text, in both send modes, never sent as raw bytes.
  test.each([CHAT_SEND_MODE.rawOverride, CHAT_SEND_MODE.anonymized])(
    "extracts DOCX to text and never ships raw bytes (%s mode)",
    async (sendMode) => {
      const docxBytes = await makeDocxBytes();
      arrayBufferMock.mockImplementationOnce(async () => {
        const arrayBuffer = new ArrayBuffer(docxBytes.byteLength);
        new Uint8Array(arrayBuffer).set(docxBytes);
        return arrayBuffer;
      });

      const result = await hydrateFilePart({
        fileName: "draft.docx",
        mimeType: DOCX_MIME_TYPE,
        sendMode,
        s3Key: "user/file",
      });

      expect(Result.isOk(result)).toBe(true);
      if (Result.isError(result)) {
        throw result.error;
      }
      // A `text` part carrying the extracted text — never a raw docx part and
      // never a `document` part, so it is universal across provider adapters.
      expect(result.value.type).toBe("anonymizable");
      if (
        result.value.type !== "anonymizable" ||
        result.value.part.type !== "text"
      ) {
        throw new Error("Expected extracted DOCX text as a text content part");
      }
      const extracted = result.value.part.content;
      // Folio markdown extraction preserves structure (heading -> `#`).
      expect(extracted).toContain('Attached file "draft.docx":');
      expect(extracted).toContain("# Agreement");
      expect(extracted).toContain("Jan Novak signs here.");
    },
  );

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
    const safeDb: SafeDb = async <T>(_fn: (tx: Transaction) => Promise<T>) =>
      Result.err(databaseError);
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
      panic("Expected the database save to fail");
    }
    expect(result.error).toBe(databaseError);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(s3DeleteMock).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});
