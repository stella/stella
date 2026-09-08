import { create } from "zustand";

import type { ReferencedFile } from "@/lib/document-reference-queries";

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

type DocumentReferenceUploadState = {
  readonly prompt: DocumentReferenceUploadPrompt | null;
  /** Rises with every question asked, so the dialog remounts per batch. */
  readonly promptId: number;
  readonly ask: (prompt: DocumentReferenceUploadPrompt) => void;
  readonly close: () => void;
};

export const useDocumentReferenceUploadStore =
  create<DocumentReferenceUploadState>((set) => ({
    prompt: null,
    promptId: 0,
    ask: (prompt) => set((state) => ({ prompt, promptId: state.promptId + 1 })),
    close: () => set({ prompt: null }),
  }));
