import type { RefObject } from "react";

import { registerCreateDocumentDraftSaver } from "@/components/chat/create-document-draft-runtime";
import type { DocxEditorRef } from "@/components/docx/app-docx-editor";

type SnapshotCapableDocxEditor = Pick<DocxEditorRef, "save">;

type AttachCreateDocumentDraftEditorOptions<
  TEditor extends SnapshotCapableDocxEditor,
> = {
  editor: TEditor;
  editorRef: RefObject<TEditor | null>;
  toolCallId: string;
};

/**
 * Tie snapshot capture to the editor ref lifecycle. React runs a callback-ref
 * cleanup before detaching the imperative handle, while passive effect cleanup
 * runs after it has already become null.
 */
export const attachCreateDocumentDraftEditor = <
  TEditor extends SnapshotCapableDocxEditor,
>({
  editor,
  editorRef,
  toolCallId,
}: AttachCreateDocumentDraftEditorOptions<TEditor>): (() => void) => {
  editorRef.current = editor;
  const unregisterSaver = registerCreateDocumentDraftSaver(
    toolCallId,
    async () => await editor.save({ selective: false }),
  );

  return () => {
    unregisterSaver();
    if (editorRef.current === editor) {
      editorRef.current = null;
    }
  };
};
