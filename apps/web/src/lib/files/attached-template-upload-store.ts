import { create } from "zustand";

import type { PreparedAttachedTemplateFile } from "@/lib/files/attached-template-upload";

export type AttachedTemplateUploadPrompt = {
  files: readonly PreparedAttachedTemplateFile[];
  onApproved: () => void;
  onCancelled: () => void;
};

export type QueuedAttachedTemplateUploadPrompt = {
  readonly id: number;
  readonly prompt: AttachedTemplateUploadPrompt;
};

export type AttachedTemplateUploadQueue = {
  readonly prompts: readonly QueuedAttachedTemplateUploadPrompt[];
  readonly nextPromptId: number;
};

export const enqueueAttachedTemplateUploadPrompt = (
  queue: AttachedTemplateUploadQueue,
  prompt: AttachedTemplateUploadPrompt,
): AttachedTemplateUploadQueue => ({
  prompts: [...queue.prompts, { id: queue.nextPromptId, prompt }],
  nextPromptId: queue.nextPromptId + 1,
});

export const closeAttachedTemplateUploadPrompt = (
  queue: AttachedTemplateUploadQueue,
  promptId: number,
): AttachedTemplateUploadQueue => {
  if (queue.prompts.at(0)?.id !== promptId) {
    return queue;
  }
  return { prompts: queue.prompts.slice(1), nextPromptId: queue.nextPromptId };
};

export const currentAttachedTemplateUploadPrompt = (
  queue: AttachedTemplateUploadQueue,
): QueuedAttachedTemplateUploadPrompt | null => queue.prompts.at(0) ?? null;

type AttachedTemplateUploadState = AttachedTemplateUploadQueue & {
  readonly ask: (prompt: AttachedTemplateUploadPrompt) => void;
  readonly close: (promptId: number) => void;
};

export const useAttachedTemplateUploadStore =
  create<AttachedTemplateUploadState>((set) => ({
    prompts: [],
    nextPromptId: 1,
    ask: (prompt) =>
      set((state) => enqueueAttachedTemplateUploadPrompt(state, prompt)),
    close: (promptId) =>
      set((state) => closeAttachedTemplateUploadPrompt(state, promptId)),
  }));

export const requestAttachedTemplateRemoval = async (
  files: readonly PreparedAttachedTemplateFile[],
): Promise<boolean> =>
  await new Promise<boolean>((resolve) => {
    useAttachedTemplateUploadStore.getState().ask({
      files,
      onApproved: () => resolve(true),
      onCancelled: () => resolve(false),
    });
  });
