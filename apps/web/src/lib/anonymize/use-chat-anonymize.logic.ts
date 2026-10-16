import type { Editor } from "@tiptap/react";

/** Plain text of the editor, or "" once TipTap has torn it down. */
export const readChatDraftText = (
  editor: Pick<Editor, "getText" | "isDestroyed">,
): string => (editor.isDestroyed ? "" : editor.getText());
