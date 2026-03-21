import "./chat-editor.css";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useQuery } from "@tanstack/react-query";
import Document from "@tiptap/extension-document";
import History from "@tiptap/extension-history";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Text from "@tiptap/extension-text";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

import {
  ChatMention,
  createChatSuggestion,
  MENTION_HASH_PREFIX,
} from "@/components/chat-mention-extension";
import type {
  ChatMentionOption,
  MentionCategory,
} from "@/components/chat-mention-extension";
import { useMentionProviders } from "@/components/chat-mention-providers";
import { entitiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import {
  getEntityName,
  getFirstFile,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const isMentionCat = (v: unknown): v is MentionCategory =>
  typeof v === "string" && v in MENTION_HASH_PREFIX;

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
      const prefix = isMentionCat(category)
        ? MENTION_HASH_PREFIX[category]
        : MENTION_HASH_PREFIX.entity;
      // TODO: FIXME — type node.attrs properly
      // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
      const encodedId =
        category === "entity" &&
        sourceWorkspaceId !== undefined &&
        sourceWorkspaceId !== null
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
  submitRef?: React.RefObject<(() => void) | null>;
  /** Called when the editor transitions between empty and
   *  non-empty. Useful for showing/hiding a send button. */
  onEmptyChange?: (isEmpty: boolean) => void;
  /** Ref populated with the TipTap editor instance so the
   *  parent can programmatically insert content. */
  editorRef?: React.RefObject<Editor | null>;
};

export const ChatEditor = ({
  mentionContext,
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

  const wsId = mentionContext?.workspaceId;
  const categories = mentionContext?.categories ?? [];
  const hasMentions = !!wsId || categories.length > 0;

  const { data: entitiesData } = useQuery({
    ...entitiesOptions({
      workspaceId: wsId ?? "",
      filters: [],
      sorts: [],
      page: 1,
    }),
    enabled: !!wsId,
  });
  const allEntities = entitiesData?.entities ?? [];
  const mentionProviders = useMentionProviders();

  // Build the items list. Updated whenever store or providers
  // change, but consumed via a ref so TipTap's suggestion
  // plugin always reads the latest data without needing the
  // editor to fully recreate.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const getItems: MentionSourceProvider = useMemo(
    () => () => {
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
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- categories is intentionally not memoized
    [wsId, allEntities, categories, mentionProviders],
  );

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
          "text-foreground overflow-y-auto text-sm",
          "focus-visible:outline-none",
        ),
      },
      handleKeyDown: (view, event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          // Don't submit if the mention suggestion is open.
          // TipTap's suggestion plugin handles Enter itself.
          const { state } = view;
          const mentionPluginActive = state.plugins.some((plugin) => {
            // TODO: FIXME — plugin.getState returns any
            // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
            const meta = plugin.getState(state);
            return (
              meta !== undefined &&
              meta !== null &&
              typeof meta === "object" &&
              "active" in meta &&
              // SAFETY: validated shape above; plugin state has active: boolean
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              (meta as { active: boolean }).active
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
    if (
      submitRef === undefined ||
      submitRef === null ||
      editor === undefined ||
      editor === null
    ) {
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
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-static-element-interactions
    <div
      className={cn("chat-editor", className)}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <EditorContent editor={editor} />
    </div>
  );
};
