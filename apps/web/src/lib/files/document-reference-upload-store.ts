import { create } from "zustand";

import type { ReferencedFile } from "@/lib/files/document-reference-queries";

/**
 * A batch of files, some of which turned out to be versions of documents
 * already in this organization, waiting on the user's per-file decision.
 *
 * Lifted into a store so the single owner of "files go into a matter"
 * (`useCreateFileEntities`) can raise the question from any of its call sites
 * — the command palette, the empty state, a drop on the table — while the
 * dialog itself stays mounted once at the protected-layout level.
 */
export type DocumentReferenceUploadPrompt = {
  /** Files whose reference resolved to a document already in stella. */
  referenced: readonly ReferencedFile[];
  /**
   * Continue the upload with the files the user chose to file as new
   * documents. The versions have already been sent by then.
   */
  onResolved: (newDocumentFiles: readonly File[]) => void;
  /** The user backed out; nothing uploads. */
  onCancelled: () => void;
};

export type QueuedDocumentReferenceUploadPrompt = {
  readonly id: number;
  readonly prompt: DocumentReferenceUploadPrompt;
};

export type DocumentReferenceUploadQueue = {
  readonly prompts: readonly QueuedDocumentReferenceUploadPrompt[];
  readonly nextPromptId: number;
};

export const enqueueDocumentReferenceUploadPrompt = (
  queue: DocumentReferenceUploadQueue,
  prompt: DocumentReferenceUploadPrompt,
): DocumentReferenceUploadQueue => ({
  prompts: [...queue.prompts, { id: queue.nextPromptId, prompt }],
  nextPromptId: queue.nextPromptId + 1,
});

export const closeDocumentReferenceUploadPrompt = (
  queue: DocumentReferenceUploadQueue,
  promptId: number,
): DocumentReferenceUploadQueue => {
  if (queue.prompts.at(0)?.id !== promptId) {
    return queue;
  }
  return { prompts: queue.prompts.slice(1), nextPromptId: queue.nextPromptId };
};

export const currentDocumentReferenceUploadPrompt = (
  queue: DocumentReferenceUploadQueue,
): QueuedDocumentReferenceUploadPrompt | null => queue.prompts.at(0) ?? null;

type DocumentReferenceUploadState = DocumentReferenceUploadQueue & {
  readonly ask: (prompt: DocumentReferenceUploadPrompt) => void;
  readonly close: (promptId: number) => void;
};

export const useDocumentReferenceUploadStore =
  create<DocumentReferenceUploadState>((set) => ({
    prompts: [],
    nextPromptId: 1,
    ask: (prompt) =>
      set((state) => enqueueDocumentReferenceUploadPrompt(state, prompt)),
    close: (promptId) =>
      set((state) => closeDocumentReferenceUploadPrompt(state, promptId)),
  }));
