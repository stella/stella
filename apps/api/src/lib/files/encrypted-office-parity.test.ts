/**
 * A password-protected Office upload takes the path an encrypted PDF takes:
 * the upload scan accepts it, the detector records it encrypted, and every
 * consumer that reads the attribute answers it the same way.
 */
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import { toSafeId } from "@/api/lib/branded-types";
import {
  asDesktopEditableFileContent,
  asDocxFieldContent,
} from "@/api/lib/entity-versions/desktop-edit-session-utils";
import { scanUploadForHandler } from "@/api/lib/file-scan/scan-upload-handler";
import {
  detectFileEncryption,
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
