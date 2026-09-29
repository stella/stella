import { useState } from "react";

import type { DocxComments } from "@/components/docx/app-docx-editor";
import { useLatestCallback } from "@/hooks/use-latest-callback";

/**
 * Controlled `DocxEditor` comment state, round-tripped back through
 * `onCommentsChange`. Feeds the file-chat overlay's folio-agents comment
 * tools (read/add/reply/resolve) via `FileViewerWithAI`, and lets those
 * mutations (reply / resolve) flow back into the editor.
 *
 * `onChange` runs for every comment change that is not the editor's initial
 * sync of a freshly loaded document.
 */
export const useDocxComments = (onChange: () => void) => {
  const [docxComments, setDocxComments] = useState<DocxComments>([]);
  const [docxCommentsDocId, setDocxCommentsDocId] = useState<string | null>(
    null,
  );
  const [
    pendingInitialDocxCommentsSyncDocId,
    setPendingInitialDocxCommentsSyncDocId,
  ] = useState<string | null>(null);

  // Folio may publish controlled comments after reparsing the same semantic
  // list. Stable callbacks plus equivalent-write suppression prevent a child
  // notification from becoming a parent/child render feedback loop.
  const handleAiDocxCommentsChange = useLatestCallback(
    (comments: DocxComments) => {
      const commentsChanged =
        JSON.stringify(docxComments) !== JSON.stringify(comments);
      setPendingInitialDocxCommentsSyncDocId(null);
      if (!commentsChanged) {
        return;
      }

      setDocxComments(comments);
      onChange();
    },
  );

  const handleEditorDocxCommentsChange = useLatestCallback(
    (comments: DocxComments) => {
      const isInitialEditorSync = pendingInitialDocxCommentsSyncDocId !== null;
      const commentsChanged =
        JSON.stringify(docxComments) !== JSON.stringify(comments);
      setPendingInitialDocxCommentsSyncDocId(null);
      if (!commentsChanged) {
        return;
      }

      setDocxComments(comments);
      if (!isInitialEditorSync) {
        onChange();
      }
    },
  );

  // Reset the controlled comment state when the loaded document changes.
  // Called during render (adjust-state-during-render, not an effect) so the
  // freshly-keyed DocxEditor never mounts with the previous file's comments;
  // the new editor re-emits its own parsed comments through
  // `onCommentsChange` on mount.
  const resetCommentsForDocument = (documentId: string) => {
    if (docxCommentsDocId === documentId) {
      return;
    }
    setDocxCommentsDocId(documentId);
    setDocxComments([]);
    setPendingInitialDocxCommentsSyncDocId(documentId);
  };

  return {
    docxComments,
    handleAiDocxCommentsChange,
    handleEditorDocxCommentsChange,
    resetCommentsForDocument,
  };
};
