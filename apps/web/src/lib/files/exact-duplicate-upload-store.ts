import { create } from "zustand";

import type { DuplicateFile } from "@/lib/files/exact-duplicate-queries";

/**
 * A batch of files, some byte-identical to documents the matter already
 * holds, waiting on the user's per-file decision. A store for the same reason
 * as the document-reference prompt: one upload owner, many call sites, one
 * mounted dialog.
 */
export type ExactDuplicateUploadPrompt = {
  readonly duplicates: readonly DuplicateFile[];
  /**
   * Continue the batch with the duplicates the user chose to upload anyway;
   * every other duplicate is skipped and the rest of the batch uploads. A
   * dismissed dialog resolves with none, so closing it never costs the files
   * that were not duplicates.
   */
  readonly onResolved: (uploadAnywayFiles: readonly File[]) => void;
};

export type QueuedExactDuplicateUploadPrompt = {
  readonly id: number;
  readonly prompt: ExactDuplicateUploadPrompt;
};

export type ExactDuplicateUploadQueue = {
  readonly prompts: readonly QueuedExactDuplicateUploadPrompt[];
  readonly nextPromptId: number;
};

export const enqueueExactDuplicateUploadPrompt = (
  queue: ExactDuplicateUploadQueue,
  prompt: ExactDuplicateUploadPrompt,
): ExactDuplicateUploadQueue => ({
  prompts: [...queue.prompts, { id: queue.nextPromptId, prompt }],
  nextPromptId: queue.nextPromptId + 1,
});

export const closeExactDuplicateUploadPrompt = (
  queue: ExactDuplicateUploadQueue,
  promptId: number,
): ExactDuplicateUploadQueue => {
  if (queue.prompts.at(0)?.id !== promptId) {
    return queue;
  }
  return { prompts: queue.prompts.slice(1), nextPromptId: queue.nextPromptId };
};

export const currentExactDuplicateUploadPrompt = (
  queue: ExactDuplicateUploadQueue,
): QueuedExactDuplicateUploadPrompt | null => queue.prompts.at(0) ?? null;

type ExactDuplicateUploadState = ExactDuplicateUploadQueue & {
  readonly ask: (prompt: ExactDuplicateUploadPrompt) => void;
  readonly close: (promptId: number) => void;
};

export const useExactDuplicateUploadStore = create<ExactDuplicateUploadState>(
  (set) => ({
    prompts: [],
    nextPromptId: 1,
    ask: (prompt) =>
      set((state) => enqueueExactDuplicateUploadPrompt(state, prompt)),
    close: (promptId) =>
      set((state) => closeExactDuplicateUploadPrompt(state, promptId)),
  }),
);
