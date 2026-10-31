import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { decisionPassageContent } from "@/components/chat-decision-passage";
import {
  insertCredentialPasteRequest,
  readChatPaste,
} from "@/components/chat-editor-paste.logic";
import { useLatestCallback } from "@/hooks/use-latest-callback";

/** What an editor that writes a chat message does with the pastes it keeps
 *  apart from its text. */
export type ChatComposerPasteOptions = {
  /** A paste long enough to travel as a pasted-text attachment. */
  onChip: (text: string) => void;
  /** A paste that looks like a credential; it is not inserted. */
  onCredential: (editor: Editor) => void;
};

const chatComposerPasteKey = new PluginKey("chatComposerPaste");

/**
 * Every paste into a chat message, owned in one place: clipboard HTML never
 * reaches the editor's own parser, lines become line breaks, a cited
 * decision passage becomes its reference, and a long paste or a credential
 * goes to the editor's own handler.
 */
export const ChatComposerPaste = Extension.create<ChatComposerPasteOptions>({
  name: "chatComposerPaste",
  addOptions() {
    return {
      onChip: () => panic("A chat editor must handle a long paste"),
      onCredential: () => panic("A chat editor must handle a credential"),
    };
  },
  addProseMirrorPlugins() {
    const { editor, options } = this;
    return [
      new Plugin({
        key: chatComposerPasteKey,
        props: {
          handlePaste: (_view, event) => {
            // File uploads still bubble to the React handler on the input
            // surface; nothing else reaches the editor's default parser.
            event.preventDefault();
            const paste = readChatPaste(event.clipboardData);
            switch (paste.type) {
              case "ignore":
              case "files":
                return true;
              case "decision":
                editor.commands.insertContent(
                  decisionPassageContent(paste.passage),
                );
                return true;
              case "chip":
                options.onChip(paste.text);
                return true;
              case "credential":
                options.onCredential(editor);
                return true;
              case "text":
                editor.commands.insertContent(paste.content, {
                  applyInputRules: false,
                  applyPasteRules: false,
                });
                return true;
              default:
                paste satisfies never;
                return panic("Unhandled chat paste");
            }
          },
        },
      }),
    ];
  },
});

/**
 * The warning every chat editor shows for a pasted credential, as a stable
 * callback for `ChatComposerPasteOptions.onCredential`; its action asks for
 * the value privately instead.
 */
export const useCredentialPasteNotice = (): ((editor: Editor) => void) => {
  const t = useTranslations();
  return useLatestCallback((editor: Editor) => {
    stellaToast.warning(t("chat.credentialPasteTitle"), {
      description: t("chat.credentialPasteDescription"),
      action: {
        label: t("chat.credentialPasteAction"),
        onClick: () => {
          insertCredentialPasteRequest(
            editor,
            t("chat.credentialPasteRequest"),
          );
        },
      },
    });
  });
};
