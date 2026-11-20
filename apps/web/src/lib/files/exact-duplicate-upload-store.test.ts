import { describe, expect, test } from "bun:test";

import {
  closeExactDuplicateUploadPrompt,
  currentExactDuplicateUploadPrompt,
  enqueueExactDuplicateUploadPrompt,
} from "@/lib/files/exact-duplicate-upload-store";
import type {
  ExactDuplicateUploadPrompt,
  ExactDuplicateUploadQueue,
} from "@/lib/files/exact-duplicate-upload-store";

const prompt = (): ExactDuplicateUploadPrompt => ({
  duplicates: [],
  onResolved: () => undefined,
});

const emptyQueue = (): ExactDuplicateUploadQueue => ({
  prompts: [],
  nextPromptId: 1,
});

describe("exact duplicate upload prompt queue", () => {
  test("serves concurrent prompts in FIFO order", () => {
    const first = prompt();
    const second = prompt();
    const withBoth = enqueueExactDuplicateUploadPrompt(
      enqueueExactDuplicateUploadPrompt(emptyQueue(), first),
      second,
    );

    expect(currentExactDuplicateUploadPrompt(withBoth)?.prompt).toBe(first);

    const afterFirst = closeExactDuplicateUploadPrompt(withBoth, 1);
    expect(currentExactDuplicateUploadPrompt(afterFirst)?.prompt).toBe(second);

    const afterSecond = closeExactDuplicateUploadPrompt(afterFirst, 2);
    expect(currentExactDuplicateUploadPrompt(afterSecond)).toBeNull();
  });

  test("a stale close cannot close the next prompt", () => {
    const withBoth = enqueueExactDuplicateUploadPrompt(
      enqueueExactDuplicateUploadPrompt(emptyQueue(), prompt()),
      prompt(),
    );
    const afterFirst = closeExactDuplicateUploadPrompt(withBoth, 1);
    const afterStaleClose = closeExactDuplicateUploadPrompt(afterFirst, 1);

    expect(afterStaleClose).toBe(afterFirst);
    expect(currentExactDuplicateUploadPrompt(afterStaleClose)?.id).toBe(2);
  });
});
