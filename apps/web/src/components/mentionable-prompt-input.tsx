import "./chat-editor.css";

import { useCallback, useEffect, useMemo, useRef } from "react";
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
  MENTION_HASH_PREFIX,
  type ChatMentionOption,
  type MentionCategory,
} from "@/components/chat-mention-extension";
import { useMentionProviders } from "@/components/chat-mention-providers";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import {
  getEntityName,
  getFirstFile,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

/** Serialize TipTap content to plain text with
 *  references as markdown links the model can parse. */
const serializeToText = (editor: Editor): string => {
  const parts: string[] = [];

  editor.state.doc.descendants((node) => {
    if (node.isText && node.text) {
      parts.push(node.text);
      return false;
    }

    if (node.type.name === "mention") {
      const { id, label, category = "entity", sourceWorkspaceId } = node.attrs;
      const prefix =
        MENTION_HASH_PREFIX[category as MentionCategory] ??
        MENTION_HASH_PREFIX.entity;
      // Encode workspace context for cross-workspace entities
      const encodedId =
        category === "entity" && sourceWorkspaceId
          ? `${sourceWorkspaceId}:${id}`
          : id;
      parts.push(`[${label}](${prefix}${encodedId})`);
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

export type MentionContext = {
  /** When set, entity mentions from this workspace are available. */
  workspaceId?: string;
  /** Additional mention categories beyond entities. */
  categories?: MentionCategory[];
};

type MentionSourceProvider = () => ChatMentionOption[];

type ChatEditorProps = {
  mentionContext?: MentionContext;
  className?: string;
  onSubmit: (text: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Ref populated with a submit function so the parent can
   *  trigger submit externally (e.g., from a send button). */
  submitRef?: React.MutableRefObject<(() => void) | null>;
  /** Called when the editor transitions between empty and
   *  non-empty. Useful for showing/hiding a send button. */
  onEmptyChange?: (isEmpty: boolean) => void;
  /** Ref populated with the TipTap editor instance so the
   *  parent can programmatically insert content. */
  editorRef?: React.MutableRefObject<Editor | null>;
  /** @deprecated Use mentionContext instead. */
  workspaceId?: string;
};

export const ChatEditor = ({
  mentionContext,
  workspaceId: legacyWorkspaceId,
  className,
  onSubmit,
  placeholder,
  autoFocus,
  submitRef,
  onEmptyChange,
  editorRef,
}: ChatEditorProps) => {
  const t = useTranslations();
  const resolvedPlaceholder = placeholder ?? t("chat.placeholder");

  // Support both legacy workspaceId and new mentionContext
  const ctx: MentionContext | undefined =
    mentionContext ??
    (legacyWorkspaceId ? { workspaceId: legacyWorkspaceId } : undefined);

  const wsId = ctx?.workspaceId;
  const categories = ctx?.categories ?? [];
  const hasMentions = !!wsId || categories.length > 0;

  const allEntities = useWorkspaceStore(
    useShallow((s) => (wsId ? s.data : [])),
  );

  const mentionProviders = useMentionProviders();

  // Build the items list. Updated whenever store or providers
  // change, but consumed via a ref so TipTap's suggestion
  // plugin always reads the latest data without needing the
  // editor to fully recreate.
  const getItems: MentionSourceProvider = useMemo(() => {
    return () => {
      const items: ChatMentionOption[] = [];

      // Entity mentions from current workspace
      if (wsId) {
        for (const entity of allEntities) {
          const file = getFirstFile(entity);
          items.push({
            id: entity.entityId,
            label: getEntityName(entity),
            category: "entity",
            kind: entity.kind,
            mimeType: file?.mimeType ?? null,
          });
        }
      }

      // Additional categories from org-level providers
      if (categories.length > 0) {
        const extra = mentionProviders.getItems(categories);
        items.push(...extra);
      }

      return items;
    };
  }, [wsId, allEntities, categories, mentionProviders]);

  // Stable ref so the suggestion plugin always calls the
  // latest getItems without requiring editor recreation.
  const getItemsRef = useRef(getItems);
  getItemsRef.current = getItems;
  const stableGetItems = useCallback(() => getItemsRef.current(), []);

  const extensions = useMemo(
    () => [
      Document,
      Paragraph,
      Text,
      Placeholder.configure({
        placeholder: resolvedPlaceholder,
      }),
      History,
      ...(hasMentions
        ? [
            ChatMention.configure({
              suggestion: createChatSuggestion(stableGetItems),
              deleteTriggerWithBackspace: true,
            }),
          ]
        : []),
    ],
    [hasMentions, resolvedPlaceholder, stableGetItems],
  );

  const onEmptyChangeRef = useRef(onEmptyChange);
  onEmptyChangeRef.current = onEmptyChange;
  const wasEmptyRef = useRef(true);

  const editor = useEditor({
    extensions,
    autofocus: autoFocus ? "end" : false,
    onUpdate: ({ editor: e }) => {
      const isEmpty = e.isEmpty;
      if (isEmpty !== wasEmptyRef.current) {
        wasEmptyRef.current = isEmpty;
        onEmptyChangeRef.current?.(isEmpty);
      }
    },
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

  // Expose a submit function so parent components (e.g. a
  // send button) can trigger submit without keyboard events.
  useEffect(() => {
    if (!submitRef || !editor) {
      return;
    }
    submitRef.current = () => {
      const text = serializeToText(editor);
      if (text) {
        onSubmit(text);
        editor.commands.clearContent();
      }
    };
    return () => {
      submitRef.current = null;
    };
  }, [submitRef, editor, onSubmit]);

  // Expose the editor instance for programmatic content
  // insertion (e.g., inserting a mention from context menu).
  useEffect(() => {
    if (!editorRef) {
      return;
    }
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
    };
  }, [editorRef, editor]);

  return (
    // Stop keyboard events from reaching parent handlers
    // (e.g. workspace table arrow-key navigation).
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: intentional isolation
    // biome-ignore lint/a11y/noStaticElementInteractions: intentional isolation
    <div
      className={cn("chat-editor", className)}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <EditorContent editor={editor} />
    </div>
  );
};
