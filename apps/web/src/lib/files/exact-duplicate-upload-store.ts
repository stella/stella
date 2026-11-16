import { create } from "zustand";

import type { DuplicateFile } from "@/lib/files/exact-duplicate-queries";

/**
 * A batch of files, some byte-identical to documents the matter already
 * holds, waiting on the user's per-file decision. A store for the same reason
 * as the document-reference prompt: one upload owner, many call sites, one
 * mounted dialog.
 */
export type ExactDuplicateUploadPrompt = {
  readonly id: number;
  readonly duplicates: readonly DuplicateFile[];
  /** Continue with the files the user chose to upload anyway. */
  readonly onResolved: (uploadAnywayFiles: readonly File[]) => void;
};

type ExactDuplicateUploadState = {
  readonly prompts: readonly ExactDuplicateUploadPrompt[];
  readonly nextPromptId: number;
  readonly ask: (prompt: Omit<ExactDuplicateUploadPrompt, "id">) => void;
  readonly close: (promptId: number) => void;
};

export const useExactDuplicateUploadStore = create<ExactDuplicateUploadState>(
  (set) => ({
    prompts: [],
    nextPromptId: 1,
    ask: (prompt) =>
      set((state) => ({
        prompts: [...state.prompts, { ...prompt, id: state.nextPromptId }],
        nextPromptId: state.nextPromptId + 1,
      })),
    close: (promptId) =>
      set((state) => ({
        prompts: state.prompts.filter(({ id }) => id !== promptId),
      })),
  }),
);
