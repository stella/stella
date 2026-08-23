import { describe, expect, test } from "bun:test";

import {
  decodePdfInspection,
  decodePdfRasterRewriteCertificate,
} from "../native-codec";
import type { PdfInspection, PdfRasterRewriteCertificate } from "../types";

const inspection = {
  contractVersion: 1,
  pdfVersion: "1.7",
  byteLength: 100,
  objectCount: 2,
  pageCount: 1,
  encrypted: false,
  pages: [
    {
      pageIndex: 0,
      widthPoints: 612,
      heightPoints: 792,
      annotationCount: 0,
      observation: null,
    },
  ],
  risks: {
    acroFormFieldCount: 0,
    annotationCount: 0,
    documentInfoEntryCount: 0,
    embeddedFileCount: 0,
    externalActionCount: 0,
    formXObjectCount: 0,
    imageObjectCount: 0,
    incrementalRevisionCount: 0,
    javascriptActionCount: 0,
    metadataStreamCount: 0,
    optionalContentGroupCount: 0,
    signatureCount: 0,
    trailingNonWhitespaceByteCount: 0,
    unsupportedActionCount: 0,
    xfaEntryCount: 0,
  },
  coverage: { status: "partial", gaps: ["page-content-not-observed"] },
} as const satisfies PdfInspection;

const certificate = {
  contractVersion: 1,
  pageCount: 1,
  sourceSha256: "a".repeat(64),
  outputSha256: "b".repeat(64),
  provider: {
    providerId: "provider",
    rendererName: "renderer",
    rendererVersion: "1",
    ocrName: "ocr",
    ocrVersion: "1",
    ocrLanguage: "eng",
  },
  detectionCount: 1,
  mappedRegionCount: 1,
  structurePixelRewriteVerified: true,
  providerAssertedCoverage: "complete-rendering-and-ocr-observation",
  piiCleanGuaranteed: false,
  limitation: "Detection completeness is caller-owned.",
} as const satisfies PdfRasterRewriteCertificate;

describe("native PDF codecs", () => {
  test("accept their complete versioned contracts", () => {
    expect(decodePdfInspection(JSON.stringify(inspection))).toEqual(inspection);
    expect(
      decodePdfRasterRewriteCertificate(JSON.stringify(certificate)),
    ).toEqual(certificate);
  });

  test("reject unknown, missing, and structurally invalid fields", () => {
    expect(() =>
      decodePdfInspection(JSON.stringify({ ...inspection, extra: true })),
    ).toThrow("does not match contract version 1");
    const { coverage: _coverage, ...missingCoverage } = inspection;
    expect(() => decodePdfInspection(JSON.stringify(missingCoverage))).toThrow(
      "does not match contract version 1",
    );
    expect(() =>
      decodePdfInspection(
        JSON.stringify({
          ...inspection,
          pages: [{ ...inspection.pages[0], pageIndex: 1 }],
        }),
      ),
    ).toThrow("does not match contract version 1");
    expect(() =>
      decodePdfRasterRewriteCertificate(
        JSON.stringify({ ...certificate, outputSha256: "not-a-digest" }),
      ),
    ).toThrow("does not match contract version 1");
  });
});
