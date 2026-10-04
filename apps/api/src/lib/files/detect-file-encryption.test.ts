import { PDF } from "@libpdf/core";
import { describe, expect, mock, test } from "bun:test";

import {
  SUBPROCESS_TERMINATION_REASON,
  SubprocessError,
} from "@/api/lib/errors/tagged-errors";
import {
  detectFileEncryption,
  officeFileEncryption,
  retainedFileEncryption,
  serverBuiltFileEncryption,
  storedFileEncryption,
  uploadFileEncryption,
} from "@/api/lib/files/detect-file-encryption";
import {
  allocateFileObject,
  fileContentWithMintedObject,
} from "@/api/lib/files/file-object-ids";
import {
  classifyPdfWorkerFailure,
  isEncryptedPdf,
  PDF_WORKER_PARSE_ERROR_EXIT_CODE,
} from "@/api/lib/files/pdf-utils";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";
import { createEncryptedPdf } from "@/api/tests/helpers/signed-pdf";

const pdfFile = (bytes: Uint8Array) =>
  testScannedFile({
    bytes: new Uint8Array(bytes).slice().buffer,
    mimeType: PDF_MIME_TYPE,
  });

const plainPdf = async (): Promise<Uint8Array> => {
  const pdf = PDF.create();
  pdf.addPage();
  return await pdf.save();
};

describe("detectFileEncryption", () => {
  test("records an encrypted PDF as encrypted", async () => {
    const detection = await detectFileEncryption({
      mimeType: PDF_MIME_TYPE,
      scanned: pdfFile(await createEncryptedPdf()),
    });

    expect(detection.status).toBe("known");
    expect(detection.encryption.encrypted).toBe(true);
    expect(detection.encryption.basis).toBe("inspected");
  });

  test("records an unencrypted PDF as unencrypted", async () => {
    const detection = await detectFileEncryption({
      mimeType: PDF_MIME_TYPE,
      scanned: pdfFile(await plainPdf()),
    });

    expect(detection.status).toBe("known");
    expect(detection.encryption.encrypted).toBe(false);
  });

  test("reports bytes the PDF parser refuses as unreadable", async () => {
    const detection = await detectFileEncryption({
      mimeType: PDF_MIME_TYPE,
      scanned: pdfFile(new TextEncoder().encode("not a pdf")),
    });

    expect(detection.status).toBe("unreadable");
  });

  test("does not inspect types other than PDF and OOXML", async () => {
    const probe = mock(isEncryptedPdf);
    const detection = await detectFileEncryption({
      mimeType: "text/plain",
      scanned: pdfFile(await createEncryptedPdf()),
      probe,
    });

    expect(probe).not.toHaveBeenCalled();
    expect(detection.status).toBe("known");
    expect(detection.encryption.basis).toBe("type-not-inspected");
  });

  test("never sends an Office file to the PDF worker", async () => {
    const probe = mock(isEncryptedPdf);
    const detection = await detectFileEncryption({
      mimeType: DOCX_MIME_TYPE,
      scanned: pdfFile(await createEncryptedPdf()),
      probe,
    });

    expect(probe).not.toHaveBeenCalled();
    expect(detection.status).toBe("known");
    expect(detection.encryption.encrypted).toBe(false);
    expect(detection.encryption.basis).toBe("inspected");
  });

  test("an inspection the timeout cuts short is unsure, not corrupted", async () => {
    const detection = await detectFileEncryption({
      mimeType: PDF_MIME_TYPE,
      scanned: pdfFile(await createEncryptedPdf()),
      probe: async (file) => await isEncryptedPdf(file, { timeoutMs: 1 }),
    });

    expect(detection.status).toBe("unsure");
    if (detection.status !== "unsure") {
      return;
    }
    expect(detection.encryption.encrypted).toBe(false);
    expect(detection.encryption.basis).toBe("unsure");
    expect(detection.cause).toMatchObject({
      exitCode: null,
      termination: { reason: SUBPROCESS_TERMINATION_REASON.timeout },
    });
  });
});

describe("uploadFileEncryption", () => {
  test("keeps an unsure upload and refuses an unreadable one", async () => {
    const scanned = pdfFile(await plainPdf());
    const unsure = await detectFileEncryption({
      mimeType: PDF_MIME_TYPE,
      scanned,
      probe: async () => ({ status: "unsure", cause: "worker killed" }),
    });
    const unreadable = await detectFileEncryption({
      mimeType: PDF_MIME_TYPE,
      scanned: pdfFile(new TextEncoder().encode("not a pdf")),
    });

    const analytics = installRecordingAnalytics();
    try {
      expect(
        uploadFileEncryption(unsure, { mimeType: PDF_MIME_TYPE })?.encrypted,
      ).toBe(false);
      expect(
        uploadFileEncryption(unreadable, { mimeType: PDF_MIME_TYPE }),
      ).toBeNull();
      // Both are reported; the unsure one is told apart by its stage.
      expect(
        analytics.exceptions().map((event) => event.properties),
      ).toMatchObject([
        { mimeType: PDF_MIME_TYPE, stage: "file-encryption-unsure" },
        { mimeType: PDF_MIME_TYPE },
      ]);
    } finally {
      analytics.restore();
    }
  });
});

describe("PDF worker exits", () => {
  const exit = (exitCode: number | null) =>
    new SubprocessError({ message: "worker", exitCode, termination: null });

  test("only the parse-error exit makes a PDF unreadable", () => {
    expect(
      classifyPdfWorkerFailure(exit(PDF_WORKER_PARSE_ERROR_EXIT_CODE)).status,
    ).toBe("unreadable");
    // Bun exits 1 when the worker or one of its imports fails to load.
    expect(classifyPdfWorkerFailure(exit(1)).status).toBe("unsure");
    expect(classifyPdfWorkerFailure(exit(null)).status).toBe("unsure");
  });
});

describe("retainedFileEncryption", () => {
  test("keeps the file on every outcome and reports the failed ones", async () => {
    const unsure = await detectFileEncryption({
      mimeType: PDF_MIME_TYPE,
      scanned: pdfFile(await plainPdf()),
      probe: async () => ({ status: "unsure", cause: "worker killed" }),
    });
    const unreadable = await detectFileEncryption({
      mimeType: PDF_MIME_TYPE,
      scanned: pdfFile(new TextEncoder().encode("not a pdf")),
    });
    const known = await detectFileEncryption({
      mimeType: PDF_MIME_TYPE,
      scanned: pdfFile(await createEncryptedPdf()),
    });

    const analytics = installRecordingAnalytics();
    try {
      const context = { mimeType: PDF_MIME_TYPE };
      expect(retainedFileEncryption(unsure, context).encrypted).toBe(false);
      expect(retainedFileEncryption(unreadable, context).encrypted).toBe(false);
      expect(retainedFileEncryption(known, context).encrypted).toBe(true);
      expect(
        analytics.exceptions().map((event) => event.properties),
      ).toMatchObject([
        { mimeType: PDF_MIME_TYPE, stage: "file-encryption-unsure" },
        { mimeType: PDF_MIME_TYPE },
      ]);
    } finally {
      analytics.restore();
    }
  });
});

describe("file content writers", () => {
  const content = (encryption: ReturnType<typeof serverBuiltFileEncryption>) =>
    fileContentWithMintedObject({
      encryption,
      fileName: "a.pdf",
      id: allocateFileObject(),
      mimeType: PDF_MIME_TYPE,
      pdfFileId: null,
      sha256Hex: "a".repeat(64),
      sizeBytes: 1,
      type: "file",
      version: 1,
    });

  test("minted content records the detector's value", async () => {
    const detection = await detectFileEncryption({
      mimeType: PDF_MIME_TYPE,
      scanned: pdfFile(await createEncryptedPdf()),
    });

    expect(content(detection.encryption).encrypted).toBe(true);
    expect(content(serverBuiltFileEncryption()).encrypted).toBe(false);
    expect(content(officeFileEncryption(DOCX_MIME_TYPE)).encrypted).toBe(false);
  });

  test("a copy carries the stored value", () => {
    expect(content(storedFileEncryption({ encrypted: true })).encrypted).toBe(
      true,
    );
    expect(content(storedFileEncryption({ encrypted: false })).encrypted).toBe(
      false,
    );
  });
});
