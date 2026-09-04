import { describe, expect, test } from "bun:test";

import {
  decodePdfAnonymizationWorkerRequest,
  decodePdfAnonymizationWorkerResponse,
  encodePdfAnonymizationWorkerRequest,
  encodePdfAnonymizationWorkerResponse,
} from "@/api/lib/pdf-anonymization/worker-protocol";
import type { PdfAnonymizationObservedPage } from "@/api/lib/pdf-anonymization/worker-protocol";

const certificate = {
  contractVersion: 1,
  pageCount: 1,
  sourceSha256: "a".repeat(64),
  outputSha256: "b".repeat(64),
  provider: {
    providerId: "stella-pdfium-ppocr-local",
    rendererName: "PDFium",
    rendererVersion: "2.1.13",
    ocrName: "PP-OCRv5 mobile Latin",
    ocrVersion: "3",
    ocrLanguage: "latin",
  },
  detectionCount: 1,
  mappedRegionCount: 1,
  structurePixelRewriteVerified: true,
  providerAssertedCoverage: "complete-rendering-and-ocr-observation",
  piiCleanGuaranteed: false,
  limitation: "Review is required.",
} as const;

describe("PDF anonymization worker framing", () => {
  test("round-trips OCR pages, detections, source bytes, and certificate", () => {
    const document = new Uint8Array([1, 2, 3, 4]);
    const pages: PdfAnonymizationObservedPage[] = [
      {
        detections: [{ start: 0, end: 3 }],
        ocr: {
          width: 612,
          height: 792,
          lines: [{ box: [10, 20, 80, 40], confidence: 0.9, text: "Jan" }],
        },
      },
    ];

    expect(
      decodePdfAnonymizationWorkerRequest(
        encodePdfAnonymizationWorkerRequest({ document, pages }),
      ),
    ).toEqual({ document, pages });
    expect(
      decodePdfAnonymizationWorkerResponse(
        encodePdfAnonymizationWorkerResponse({ certificate, document }),
      ),
    ).toEqual({ certificate, document });
  });

  test("rejects truncated and malformed frames", () => {
    expect(() =>
      decodePdfAnonymizationWorkerRequest(new Uint8Array([0, 0, 0])),
    ).toThrow("frame is truncated");

    const malformed = new Uint8Array([0, 0, 0, 2, 123, 125, 1]);
    expect(() => decodePdfAnonymizationWorkerRequest(malformed)).toThrow(
      "request is invalid",
    );
  });
});
