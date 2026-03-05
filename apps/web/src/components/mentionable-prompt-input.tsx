import "./chat-editor.css";

import { useMemo } from "react";
import Document from "@tiptap/extension-document";
import History from "@tiptap/extension-history";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Text from "@tiptap/extension-text";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { cn } from "@stella/ui/lib/utils";

import {
  ChatMention,
  createChatSuggestion,
} from "@/components/chat-mention-extension";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import {
  getEntityName,
  getFirstFile,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

/** Serialize TipTap content to plain text with entity
 *  references as markdown links the model can parse. */
const serializeToText = (editor: Editor): string => {
  const parts: string[] = [];

  editor.state.doc.descendants((node) => {
    if (node.isText && node.text) {
      parts.push(node.text);
      return false;
    }

    if (node.type.name === "mention") {
      const { id, label } = node.attrs;
      parts.push(`[${label}](#stella-entity=${id})`);
      return false;
    }

    if (node.type.name === "paragraph") {
      if (parts.length > 0) {
        parts.push("\n");
      }
      return true;
    }

    return true;
  });

  return parts.join("").trim();
};

type ChatEditorProps = {
  workspaceId?: string;
  className?: string;
  onSubmit: (text: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
};

export const ChatEditor = ({
  workspaceId,
  className,
  onSubmit,
  placeholder,
  autoFocus,
}: ChatEditorProps) => {
  const t = useTranslations();
  const resolvedPlaceholder = placeholder ?? t("chat.placeholder");

  const allEntities = useWorkspaceStore(
    useShallow((s) => (workspaceId ? s.data : [])),
  );

  const extensions = useMemo(
    () => [
      Document,
      Paragraph,
      Text,
      Placeholder.configure({ placeholder: resolvedPlaceholder }),
      History,
      ...(workspaceId
        ? [
            ChatMention.configure({
              suggestion: createChatSuggestion(() => {
                return allEntities.map((entity) => {
                  const file = getFirstFile(entity);
                  return {
                    id: entity.entityId,
                    label: getEntityName(entity),
                    kind: entity.kind,
                    mimeType: file?.mimeType ?? null,
                  };
                });
              }),
              deleteTriggerWithBackspace: true,
            }),
          ]
        : []),
    ],
    [workspaceId, resolvedPlaceholder, allEntities],
  );

  const editor = useEditor({
    extensions,
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: {
        class: cn(
          "field-sizing-content max-h-48 min-h-10",
          "overflow-y-auto text-sm text-foreground",
          "focus-visible:outline-none",
        ),
      },
      handleKeyDown: (view, event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          // Don't submit if the mention suggestion is open.
          // TipTap's suggestion plugin handles Enter itself.
          const { state } = view;
          const mentionPluginActive = state.plugins.some((plugin) => {
            const meta = plugin.getState(state);
            return (
              meta &&
              typeof meta === "object" &&
              "active" in meta &&
              meta.active
            );
          });
          if (mentionPluginActive) {
            return false;
          }

          event.preventDefault();

          const text = serializeToText(editor);
          if (text) {
            onSubmit(text);
            editor.commands.clearContent();
          }
          return true;
        }
        return false;
      },
    },
  });

  return (
    <div className={cn("chat-editor", className)}>
      <EditorContent editor={editor} />
    </div>
  );
};
