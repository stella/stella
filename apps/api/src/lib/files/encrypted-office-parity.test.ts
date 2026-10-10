/**
 * A password-protected Office upload takes the path an encrypted PDF takes:
 * the upload scan accepts it, the detector records it encrypted, and every
 * consumer that reads the attribute answers it the same way.
 */
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import { ENCRYPTED_CONTENT_ERROR_CODE } from "@stll/api-contract";

import { uploadUserFile } from "@/api/handlers/chat/upload-files";
import { checkStampHandler } from "@/api/handlers/entities/stamps/check";
import { toSafeId } from "@/api/lib/branded-types";
import {
  asDesktopEditableFileContent,
  asDocxFieldContent,
} from "@/api/lib/entity-versions/desktop-edit-session-utils";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { scanUploadForHandler } from "@/api/lib/file-scan/scan-upload-handler";
import {
  detectFileEncryption,
  ENCRYPTED_CONTENT_MESSAGE,
  uploadFileEncryption,
} from "@/api/lib/files/detect-file-encryption";
import {
  allocateFileObject,
  fileContentWithMintedObject,
} from "@/api/lib/files/file-object-ids";
import { shouldGeneratePdfDerivative } from "@/api/lib/files/pdf-derivative-policy";
import { requiresDurableNativeExtraction } from "@/api/lib/search/process-extraction";
import { isAISupportedFile } from "@/api/lib/workflow/ai-file-support";
import {
  DOCX_MIME_TYPE,
  PDF_MIME_TYPE,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { createEncryptedPdf } from "@/api/tests/helpers/signed-pdf";

const officeFixture = async (format: string): Promise<Uint8Array> =>
  new Uint8Array(
    await Bun.file(
      path.join(
        import.meta.dir,
        "__fixtures__",
        `password-protected-${format}.cfb`,
      ),
    ).arrayBuffer(),
  );

const CASES = [
  {
    label: "pdf",
    mimeType: PDF_MIME_TYPE,
    bytes: async () => new Uint8Array(await createEncryptedPdf()),
  },
  {
    label: "docx",
    mimeType: DOCX_MIME_TYPE,
    bytes: async () => await officeFixture("docx"),
  },
  {
    label: "xlsx",
    mimeType: XLSX_MIME_TYPE,
    bytes: async () => await officeFixture("xlsx"),
  },
  {
    label: "pptx",
    mimeType: PPTX_MIME_TYPE,
    bytes: async () => await officeFixture("pptx"),
  },
] as const;

/** What the upload path and the attribute's consumers make of one file. */
const encryptedHandling = async ({
  label,
  mimeType,
  bytes,
}: (typeof CASES)[number]) => {
  const scanned = await scanUploadForHandler({
    bytes: await bytes(),
    declaredMimeType: mimeType,
    fileName: `locked.${label}`,
  });
  if (!Result.isOk(scanned)) {
    return { accepted: false as const, status: scanned.error.status };
  }
  const encryption = uploadFileEncryption(
    await detectFileEncryption({ mimeType, scanned: scanned.value }),
    { mimeType },
  );
  if (encryption === null) {
    return { accepted: false as const, status: 422 };
  }
  const content = fileContentWithMintedObject({
    encryption,
    fileName: `locked.${label}`,
    id: allocateFileObject(),
    mimeType,
    pdfFileId: null,
    sha256Hex: "a".repeat(64),
    sizeBytes: 1,
    type: "file",
    version: 1,
  });
  return {
    accepted: true as const,
    encrypted: content.encrypted,
    pdfDerivative: shouldGeneratePdfDerivative(content),
    durableExtraction: requiresDurableNativeExtraction(content),
    aiSupported: isAISupportedFile({
      encrypted: content.encrypted,
      fileFieldId: toSafeId<"field">("019864b8-48d0-7f37-94d5-948e3bcf3f44"),
      fileId: content.id,
      mimeType,
      pdfFileId: null,
      sha256Hex: content.sha256Hex,
    }),
    desktopEditable: asDesktopEditableFileContent(content) !== null,
    folioEditable: asDocxFieldContent(content) !== null,
  };
};

describe("encrypted Office uploads", () => {
  test("are handled exactly like an encrypted PDF", async () => {
    const outcomes = await Promise.all(
      CASES.map(async (entry) => [entry.label, await encryptedHandling(entry)]),
    );

    const expected = {
      accepted: true,
      encrypted: true,
      pdfDerivative: false,
      durableExtraction: false,
      aiSupported: false,
      desktopEditable: false,
      folioEditable: false,
    };
    expect(Object.fromEntries(outcomes)).toEqual({
      pdf: expected,
      docx: expected,
      xlsx: expected,
      pptx: expected,
    });
  });
});

describe("encrypted files on raw-byte paths", () => {
  test("a chat attachment is refused as encrypted content, PDF or Office", async () => {
    const fake = startFakeS3();
    try {
      const outcomes: Record<string, unknown> = {};
      for (const entry of CASES) {
        const result = await uploadUserFile({
          dependencies: {
            reserveChatObjectCleanupIntent: async () =>
              await Promise.resolve(Result.ok([])),
          },
          file: {
            bytes: await entry.bytes(),
            fileName: `locked.${entry.label}`,
            mimeType: entry.mimeType,
          },
          recordAuditEvent: async () => await Promise.resolve(),
          safeDb: async () =>
            await Promise.resolve(
              panic("an encrypted attachment must not reach the database"),
            ),
          threadId: toSafeId<"chatThread">(
            "11111111-1111-4111-8111-111111111112",
          ),
          userId: toSafeId<"user">("11111111-1111-4111-8111-111111111113"),
          workspaceId: null,
        });
        outcomes[entry.label] = Result.isError(result)
          ? {
              status: HandlerError.is(result.error)
                ? result.error.status
                : result.error._tag,
              code: HandlerError.is(result.error)
                ? result.error.code
                : undefined,
              message: result.error.message,
            }
          : { status: "stored" };
      }

      const refused = {
        status: 422,
        code: ENCRYPTED_CONTENT_ERROR_CODE,
        message: ENCRYPTED_CONTENT_MESSAGE,
      };
      expect(outcomes).toEqual({
        pdf: refused,
        docx: refused,
        xlsx: refused,
        // Chat never takes presentations, encrypted or not.
        pptx: { status: 422, message: "Unsupported file type" },
      });
      expect(fake.requests).toEqual([]);
    } finally {
      fake.stop();
    }
  });

  test("the stamp check finds no reference in any encrypted file", async () => {
    const outcomes: Record<string, unknown> = {};
    for (const entry of CASES) {
      const bytes = await entry.bytes();
      const result = await Result.gen(async function* () {
        return yield* checkStampHandler({
          body: {
            file: new File([bytes], `locked.${entry.label}`, {
              type: entry.mimeType,
            }),
          },
          organizationId: toSafeId<"organization">("org_1"),
          safeDb: async () =>
            await Promise.resolve(
              panic("an encrypted file carries no reference to look up"),
            ),
        });
      });
      outcomes[entry.label] = result.unwrap();
    }

    expect(outcomes).toEqual({
      pdf: { match: null },
      docx: { match: null },
      xlsx: { match: null },
      pptx: { match: null },
    });
  });
});
