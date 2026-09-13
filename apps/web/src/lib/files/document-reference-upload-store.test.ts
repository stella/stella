import { describe, expect, test } from "bun:test";

import {
  closeDocumentReferenceUploadPrompt,
  currentDocumentReferenceUploadPrompt,
  enqueueDocumentReferenceUploadPrompt,
} from "@/lib/files/document-reference-upload-store";
import type {
  DocumentReferenceUploadPrompt,
  DocumentReferenceUploadQueue,
} from "@/lib/files/document-reference-upload-store";

const prompt = (): DocumentReferenceUploadPrompt => ({
  referenced: [],
  onResolved: () => undefined,
  onCancelled: () => undefined,
});

const emptyQueue = (): DocumentReferenceUploadQueue => ({
  prompts: [],
  nextPromptId: 1,
});

describe("document reference upload prompt queue", () => {
  test("serves concurrent prompts in FIFO order", () => {
    const first = prompt();
    const second = prompt();
    const withFirst = enqueueDocumentReferenceUploadPrompt(emptyQueue(), first);
    const withBoth = enqueueDocumentReferenceUploadPrompt(withFirst, second);

    expect(currentDocumentReferenceUploadPrompt(withBoth)?.prompt).toBe(first);

    const afterFirst = closeDocumentReferenceUploadPrompt(withBoth, 1);
    expect(currentDocumentReferenceUploadPrompt(afterFirst)?.prompt).toBe(
      second,
    );
  });

  test("a stale completion cannot close the next prompt", () => {
    const withFirst = enqueueDocumentReferenceUploadPrompt(
      emptyQueue(),
      prompt(),
    );
    const withBoth = enqueueDocumentReferenceUploadPrompt(withFirst, prompt());
    const afterFirst = closeDocumentReferenceUploadPrompt(withBoth, 1);
    const afterStaleClose = closeDocumentReferenceUploadPrompt(afterFirst, 1);

    expect(afterStaleClose).toBe(afterFirst);
    expect(currentDocumentReferenceUploadPrompt(afterStaleClose)?.id).toBe(2);
  });
});
