import { expect, test } from "bun:test";

test("leaves automatic OCR delivery to the configured batch scheduler", async () => {
  const source = await Bun.file(
    new URL("document-processing-automatic-request.ts", import.meta.url),
  ).text();

  expect(source).not.toContain("enqueueDocumentProcessingRun");
  expect(source).not.toContain("automatic-document-ocr.enqueue");
  expect(source).toContain("configured batch scheduler releases");
});

test("validates PDF sources through the shared MIME resolver", async () => {
  const source = await Bun.file(
    new URL("document-processing-automatic-request.ts", import.meta.url),
  ).text();

  expect(source).toContain("resolveExtractionMimeType({");
  expect(source).not.toContain("content.mimeType !== PDF_MIME_TYPE");
});
