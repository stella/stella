import { expect, test } from "bun:test";

test("leaves automatic OCR delivery to the configured batch scheduler", async () => {
  const source = await Bun.file(
    new URL("document-processing-automatic-request.ts", import.meta.url),
  ).text();

  expect(source).not.toContain("enqueueDocumentProcessingRun");
  expect(source).not.toContain("automatic-document-ocr.enqueue");
  expect(source).toContain("configured batch scheduler releases");
});
