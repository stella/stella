import { describe, expect, test } from "bun:test";

import { shouldRequeueAutomaticOcrRun } from "@/api/lib/document-processing-automatic-request-state";

const source = {
  entityVersionId: "version_1",
  fieldId: "field_1",
  sourceFileId: "file_1",
  sourceSha256Hex: "a".repeat(64),
};
const run = {
  id: "run_1",
  requestSource: "upload" as const,
  status: "succeeded" as const,
};
const projection = {
  ocrRunId: run.id,
  sourceEntityVersionId: source.entityVersionId,
  sourceFieldId: source.fieldId,
  sourceFileId: source.sourceFileId,
  sourceSha256Hex: source.sourceSha256Hex,
};

describe("shouldRequeueAutomaticOcrRun", () => {
  test("requeues succeeded automatic OCR when rollback removed its projection", () => {
    expect(
      shouldRequeueAutomaticOcrRun({ projection: null, run, source }),
    ).toBe(true);
    expect(
      shouldRequeueAutomaticOcrRun({
        projection: { ...projection, ocrRunId: null },
        run,
        source,
      }),
    ).toBe(true);
  });

  test("keeps a succeeded automatic run whose OCR projection is intact", () => {
    expect(shouldRequeueAutomaticOcrRun({ projection, run, source })).toBe(
      false,
    );
  });

  test("does not convert manual or non-succeeded runs into automatic retries", () => {
    expect(
      shouldRequeueAutomaticOcrRun({
        projection: null,
        run: { ...run, requestSource: "manual" },
        source,
      }),
    ).toBe(false);
    expect(
      shouldRequeueAutomaticOcrRun({
        projection: null,
        run: { ...run, status: "queued" },
        source,
      }),
    ).toBe(false);
  });
});
