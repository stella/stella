import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import {
  TEXT_CSV_MIME_TYPE,
  TEXT_MARKDOWN_MIME_TYPE,
  TEXT_PLAIN_MIME_TYPE,
} from "@/api/handlers/chat/attachment-validation";
import { parseDataUrl } from "@/api/lib/data-url";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

const fileBytes = new TextEncoder().encode("Jan Novak,Acme");
const arrayBufferMock = mock(async () =>
  fileBytes.buffer.slice(
    fileBytes.byteOffset,
    fileBytes.byteOffset + fileBytes.byteLength,
  ),
);
const fileMock = mock(() => ({ arrayBuffer: arrayBufferMock }));

void mock.module("@/api/lib/s3", () => ({
  getS3: () => ({ file: fileMock }),
}));

const { canHydrateFilePartAsPlainText, hydrateFilePart } =
  await import("./upload-files");

describe("chat attachment hydration", () => {
  beforeEach(() => {
    arrayBufferMock.mockClear();
    fileMock.mockClear();
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
        filename: "contacts.csv",
        mediaType: TEXT_PLAIN_MIME_TYPE,
        type: "file",
      },
    });
    if (result.value.type !== "anonymizable") {
      throw new Error("Expected anonymizable attachment hydration");
    }
    const parsed = parseDataUrl({
      expectedMimeType: TEXT_PLAIN_MIME_TYPE,
      maxBytes: 1024,
      url: result.value.part.url,
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
        filename: "scan.pdf",
        mediaType: PDF_MIME_TYPE,
        type: "file",
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
        filename: "draft.docx",
        mediaType: DOCX_MIME_TYPE,
        type: "file",
      },
    });
  });
});
