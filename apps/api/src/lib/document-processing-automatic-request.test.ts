import { expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";

import { enqueueAutomaticDocumentOcrRun } from "./document-processing-automatic-request";

test("bounds and captures a stalled automatic OCR enqueue", async () => {
  const captureEnqueueError = mock(() => undefined);
  const enqueue = mock(async () => {
    await Bun.sleep(50);
  });
  const runId = toSafeId<"documentProcessingRun">("run_test");

  await enqueueAutomaticDocumentOcrRun({
    captureEnqueueError,
    enqueue,
    runId,
    timeoutMs: 5,
  });

  expect(enqueue).toHaveBeenCalledWith(runId);
  expect(captureEnqueueError).toHaveBeenCalledWith(expect.any(TimeoutError), {
    runId,
  });
});

test("keeps the post-commit enqueue detached from upload completion", async () => {
  const source = await Bun.file(
    new URL("document-processing-automatic-request.ts", import.meta.url),
  ).text();

  expect(source).toContain(
    "detached(\n      enqueueAutomaticDocumentOcrRun({ runId: run.id })",
  );
});
