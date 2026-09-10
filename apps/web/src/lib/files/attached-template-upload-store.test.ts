import { describe, expect, test } from "bun:test";

import type { AttachedTemplateUploadPrompt } from "./attached-template-upload-store";
import {
  closeAttachedTemplateUploadPrompt,
  currentAttachedTemplateUploadPrompt,
  enqueueAttachedTemplateUploadPrompt,
} from "./attached-template-upload-store";

const prompt = (): AttachedTemplateUploadPrompt => ({
  files: [],
  onApproved: () => undefined,
  onCancelled: () => undefined,
});

describe("attached-template upload prompt queue", () => {
  test("keeps prompts ordered and only closes the current prompt", () => {
    const empty = { prompts: [], nextPromptId: 1 };
    const first = enqueueAttachedTemplateUploadPrompt(empty, prompt());
    const second = enqueueAttachedTemplateUploadPrompt(first, prompt());

    expect(second.prompts.map(({ id }) => id)).toEqual([1, 2]);
    expect(currentAttachedTemplateUploadPrompt(second)?.id).toBe(1);
    expect(closeAttachedTemplateUploadPrompt(second, 2)).toBe(second);

    const afterFirst = closeAttachedTemplateUploadPrompt(second, 1);
    expect(currentAttachedTemplateUploadPrompt(afterFirst)?.id).toBe(2);
    expect(afterFirst.nextPromptId).toBe(3);
  });
});
