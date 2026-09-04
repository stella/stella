import { PDFiumLibrary } from "@hyzyla/pdfium";
import { PDF, rgb } from "@libpdf/core";
import { expect, test } from "bun:test";

import { inspectPdf } from "@stll/anonymize-pdf";

import { buildOcrPage } from "@/api/lib/document-processing-ocr-result";
import {
  decodePdfAnonymizationWorkerResponse,
  encodePdfAnonymizationWorkerRequest,
} from "@/api/lib/pdf-anonymization/worker-protocol";
import { spawnBinaryWorker } from "@/api/lib/subprocess";

test("deep PDF rewrite removes source metadata and text, burns redactions into pixels, and preserves other pixels", async () => {
  const fixture = await Bun.file(
    new URL("../search/__fixtures__/image-only.pdf", import.meta.url),
  ).bytes();
  const source = await PDF.load(fixture);
  source.setAuthor("Private author fixture");
  source.setTitle("Private title fixture");
  const sourcePage = source.getPages().at(0);
  expect(sourcePage).toBeDefined();
  if (!sourcePage) {
    return;
  }
  sourcePage.drawRectangle({
    x: 40,
    y: 40,
    width: 120,
    height: 40,
    color: rgb(1, 0, 0),
  });
  sourcePage.drawText("Private name fixture", { x: 40, y: 60, size: 10 });
  sourcePage.drawRectangle({
    x: 200,
    y: 40,
    width: 30,
    height: 30,
    color: rgb(0, 0, 1),
  });
  const sourceBytes = await source.save();
  const sourceSnapshot = sourceBytes.slice();
  expect(inspectPdf(sourceBytes).risks.documentInfoEntryCount).toBeGreaterThan(
    0,
  );

  const encoded = encodePdfAnonymizationWorkerRequest({
    document: sourceBytes,
    pages: source.getPages().map((page, index) => ({
      ocr: {
        width: page.width,
        height: page.height,
        lines:
          index === 0
            ? [
                {
                  text: "Private name fixture",
                  confidence: 1,
                  box: [35, page.height - 85, 180, page.height - 35],
                },
              ]
            : [],
      },
      detections: index === 0 ? [{ start: 0, end: 20 }] : [],
    })),
  });
  if (encoded.isErr()) {
    throw encoded.error;
  }
  const result = await spawnBinaryWorker({
    workerPath: new URL("pdf-anonymization-worker.ts", import.meta.url)
      .pathname,
    stdin: new Blob([encoded.value.slice().buffer]),
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024 * 1024,
  });
  if (result.isErr()) {
    throw result.error;
  }
  const decoded = decodePdfAnonymizationWorkerResponse(result.value);
  if (decoded.isErr()) {
    throw decoded.error;
  }
  const output = decoded.value;
  expect(sourceBytes).toEqual(sourceSnapshot);
  expect(output.certificate).toMatchObject({
    sourceSha256: new Bun.CryptoHasher("sha256")
      .update(sourceBytes)
      .digest("hex"),
    outputSha256: new Bun.CryptoHasher("sha256")
      .update(output.document)
      .digest("hex"),
    pageCount: source.getPages().length,
    detectionCount: 1,
    mappedRegionCount: 1,
    structurePixelRewriteVerified: true,
    piiCleanGuaranteed: false,
  });
  const inspection = inspectPdf(output.document);
  for (const [risk, count] of Object.entries(inspection.risks)) {
    if (risk !== "imageObjectCount") {
      expect(count, risk).toBe(0);
    }
  }
  expect(inspection.risks.imageObjectCount).toBe(source.getPages().length);

  const library = await PDFiumLibrary.init();
  try {
    const before = await library.loadDocument(Buffer.from(sourceBytes));
    const after = await library.loadDocument(Buffer.from(output.document));
    try {
      expect(before.getPage(0).getText()).toContain("Private name fixture");
      for (let index = 0; index < after.getPageCount(); index++) {
        expect(after.getPage(index).getText()).toBe("");
      }
      const beforeRender = await before.getPage(0).render({ scale: 1 });
      const afterRender = await after.getPage(0).render({ scale: 1 });
      expect(afterRender.width).toBe(beforeRender.width);
      expect(afterRender.height).toBe(beforeRender.height);
      const redactedOffset =
        ((beforeRender.height - 50) * beforeRender.width + 50) * 4;
      const retainedOffset =
        ((beforeRender.height - 50) * beforeRender.width + 210) * 4;
      expect([
        ...beforeRender.data.subarray(redactedOffset, redactedOffset + 3),
      ]).toEqual([255, 0, 0]);
      expect([
        ...afterRender.data.subarray(redactedOffset, redactedOffset + 3),
      ]).toEqual([0, 0, 0]);
      expect([
        ...afterRender.data.subarray(retainedOffset, retainedOffset + 3),
      ]).toEqual([0, 0, 255]);
    } finally {
      before.destroy();
      after.destroy();
    }
  } finally {
    library.destroy();
  }
}, 30_000);

test.each([0.2, 0.49, 0.51, 0.8])(
  "rewrites fractional page geometry with rounded OCR dimensions (%s)",
  async (fraction) => {
    const source = PDF.create();
    source.addPage({ width: 72 + fraction, height: 96 + fraction });
    const document = await source.save();
    const library = await PDFiumLibrary.init();
    const loaded = await library.loadDocument(Buffer.from(document));
    const { originalWidth, originalHeight } = loaded
      .getPage(0)
      .getOriginalSize();
    loaded.destroy();
    library.destroy();
    const ocr = buildOcrPage({
      lines: [],
      pointWidth: originalWidth,
      pointHeight: originalHeight,
    });
    expect(ocr.width).not.toBe(originalWidth);
    const request = encodePdfAnonymizationWorkerRequest({
      document,
      pages: [{ ocr, detections: [] }],
    });
    if (request.isErr()) {
      throw request.error;
    }
    const result = await spawnBinaryWorker({
      workerPath: new URL("pdf-anonymization-worker.ts", import.meta.url)
        .pathname,
      stdin: new Blob([request.value.slice().buffer]),
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024 * 1024,
    });
    if (result.isErr()) {
      throw result.error;
    }
    const decoded = decodePdfAnonymizationWorkerResponse(result.value);
    if (decoded.isErr()) {
      throw decoded.error;
    }
    expect(decoded.value.certificate.structurePixelRewriteVerified).toBe(true);
    const rewritten = await PDF.load(decoded.value.document);
    const page = rewritten.getPages().at(0);
    expect(page?.width).toBeCloseTo(originalWidth, 4);
    expect(page?.height).toBeCloseTo(originalHeight, 4);
  },
  30_000,
);
