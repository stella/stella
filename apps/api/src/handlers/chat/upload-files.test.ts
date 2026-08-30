import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import JSZip from "jszip";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { envBase } from "@/api/env-base";
import {
  TEXT_CSV_MIME_TYPE,
  TEXT_MARKDOWN_MIME_TYPE,
  TEXT_PLAIN_MIME_TYPE,
} from "@/api/handlers/chat/attachment-validation";
import {
  createChatAttachmentPart,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { toSafeId } from "@/api/lib/branded-types";
import { toDataUrl } from "@/api/lib/data-url";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import {
  DOCX_MIME_TYPE,
  PDF_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  canHydrateFilePartAsPlainText,
  chatObjectCleanupWorkspaceIds,
  hydrateFilePart,
  uploadMessageFiles,
  uploadUserFile,
} from "./upload-files";

const fileBytes = new TextEncoder().encode("Jan Novak,Acme");
const IMAGE_PNG_MIME_TYPE = "image/png";
const bucket = envBase.S3_BUCKET;
/** The key every `hydrateFilePart` case in this suite reads from. */
const ATTACHMENT_KEY = "user/file";
let fake: FakeS3;

const requestKeys = (method: "DELETE" | "GET" | "PUT"): string[] =>
  fake.requests.flatMap((request) =>
    request.method === method ? [request.key] : [],
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
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
};
const workspaceId = toSafeId<"workspace">("workspace_1");
const uploadDependencies = {
  reserveChatObjectCleanupIntent: async () => Result.ok([]),
};

describe("chat attachment hydration", () => {
  beforeEach(() => {
    fake = startFakeS3();
    fake.put(bucket, ATTACHMENT_KEY, fileBytes, TEXT_CSV_MIME_TYPE);
  });

  afterEach(() => {
    fake.stop();
  });

  test("classifies extractable document and text attachments", () => {
    expect(canHydrateFilePartAsPlainText(TEXT_PLAIN_MIME_TYPE)).toBe(true);
    expect(canHydrateFilePartAsPlainText(TEXT_CSV_MIME_TYPE)).toBe(true);
    expect(canHydrateFilePartAsPlainText(TEXT_MARKDOWN_MIME_TYPE)).toBe(true);
    expect(canHydrateFilePartAsPlainText(DOCX_MIME_TYPE)).toBe(true);
    expect(canHydrateFilePartAsPlainText(XLSX_MIME_TYPE)).toBe(true);
    expect(canHydrateFilePartAsPlainText(PDF_MIME_TYPE)).toBe(false);
  });

  test("assigns recovery ownership to every matter contributing to a chat", () => {
    const otherWorkspaceId = toSafeId<"workspace">("workspace_2");

    expect(
      chatObjectCleanupWorkspaceIds({
        dataWorkspaceIds: [otherWorkspaceId, workspaceId, otherWorkspaceId],
        workspaceId,
      }),
    ).toEqual([otherWorkspaceId, workspaceId].sort());
  });

  test("coerces text-like attachments to a text content part (universal, never modality-gated)", async () => {
    const result = await hydrateFilePart({
      extractedText: null,
      fileName: "contacts.csv",
      mimeType: TEXT_CSV_MIME_TYPE,
      sendMode: CHAT_SEND_MODE.anonymized,
      s3Key: ATTACHMENT_KEY,
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
      extractedText: null,
      fileName: "scan.pdf",
      mimeType: PDF_MIME_TYPE,
      sendMode: CHAT_SEND_MODE.anonymized,
      s3Key: ATTACHMENT_KEY,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.type).toBe("blocked");
    expect(requestKeys("GET")).toEqual([]);
  });

  test("hydrates non-extractable attachments as raw override when the user allows it", async () => {
    const result = await hydrateFilePart({
      extractedText: null,
      fileName: "scan.pdf",
      mimeType: PDF_MIME_TYPE,
      sendMode: CHAT_SEND_MODE.rawOverride,
      s3Key: ATTACHMENT_KEY,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value).toMatchObject({
      type: "rawOverride",
      part: {
        metadata: { filename: "scan.pdf" },
        source: {
          type: "data",
          value: Buffer.from(fileBytes).toString("base64"),
          mimeType: PDF_MIME_TYPE,
        },
        type: "document",
      },
    });
  });

  test("keeps raw image attachments URL-backed for provider adapters", async () => {
    const result = await hydrateFilePart({
      extractedText: null,
      fileName: "scan.png",
      mimeType: IMAGE_PNG_MIME_TYPE,
      sendMode: CHAT_SEND_MODE.rawOverride,
      s3Key: ATTACHMENT_KEY,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value).toMatchObject({
      type: "rawOverride",
      part: {
        metadata: { filename: "scan.png" },
        source: {
          type: "url",
          value: toDataUrl(fileBytes, IMAGE_PNG_MIME_TYPE),
          mimeType: IMAGE_PNG_MIME_TYPE,
        },
        type: "image",
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
      fake.put(bucket, ATTACHMENT_KEY, await makeDocxBytes(), DOCX_MIME_TYPE);

      const result = await hydrateFilePart({
        extractedText: null,
        fileName: "draft.docx",
        mimeType: DOCX_MIME_TYPE,
        sendMode,
        s3Key: ATTACHMENT_KEY,
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

  test.each([CHAT_SEND_MODE.rawOverride, CHAT_SEND_MODE.anonymized])(
    "extracts XLSX to text and never ships raw bytes (%s mode)",
    async (sendMode) => {
      fake.put(
        bucket,
        ATTACHMENT_KEY,
        new Uint8Array(
          await Bun.file(
            new URL(
              "../../lib/search/__fixtures__/schedule.xlsx",
              import.meta.url,
            ),
          ).arrayBuffer(),
        ),
        XLSX_MIME_TYPE,
      );

      const result = await hydrateFilePart({
        extractedText: null,
        fileName: "schedule.xlsx",
        mimeType: XLSX_MIME_TYPE,
        sendMode,
        s3Key: ATTACHMENT_KEY,
      });

      expect(Result.isOk(result)).toBe(true);
      if (Result.isError(result)) {
        throw result.error;
      }
      expect(result.value.type).toBe("anonymizable");
      if (
        result.value.type !== "anonymizable" ||
        result.value.part.type !== "text"
      ) {
        throw new Error("Expected extracted XLSX text as a text content part");
      }
      expect(result.value.part.content).toContain(
        'Attached file "schedule.xlsx":',
      );
      expect(result.value.part.content).toContain("Counterparty");
      expect(result.value.part.content).toContain("Acme s.r.o.");
      expect(result.value.part.content).toContain(
        "Termination notice period is three months.",
      );
    },
  );

  test("persists XLSX text at upload and hydrates it without rereading the workbook", async () => {
    const values = mock(
      async (_row: { extractedText: string | null }) => undefined,
    );
    const testTx = asTestRaw<Transaction>({
      insert: mock(() => ({ values })),
    });
    const safeDb: SafeDb = async (callback) =>
      await Result.tryPromise(async () => await callback(testTx));
    const bytes = new Uint8Array(
      await Bun.file(
        new URL("../../lib/search/__fixtures__/schedule.xlsx", import.meta.url),
      ).arrayBuffer(),
    );

    const uploadResult = await uploadUserFile({
      dependencies: uploadDependencies,
      file: {
        bytes,
        fileName: "schedule.xlsx",
        mimeType: XLSX_MIME_TYPE,
      },
      recordAuditEvent: mock(async () => undefined),
      safeDb,
      threadId: toSafeId<"chatThread">("11111111-1111-4111-8111-111111111112"),
      userId: toSafeId<"user">("11111111-1111-4111-8111-111111111113"),
      workspaceId,
    });

    expect(Result.isOk(uploadResult)).toBe(true);
    const extractedText = values.mock.calls.at(0)?.at(0)?.extractedText;
    if (typeof extractedText !== "string") {
      throw new TypeError("Expected upload to persist extracted XLSX text");
    }
    expect(extractedText).toContain("Acme s.r.o.");

    const hydrateResult = await hydrateFilePart({
      extractedText,
      fileName: "schedule.xlsx",
      mimeType: XLSX_MIME_TYPE,
      sendMode: CHAT_SEND_MODE.rawOverride,
      s3Key: ATTACHMENT_KEY,
    });

    expect(Result.isOk(hydrateResult)).toBe(true);
    // The cached text answered the hydration: the workbook was never fetched.
    expect(requestKeys("GET")).toEqual([]);
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
      await Result.tryPromise(async () => await callback(testTx));
    const message = toPersistableChatMessage({
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
    });

    const recordAuditEvent = mock(async () => undefined);
    const result = await uploadMessageFiles({
      dependencies: uploadDependencies,
      message,
      recordAuditEvent,
      safeDb,
      threadId: toSafeId<"chatThread">("thread_1"),
      userId: toSafeId<"user">("user_1"),
      workspaceId,
    });

    expect(Result.isError(result)).toBe(true);
    // The first attachment landed and was then rolled back out of the store,
    // leaving only the seeded fixture behind.
    expect(requestKeys("PUT")).toHaveLength(1);
    expect(requestKeys("DELETE")).toEqual(requestKeys("PUT"));
    expect([...fake.objects.keys()]).toEqual([`${bucket}/${ATTACHMENT_KEY}`]);
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
    const cleanupIntentId = toSafeId<"pendingUpload">(
      "11111111-1111-4111-8111-111111111114",
    );
    const settleObjectCleanupIntentsAfterWriter = mock(async () =>
      Result.ok(undefined),
    );
    const testTx = asTestRaw<Transaction>({
      insert: () => ({
        values: async () => {
          throw databaseError;
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            for: async () => [{ id: cleanupIntentId, status: "writing" }],
          }),
        }),
      }),
    });
    const safeDb: SafeDb = async (callback) =>
      Result.mapError(
        await Result.tryPromise(async () => await callback(testTx)),
        () => databaseError,
      );
    const recordAuditEvent = mock(async () => undefined);

    const result = await uploadUserFile({
      dependencies: {
        reserveChatObjectCleanupIntent: async () =>
          Result.ok([cleanupIntentId]),
        settleObjectCleanupIntentsAfterWriter,
      },
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
    expect(requestKeys("PUT")).toHaveLength(1);
    expect(requestKeys("DELETE")).toEqual(requestKeys("PUT"));
    expect([...fake.objects.keys()]).toEqual([`${bucket}/${ATTACHMENT_KEY}`]);
    expect(recordAuditEvent).not.toHaveBeenCalled();
    expect(settleObjectCleanupIntentsAfterWriter).toHaveBeenCalledWith({
      intentIds: [cleanupIntentId],
      objectState: "object-deleted",
      safeDb,
    });
  });

  test("stores a sanitized filename, whatever the caller supplied", async () => {
    // SW-0009 waives `no-raw-filename-write` at `hydrateMessages` on two
    // claims: hydration names files from the stored row, and the stored row
    // was sanitized by this single writer. The hydration test pins the first;
    // this pins the second, so a writer that stopped sanitizing fails here
    // rather than surfacing as a hostile name the waiver said was impossible.
    const hostileName = '../../etc/passwd";rm -rf /';
    // Typed by what the assertion reads, so the captured row keeps its shape
    // instead of arriving as an untyped call record.
    const values = mock(async (_row: { fileName: string }) => undefined);
    const testTx = asTestRaw<Transaction>({
      insert: mock(() => ({ values })),
    });
    const safeDb: SafeDb = async (callback) =>
      await Result.tryPromise(async () => await callback(testTx));

    const result = await uploadUserFile({
      dependencies: uploadDependencies,
      file: {
        bytes: new TextEncoder().encode("confidential text"),
        fileName: hostileName,
        mimeType: TEXT_PLAIN_MIME_TYPE,
      },
      recordAuditEvent: mock(async () => undefined),
      safeDb,
      threadId: toSafeId<"chatThread">("11111111-1111-4111-8111-111111111112"),
      userId: toSafeId<"user">("11111111-1111-4111-8111-111111111113"),
      workspaceId,
    });

    expect(Result.isOk(result)).toBe(true);
    // The bytes reached the store under the key the row names, typed with the
    // declared MIME type so the object is served as text, not as a download.
    const stored = fake.objects.get(`${bucket}/${requestKeys("PUT").at(0)}`);
    expect(stored?.bytes).toEqual(
      new TextEncoder().encode("confidential text"),
    );
    // Bun's client appends a charset to text media types.
    expect(stored?.contentType).toContain(TEXT_PLAIN_MIME_TYPE);
    const storedName = values.mock.calls.at(0)?.at(0)?.fileName;
    expect(storedName).toBe(sanitizeFilename(hostileName));
    expect(storedName).not.toBe(hostileName);
  });
});
