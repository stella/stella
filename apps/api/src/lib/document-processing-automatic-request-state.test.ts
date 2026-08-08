import { describe, expect, test } from "bun:test";

import { shouldRequeueOcrRunAfterProjectionLoss } from "@/api/lib/document-processing-automatic-request-state";

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

describe("shouldRequeueOcrRunAfterProjectionLoss", () => {
  test("requeues succeeded OCR when rollback removed its projection", () => {
    expect(
      shouldRequeueOcrRunAfterProjectionLoss({ projection: null, run, source }),
    ).toBe(true);
    expect(
      shouldRequeueOcrRunAfterProjectionLoss({
        projection: null,
        run: { ...run, requestSource: "upload" },
        source,
      }),
    ).toBe(true);
    expect(
      shouldRequeueOcrRunAfterProjectionLoss({
        projection: { ...projection, ocrRunId: null },
        run,
        source,
      }),
    ).toBe(true);
  });

  test("keeps a succeeded run whose OCR projection is intact", () => {
    expect(
      shouldRequeueOcrRunAfterProjectionLoss({ projection, run, source }),
    ).toBe(false);
  });

  test("does not retry non-succeeded runs", () => {
    expect(
      shouldRequeueOcrRunAfterProjectionLoss({
        projection: null,
        run: { ...run, status: "queued" },
        source,
      }),
    ).toBe(false);
  });
});
