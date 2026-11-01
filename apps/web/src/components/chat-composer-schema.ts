import type { Editor } from "@tiptap/core";
import Bold from "@tiptap/extension-bold";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";

import { ChatComposerPaste } from "@/components/chat-composer-paste";
import type { ChatComposerPasteOptions } from "@/components/chat-composer-paste";
import { ChatMention } from "@/components/chat-mention-extension";
import { PastedText } from "@/components/chat-pasted-text-extension";
import { createPromptEditorDocument } from "@/components/prompt-editor.logic";

/**
 * The content the chat composer can hold: paragraphs, line breaks, bold text,
 * reference chips and pasted-text chips (a skill chip among them), and the
 * one paste pipeline that writes into it. Every editor that writes a chat
 * message builds from these, so a message edited after sending is the same
 * kind of document as a new one, takes a paste the same way, and serializes
 * the same way. `paste` says what the editor does with a long paste and a
 * credential.
 */
export const createChatComposerSchemaExtensions = (
  paste: ChatComposerPasteOptions,
) => [
  createPromptEditorDocument(),
  Paragraph,
  Text,
  Bold,
  // Enter sends the message; Shift+Enter adds a line break (a hard break)
  // instead of splitting the paragraph. Chained with `scrollIntoView()` so
  // adding a new line at the bottom of an overflowed input keeps the cursor
  // in view (ProseMirror's auto-scroll only fires on selection changes that
  // already include the flag — `setHardBreak` alone doesn't).
  HardBreak.extend({
    addKeyboardShortcuts() {
      return {
        "Shift-Enter": () =>
          this.editor.chain().setHardBreak().scrollIntoView().run(),
      };
    },
  }),
  ChatMention.configure({ deleteTriggerWithBackspace: true }),
  PastedText,
  ChatComposerPaste.configure(paste),
];

/** The markup a composer sends for its document; empty when it holds nothing. */
export const chatComposerHtml = (
  editor: Pick<Editor, "getHTML" | "isEmpty">,
) => (editor.isEmpty ? "" : editor.getHTML().trim());
